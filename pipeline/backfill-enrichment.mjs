/* Backfill enrichment onto already-collected indices.
 *
 * Seven of eleven indices were collected before enrichment existed, so 79
 * businesses carry none. Re-collecting them would fix that and simultaneously
 * re-measure six pillars, making any score movement unattributable — the same
 * trap avoided when the credentials check was corrected.
 *
 * Enrichment is not scored, so adding it cannot change a single ranking. This
 * writes only record.enrichment and never touches record.pillars.
 *
 *   node backfill-enrichment.mjs                 # published indices, free sources only
 *   node backfill-enrichment.mjs --with-paid     # adds GBP detail and backlinks
 *   node backfill-enrichment.mjs <slug> [...]    # limit to named indices
 *   node backfill-enrichment.mjs --force         # redo work already present
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crawlSite } from './lib/crawl.mjs';
import { collectCrux, collectCompaniesHouse, collectFsa, collectLighthouse } from './lib/enrich.mjs';
import { businessListings, backlinkSummary, loadEnv, ledger } from './lib/dataforseo.mjs';
import { registrableDomain } from './lib/match.mjs';

loadEnv();
const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const WITH_PAID = argv.includes('--with-paid');
const FORCE = argv.includes('--force');
const only = argv.filter((a) => !a.startsWith('--'));

const indices = JSON.parse(await readFile(join(HERE, 'config', 'indices.json'), 'utf8'));
const sectors = JSON.parse(await readFile(join(HERE, 'config', 'sectors.json'), 'utf8'));
/* Published indices by default, because --with-paid buys a businessListings
   sweep per index. The old filter was "every configured index", which was
   harmless only while data/ contained nothing but published cohorts — and the
   documented way to publish a new index is to collect it first, which breaks
   exactly that assumption. Name slugs explicitly to reach an unpublished one. */
const slugs = Object.keys(indices)
	.filter((k) => !k.startsWith('_'))
	.filter((k) => (only.length ? only.includes(k) : indices[k]?.publish === true));

let done = 0, skipped = 0;

for (const slug of slugs) {
	const cfg = indices[slug];
	const sectorCfg = sectors[cfg.sector] || null;
	const dir = join(HERE, 'data', slug);
	let files;
	try { files = (await readdir(dir)).filter((f) => !f.startsWith('_') && f.endsWith('.json')); }
	catch { console.log(`  ${slug.padEnd(26)} not collected — skipped`); continue; }
	if (!files.length) continue;

	/* One area sweep per index rather than one lookup per business: the call is
	   priced flat, so 11 sweeps cost what 11 lookups would and cover everyone. */
	let listings = new Map();
	if (WITH_PAID && cfg.coordinate && sectorCfg?.dfsCategories?.length) {
		try {
			const { items } = await businessListings(sectorCfg.dfsCategories, cfg.coordinate, { limit: 100 });
			for (const it of items) {
				const d = it.url ? registrableDomain(it.url) : null;
				if (d) listings.set(d, it);
			}
		} catch (e) { console.log(`    listings sweep failed: ${e.message}`); }
	}

	console.log(`\n  ${slug}  (${files.length} businesses)`);

	for (const f of files) {
		const path = join(dir, f);
		const rec = JSON.parse(await readFile(path, 'utf8'));
		rec.enrichment = rec.enrichment || {};
		const e = rec.enrichment;
		const need = (k) => FORCE || !e[k];

		if (need('crawl')) e.crawl = await crawlSite(rec.url, { maxPages: 25, maxDepth: 2, totalBudgetMs: 60000 });
		if (need('crux')) e.crux = await collectCrux(rec.url);
		if (need('companies') || e.companies?.accountsType === undefined) {
			e.companies = await collectCompaniesHouse(rec.name, { town: cfg.town ?? null });
		}
		if (need('lighthouse')) e.lighthouse = await collectLighthouse(rec.url);
		if (sectorCfg?.fsaRated && need('fsa')) {
			e.fsa = await collectFsa(rec.name, { town: cfg.town ?? null, coordinate: cfg.coordinate ?? null });
		}

		if (WITH_PAID) {
			/* Google profile detail the pillar computes over and discards:
			   photo count, the star distribution behind an average, attributes,
			   opening hours, services. */
			const dom = registrableDomain(rec.url);
			const it = dom ? listings.get(dom) : null;
			if (it && need('gbpDetail')) {
				e.gbpDetail = {
					source: 'DataForSEO business_listings (area sweep)',
					totalPhotos: it.total_photos ?? null,
					ratingDistribution: it.rating_distribution ?? null,
					priceLevel: it.price_level ?? null,
					isClaimed: typeof it.is_claimed === 'boolean' ? it.is_claimed : null,
					additionalCategories: it.additional_categories ?? null,
					hasDescription: !!it.description,
					hasHours: !!it.work_time?.work_hours?.timetable,
					services: Array.isArray(it.services) ? it.services.length : null,
					placeTopics: it.place_topics ?? null,
					firstSeen: it.first_seen ?? null,
					lastUpdated: it.last_updated_time ?? null,
				};
			}
			if (need('backlinks') && dom) {
				try { e.backlinks = { source: 'DataForSEO backlinks/summary', ...(await backlinkSummary(dom)) }; }
				catch (err) { e.backlinks = { error: String(err?.message || err) }; }
			}
		}

		await writeFile(path, JSON.stringify(rec, null, 2) + '\n');
		done++;
		const bits = [
			e.crawl?.pagesCrawled ? `crawl ${e.crawl.pagesCrawled}p` : 'crawl —',
			e.crux?.available ? 'crux' : 'crux —',
			e.companies?.matched ? 'ch' : 'ch —',
			e.lighthouse?.performance != null ? `lh ${e.lighthouse.performance}` : 'lh —',
			WITH_PAID ? (e.backlinks?.referringDomains != null ? `rd ${e.backlinks.referringDomains}` : 'rd —') : '',
		].filter(Boolean);
		console.log(`    ${rec.name.slice(0, 34).padEnd(36)}${bits.join('  ')}`);
	}
}

console.log(`\n${done} businesses enriched, ${skipped} skipped.`);
console.log(`Spend this run: $${ledger.total.toFixed(4)}`);
console.log('Enrichment is unscored, so no ranking changes. Regenerate to publish it.');
