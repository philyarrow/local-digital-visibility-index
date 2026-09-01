/* discover.mjs — build a seed list for a new index from real Google listings.
 *
 * Adding an index needs a seed CSV of real businesses with real websites.
 * Those must never be invented: a fabricated row would put a scored, published
 * league-table entry against a business that does not exist, or worse, against
 * the wrong website. So the list comes from the Google Business listings API
 * and is written for a human to review before anything is collected.
 *
 * This writes a seed file and nothing else. It does not touch config/indices.json
 * — an index only becomes real once someone has read the seed list and added
 * the entry deliberately.
 *
 * A registry entry alone does not put an index into circulation: the scheduled
 * workflow, regenerate-all.sh and both backfills act on publish:true only, so a
 * new entry is inert until a person sets that flag. Collect it by naming the
 * slug explicitly, review what comes back, then set publish:true in the commit
 * that ships its pages.
 *
 * Usage:
 *   node discover.mjs <sector> <town> <lat,lng,radius> [--limit 100] [--dry-run]
 *   node discover.mjs accountants Gloucester 51.8642,-2.2380,12
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { businessListings, loadEnv, ledger } from './lib/dataforseo.mjs';
import { registrableDomain } from './lib/match.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/* Directories, marketplaces and review sites rank for local queries but are not
   local businesses. Seeding one would score a national aggregator against local
   firms and make the whole cohort meaningless. */
const NOT_A_LOCAL_BUSINESS = [
	'yell.com', 'checkatrade.com', 'trustpilot.com', 'facebook.com', 'yelp.com',
	'thomsonlocal.com', 'freeindex.co.uk', 'bark.com', 'mybuilder.com', 'ratedpeople.com',
	'which.co.uk', 'tripadvisor.co.uk', 'tripadvisor.com', 'opentable.co.uk',
	'rightmove.co.uk', 'zoopla.co.uk', 'onthemarket.com', 'primelocation.com',
	'nhs.uk', 'gov.uk', 'cqc.org.uk', 'google.com', 'booking.com', 'justeat.co.uk',
	'deliveroo.co.uk', 'ubereats.com', 'indeed.com', 'linkedin.com', 'instagram.com',
];

/* National chains and housebuilders. A branch of a chain has a page on the
   chain's site, not a site of its own — scoring it measures the chain's central
   web team, not a local business, and it would beat every independent in the
   cohort on signals the branch does not control. The same rule that excludes a
   franchise landing page excludes these.

   Restaurants are where this matters most: an unfiltered Gloucester restaurant
   sweep returned ten chain location pages in the top of the list. */
const NATIONAL_CHAIN = [
	// pub and restaurant groups
	'tobycarvery.co.uk', 'vintageinn.co.uk', 'chefandbrewer.com', 'emberinns.co.uk',
	'zizzi.co.uk', 'tgifridays.co.uk', 'pizzaexpress.com', 'nandos.co.uk', 'wagamama.com',
	'greeneking-pubs.co.uk', 'marstons.co.uk', 'harvester.co.uk', 'millerandcarter.co.uk',
	'beefeater.co.uk', 'brewersfayre.co.uk', 'premierinn.com', 'mcdonalds.com', 'kfc.co.uk',
	'subway.com', 'costa.co.uk', 'starbucks.co.uk', 'greggs.co.uk', 'wetherspoon.co.uk',
	// hotel groups: a branch restaurant lives on the group's site, and the
	// Gloucester sweep pulled in a Cheltenham Ramada through exactly this
	'wyndhamhotels.com', 'ihg.com', 'accor.com', 'hilton.com', 'marriott.com',
	'travelodge.co.uk', 'britanniahotels.com', 'bestwestern.co.uk',
	// national housebuilders
	'redrow.co.uk', 'barratthomes.co.uk', 'bloorhomes.com', 'persimmonhomes.com',
	'taylorwimpey.co.uk', 'bellway.co.uk', 'davidwilsonhomes.co.uk', 'cala.co.uk',
	'crest-nicholson.com', 'vistry.co.uk', 'lovell.co.uk',
	// veterinary groups. The profession has consolidated hard: a Cheltenham
	// discovery sweep returned 5 corporate branches in 25 listings — Vets4Pets,
	// Medivet twice, Vets Now and CVS. Their websites are group sites, so
	// scoring one measures a national web team against local independents,
	// which is the same error that put three Cheltenham restaurants into the
	// Gloucester index. The consolidation is worth writing about; it is not
	// worth ranking a branch page for.
	'vets4pets.com', 'medivet.co.uk', 'medivetgroup.com', 'vets-now.com',
	'cvsvets.com', 'petsathome.com', 'independentvetcare.co.uk',
	'ivcevidensia.co.uk', 'whitecrossvets.co.uk', 'goddardvetgroup.co.uk',
	'linnaeusgroup.co.uk', 'vetpartners.co.uk',
	// healthcare groups, for the physiotherapy and clinic sectors
	'nuffieldhealth.com', 'bupa.co.uk', 'spirehealthcare.com', 'circlehealthgroup.co.uk',
	'vitahealthgroup.co.uk', 'connecthealth.co.uk',
	// nursery and childcare groups, for the schools sector
	'brighthorizons.co.uk', 'busybeeschildcare.co.uk', 'kidsplanetdaynurseries.co.uk',
	'nfamilyclub.com', 'monkeypuzzledaynurseries.com',
	// funeral groups, retained though the sector was dropped for cohort size
	'dignityfunerals.co.uk', 'funeralcare.co.uk',
];

function csvCell(s) {
	const v = String(s ?? '').replace(/\r?\n/g, ' ').trim();
	return /[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function parseArgs(argv) {
	const a = argv.slice(2);
	const out = { sector: null, town: null, coordinate: null, limit: 100, dryRun: false };
	const positional = [];
	for (let i = 0; i < a.length; i++) {
		if (a[i] === '--limit') { out.limit = Number(a[++i]); continue; }
		if (a[i] === '--dry-run') { out.dryRun = true; continue; }
		if (a[i].startsWith('--')) { console.error(`Unknown flag: ${a[i]}`); process.exit(1); }
		positional.push(a[i]);
	}
	[out.sector, out.town, out.coordinate] = positional;
	return out;
}

async function main() {
	loadEnv();
	const { sector: sectorKey, town, coordinate, limit, dryRun } = parseArgs(process.argv);

	if (!sectorKey || !town || !coordinate) {
		console.error('Usage: node discover.mjs <sector> <town> <lat,lng,radiusKm> [--limit 100] [--dry-run]');
		console.error('  e.g. node discover.mjs accountants Gloucester 51.8642,-2.2380,12');
		process.exit(1);
	}

	const sectors = JSON.parse(await readFile(join(HERE, 'config', 'sectors.json'), 'utf8'));
	const sector = sectors[sectorKey];
	if (!sector) {
		console.error(`Unknown sector "${sectorKey}". Known: ${Object.keys(sectors).filter((k) => !k.startsWith('_')).join(', ')}`);
		process.exit(1);
	}

	/* CAREFUL: this repo has two coordinate conventions that look identical.
	   business_data/business_listings/search takes "lat,lng,radiusKM" — the
	   value stored in config/indices.json, e.g. "51.4545,-2.5879,12".
	   The SERP geo-grid endpoint takes "lat,lng,radiusMETRES" (199–199999).
	   Passing a metres value here silently searches the planet: 8000 was read
	   as 8000km and returned accountants in Lyon, Jerusalem and Ostroleka. */
	const parts = coordinate.split(',');
	const radius = Number(parts[2]);
	if (parts.length !== 3 || !Number.isFinite(radius) || radius < 1 || radius > 100) {
		console.error(`Bad coordinate "${coordinate}" — expected "lat,lng,radiusKM" with radius 1–100.`);
		console.error('Note: the geo-grid endpoint uses METRES; this one uses KILOMETRES.');
		process.exit(1);
	}

	const slug = `${town.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${sectorKey}`;
	console.log(`Sector:     ${sector.label}`);
	console.log(`Town:       ${town}`);
	console.log(`Categories: ${sector.dfsCategories.join(', ')}`);
	console.log(`Radius:     ${radius}km`);
	console.log(`Seed file:  seeds/${slug}.csv\n`);

	if (dryRun) {
		console.log('--dry-run: nothing was fetched and nothing was charged.');
		return;
	}

	const { items, totalCount, returned } = await businessListings(sector.dfsCategories, coordinate, { limit });
	console.log(`Listings returned ${returned} of ${totalCount ?? '?'} in the area.\n`);

	const seen = new Set();
	const rows = [];
	const rejected = { noSite: 0, aggregator: 0, chain: 0, duplicateDomain: 0 };

	for (const it of items) {
		const name = it.title;
		const url = it.url;
		if (!name) continue;
		if (!url) { rejected.noSite++; continue; }

		const domain = registrableDomain(url);
		if (!domain) { rejected.noSite++; continue; }
		if (NOT_A_LOCAL_BUSINESS.some((d) => domain === d || domain.endsWith(`.${d}`))) { rejected.aggregator++; continue; }
		if (NATIONAL_CHAIN.some((d) => domain === d || domain.endsWith(`.${d}`))) { rejected.chain++; continue; }
		if (seen.has(domain)) { rejected.duplicateDomain++; continue; }
		seen.add(domain);

		rows.push({ name, url, gbpQuery: `${name} ${sector.singular} ${town}`, rating: it.rating?.value ?? '', reviews: it.rating?.votes_count ?? '' });
	}

	rows.sort((a, b) => (Number(b.reviews) || 0) - (Number(a.reviews) || 0));

	const csv = ['name,url,gbp_query']
		.concat(rows.map((r) => [r.name, r.url, r.gbpQuery].map(csvCell).join(',')))
		.join('\n') + '\n';

	await mkdir(join(HERE, 'seeds'), { recursive: true });
	const path = join(HERE, 'seeds', `${slug}.csv`);
	await writeFile(path, csv);

	console.log(`Kept ${rows.length} businesses with their own website.`);
	console.log(`  no website / unparseable  ${rejected.noSite}`);
	console.log(`  directory or marketplace  ${rejected.aggregator}`);
	console.log(`  national chain / builder  ${rejected.chain}`);
	console.log(`  duplicate domain (chains) ${rejected.duplicateDomain}\n`);

	rows.slice(0, 15).forEach((r, i) => {
		console.log(`  ${String(i + 1).padStart(2)}. ${r.name}  —  ${r.url}${r.reviews ? `  (${r.reviews} reviews)` : ''}`);
	});
	if (rows.length > 15) console.log(`  ... and ${rows.length - 15} more`);

	console.log(`\nSpend: $${ledger.total.toFixed(5)}`);
	console.log(`\nWrote seeds/${slug}.csv`);
	console.log('REVIEW IT before adding an entry to config/indices.json — every row becomes a');
	console.log('published, scored league-table entry for a real business.');
}

main().catch((e) => { console.error(e); process.exit(1); });
