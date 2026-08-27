/* generate.mjs — Local Digital Visibility Index generator.

   Reads pipeline/data/<index-slug>/_ranked.json and produces, inside the SITE
   repository (a separate checkout — see --site-root):
     (a) the index hub MDX + one scorecard MDX per business under
         new/src/content/docs/indices/<index-slug>/
     (b) machine-readable exports:
         new/public/data/<index-slug>.json
         new/public/data/<index-slug>.csv

   Usage:
     node generate.mjs <index-slug> --quarter Q3-2026 --site-root ../../hub.philyarrow.co.uk

   This pipeline is canonical in local-digital-visibility-index; the site that
   publishes it is a separate repo. generate.mjs is the one step that reaches
   across that boundary, so the destination is explicit rather than inferred.

   Conventions matched:
     - Starlight frontmatter (title, description, date, lastUpdated, wpType)
       per new/src/content/docs/indices/methodology.md
     - Deep-scorecard format per §4 of LOCAL-INDEX-STRATEGY.md and the
       methodology page.
     - GEO layer: Dataset + ItemList JSON-LD, quotable stat sentences,
       question-shaped H2s, JSON/CSV exports.
*/

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PILLARS, toCsv } from './lib/common.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = join(HERE, 'data');
const SITE = 'https://hub.pyc.agency';

/* The site lives in a separate repository, so its location is passed in rather
   than inferred from this file's path. Nothing is written outside this root. */
function resolveSiteRoot() {
	const flagIndex = process.argv.indexOf('--site-root');
	const fromFlag = flagIndex !== -1 ? process.argv[flagIndex + 1] : null;
	const root = fromFlag || process.env.INDEX_SITE_ROOT;
	if (!root) {
		console.error(
			'Missing --site-root.\n\n' +
			'generate.mjs writes Astro content into the site repo, which is a separate\n' +
			'checkout from this pipeline. Point it at that checkout:\n\n' +
			'  node generate.mjs <index-slug> --quarter Q3-2026 --site-root ../../hub.philyarrow.co.uk\n' +
			'  INDEX_SITE_ROOT=../../hub.philyarrow.co.uk node generate.mjs <index-slug> --quarter Q3-2026\n'
		);
		process.exit(1);
	}
	return isAbsolute(root) ? root : resolve(process.cwd(), root);
}

const SITE_ROOT = resolveSiteRoot();
const CONTENT_ROOT = join(SITE_ROOT, 'new', 'src', 'content', 'docs', 'indices');
const PUBLIC_DATA = join(SITE_ROOT, 'new', 'public', 'data');

/* Dated open-data snapshots live in THIS repo, not the site's. */
const SNAPSHOT_ROOT = join(HERE, '..', 'data');

/* ---- frontmatter / formatting helpers ---- */

const yamlStr = (s) => `"${String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
	'July', 'August', 'September', 'October', 'November', 'December'];
function humanDate(iso) {
	const d = new Date(iso);
	return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function sectorLabel(indexSlug) {
	return indexSlug.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

function indexTitle(indexSlug) {
	// bristol-estate-agents -> "Bristol Estate Agent"
	const words = indexSlug.split('-');
	const city = words[0][0].toUpperCase() + words[0].slice(1);
	const sector = words.slice(1).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ').replace(/s$/, '');
	return `${city} ${sector}`;
}

function reading(pillarKey, b, medians) {
	const score = b.pillarScores[pillarKey];
	if (score === null) return 'Not measured this quarter';
	const med = medians[pillarKey];
	if (med === null) return `${score}/100`;
	if (score >= med + 5) return `Above sector median`;
	if (score <= med - 5) return `Below sector median`;
	return `At sector median`;
}

/* ---- pillar coverage (transparency for partial releases) ---- */

/* Two different states, previously conflated:

     missing    — the pillar has NO data for anyone (source not wired)
     incomplete — the pillar has data for some firms but not all

   `live` was `scored > 0`, so a single measured business made a pillar live
   index-wide and the partial-score banner vanished — while firms with gaps
   still had their weights renormalised, quietly ranking them above firms
   measured on everything. Missing data must never be silently advantageous. */
function coverage(ranked) {
	const cov = (key) => ranked.pillarCoverage?.[key] || { scored: 0, total: 0 };
	const live = PILLARS.filter((p) => cov(p.key).scored > 0);
	const missing = PILLARS.filter((p) => cov(p.key).scored === 0);
	const incomplete = PILLARS.filter((p) => {
		const c = cov(p.key);
		return c.scored > 0 && c.scored < c.total;
	});

	const affected = ranked.businesses.filter((b) => (b.excludedPillars || []).length > 0);

	return {
		partial: missing.length > 0,
		incomplete,
		incompleteLabels: incomplete.map((p) => `${p.label} (${cov(p.key).scored} of ${cov(p.key).total})`),
		affectedCount: affected.length,
		affectedNames: affected.map((b) => b.name),
		live,
		missing,
		liveLabels: live.map((p) => p.label),
		missingLabels: missing.map((p) => p.label),
		// Weight line only means anything when the gap is index-wide.
		weightLine: missing.length
			? live.map((p) => `${p.label} ${Math.round((ranked.weights?.[p.key] ?? 0) / live.reduce((s, x) => s + (ranked.weights?.[x.key] ?? 0), 0) * 100)}%`).join(', ')
			: null,
	};
}

function hubBanner(cov, quarter) {
	if (cov.partial) {
		return `:::caution[v0 — ${cov.live.length} of ${PILLARS.length} pillars measured (${quarter})]
This release scores only **${cov.liveLabels.join(' + ')}**. ${cov.missingLabels.join(', ')} are **not yet measured** and are excluded from the Digital Visibility Score, with the remaining weights renormalised (${cov.weightLine}). Rankings will change when the remaining pillars are added next refresh. Full detail in the [methodology](/indices/methodology/).
:::

`;
	}

	/* All six pillars have data for someone, but not necessarily for everyone.
	   A firm we could not measure on a pillar has its weights renormalised
	   across the rest — which can lift it above a firm measured on all six.
	   That has to be stated on the page, not left in the dataset. */
	if (cov.incomplete.length) {
		return `:::note[Not every firm could be measured on every pillar (${quarter})]
${cov.affectedCount} of the firms below are missing at least one pillar: ${cov.incompleteLabels.join(', ')}. Where a pillar could not be measured for a firm it is **excluded from that firm's score** and its remaining weights are renormalised, rather than scored zero — so those firms are ranked on less evidence than the rest, and their position should be read with that in mind. Affected: ${cov.affectedNames.join(', ')}. See the [methodology](/indices/methodology/).
:::

`;
	}
	return '';
}

function cardBanner(cov) {
	if (!cov.partial) return '';
	return `:::caution[v0 — partial score]
Measured only on ${cov.liveLabels.join(' + ')}. ${cov.missingLabels.join(', ')} not yet scored; this firm's rank will move when they are added.
:::

`;
}

/* ---- per-business scorecard MDX ---- */

function scorecardMdx(b, ranked, quarter, indexSlug) {
	const idxTitle = indexTitle(indexSlug);
	const date = new Date(ranked.scoredAt).toISOString();
	const human = humanDate(ranked.scoredAt);
	const leader = ranked.businesses.find((x) => x.rank === 1);
	const medians = ranked.sectorMedians;
	const cov = coverage(ranked);

	const pillarRows = PILLARS.map((p) => {
		const score = b.pillarScores[p.key];
		const med = medians[p.key];
		return `| ${p.label} | ${score ?? '—'} | ${med ?? '—'} | ${reading(p.key, b, medians)} |`;
	}).join('\n');

	const dataset = {
		'@context': 'https://schema.org',
		'@type': 'Dataset',
		name: `${b.name} — ${idTitleQuarter(idxTitle, quarter)}`,
		description: `Digital Visibility Score and six-pillar breakdown for ${b.name}, measured ${date} via the PYC ${idxTitle} Digital Visibility Index.`,
		creator: { '@type': 'Organization', name: 'Phil Yarrow Consulting (PYC)', url: SITE },
		dateModified: date,
		isPartOf: { '@type': 'Dataset', name: `PYC ${idxTitle} Digital Visibility Index`, url: `${SITE}/indices/${indexSlug}/` },
		about: { '@type': 'LocalBusiness', name: b.name, url: b.url },
	};

	const fm = [
		'---',
		`title: ${yamlStr(`${b.name} — ${idxTitle} Digital Visibility Score`)}`,
		`description: ${yamlStr(`${b.name} scores ${b.digitalVisibilityScore ?? 'n/a'}/100 on the PYC ${idxTitle} Digital Visibility Index — pillar breakdown, sector comparison, and prioritised fixes. Measured ${quarter}.`)}`,
		`date: ${date}`,
		`lastUpdated: ${date}`,
		'wpType: "page"',
		'sidebar:',
		'  hidden: true',
		'---',
	].join('\n');

	const movement = ''; // QoQ trend filled by the quarterly cron once a prior snapshot exists.

	return `${fm}

**${b.name}** — PYC ${idxTitle} Digital Visibility Index, ${quarter}

**Digital Visibility Score: ${b.digitalVisibilityScore ?? 'n/a'} / 100**  ·  Rank ${b.rank ?? '—'} of ${ranked.count}${movement}

${cardBanner(cov)}> Measured ${human} via the PYC ${idxTitle} Digital Visibility Index. Every figure is objective and reproducible from the [methodology](/indices/methodology/). Spotted an error? [Request a correction](mailto:info@philyarrow.co.uk?subject=Correction:%20${encodeURIComponent(b.name)}).

## Pillar breakdown vs sector median

| Pillar | Score | Sector median | Reading |
|--------|------:|--------------:|---------|
${pillarRows}

## Key findings

${keyFindings(b, ranked).map((f) => `- ${f}`).join('\n')}

${leader && leader.slug !== b.slug ? `## How this compares to the leader

${leader.name} leads the index with ${leader.digitalVisibilityScore}/100. ${gapToLeader(b, leader)}
` : ''}

## Top fixes (ranked by impact)

${topFixes(b, sectorCopy(indexSlug)).map((f, i) => `${i + 1}. ${f}`).join('\n')}

---

*How this is measured: see the [index methodology](/indices/methodology/). Want your score improved? [Get in touch](/).*

<script type="application/ld+json">${JSON.stringify(dataset)}</script>
`;
}

function idTitleQuarter(idxTitle, quarter) {
	return `${idxTitle} Digital Visibility Index ${quarter}`;
}

function keyFindings(b, ranked) {
	const out = [];
	for (const p of PILLARS) {
		const score = b.pillarScores[p.key];
		const med = ranked.sectorMedians[p.key];
		if (score === null) continue;
		if (med !== null && score <= med - 10) {
			out.push(`${p.label}: ${score}/100, below the sector median of ${med}.`);
		}
	}
	if (!out.length) out.push('No pillar falls materially below the sector median this quarter.');
	return out.slice(0, 6);
}

function gapToLeader(b, leader) {
	const gaps = [];
	for (const p of PILLARS) {
		const me = b.pillarScores[p.key];
		const them = leader.pillarScores[p.key];
		if (me === null || them === null) continue;
		if (them - me >= 10) gaps.push({ label: p.label, me, them, gap: them - me });
	}
	// "Largest gaps" must actually be the largest, and only the largest few.
	gaps.sort((a, b) => b.gap - a.gap);
	const top = gaps.slice(0, 3).map((g) => `${g.label} (${g.me} vs ${g.them})`);
	return top.length
		? `The largest gaps are: ${top.join('; ')}.`
		: 'The gap to the leader is small and spread evenly across pillars.';
}


/* Per-sector wording for the fix tips. Anything not listed falls back to
   sector-neutral copy rather than borrowing another sector's professional
   bodies. */
const SECTOR_COPY = {
	'estate-agents': { schemaType: 'RealEstateAgent', credentials: 'Propertymark, NAEA, The Property Ombudsman' },
	'solicitors': { schemaType: 'LegalService', credentials: 'SRA, Law Society' },
	'law-firms': { schemaType: 'LegalService', credentials: 'SRA, Law Society' },
	'dentists': { schemaType: 'Dentist', credentials: 'GDC registration, CQC rating' },
	'construction': { schemaType: 'GeneralContractor', credentials: 'FMB, TrustMark, NHBC' },
};

function sectorCopy(indexSlug) {
	for (const key of Object.keys(SECTOR_COPY)) {
		if (indexSlug.endsWith(key)) return SECTOR_COPY[key];
	}
	return { schemaType: null, credentials: null };
}

function topFixes(b, { schemaType = null, credentials = null } = {}) {
	const fixes = [];
	const order = [...PILLARS].sort((a, c) => (b.pillarScores[a.key] ?? 101) - (b.pillarScores[c.key] ?? 101));
	/* Sector-neutral by default. The estate-agent wording that used to be
	   hardcoded here told dental practices to display Propertymark and RICS
	   credentials, and builders to add RealEstateAgent schema. */
	const tips = {
		speed: 'Cut mobile LCP below 2.5s (optimise images and remove render-blocking resources) — the biggest score and ranking lever.',
		technical: `Add valid LocalBusiness${schemaType ? `/${schemaType}` : ''} schema, fix indexability, and ensure a fresh XML sitemap is referenced in robots.txt.`,
		local: 'Restart Google review generation and complete the Business Profile to close the local-pack gap.',
		visibility: 'Build local landing pages for the core keyword basket to lift organic and local-pack appearance.',
		ai: 'Publish structured, citable content and entity schema so AI engines surface the business for core local queries.',
		content: `Add about/team pages${credentials ? ` and the credentials that matter in this sector (${credentials})` : ''}, and refresh stale content.`,
	};
	for (const p of order) {
		if (b.pillarScores[p.key] === null) continue;
		fixes.push(tips[p.key]);
		if (fixes.length === 3) break;
	}
	return fixes.length ? fixes : ['Re-run collection once live data sources are wired.'];
}

/* ---- index hub MDX ---- */

function hubMdx(ranked, quarter, indexSlug) {
	const idxTitle = indexTitle(indexSlug);
	const date = new Date(ranked.scoredAt).toISOString();
	const human = humanDate(ranked.scoredAt);
	const scored = ranked.businesses.filter((b) => b.rank !== null);
	const liveSpeed = ranked.pillarCoverage.speed.live;
	const cov = coverage(ranked);
	const measuredOn = cov.partial
		? cov.liveLabels.join(', ').toLowerCase()
		: 'website speed, technical SEO, local presence, search visibility, AI search presence and content & trust';

	/* Every pillar gets a column. Showing three of six while the hidden three
	   carry half the weight made the published rank unreconcilable from the
	   page — on a site whose premise is that every figure is reproducible. */
	const cell = (v) => (v === null || v === undefined ? '—' : v);
	const tableRows = scored.map((b) =>
		`| ${b.rank} | [${b.name}](/indices/${indexSlug}/${b.slug}/) | ${b.digitalVisibilityScore} | `
		+ PILLARS.map((p) => cell(b.pillarScores[p.key])).join(' | ') + ' |',
	).join('\n');

	const itemList = {
		'@context': 'https://schema.org',
		'@type': 'ItemList',
		name: `PYC ${idxTitle} Digital Visibility Index ${quarter}`,
		itemListOrder: 'https://schema.org/ItemListOrderDescending',
		numberOfItems: scored.length,
		itemListElement: scored.map((b) => ({
			'@type': 'ListItem',
			position: b.rank,
			url: `${SITE}/indices/${indexSlug}/${b.slug}/`,
			name: b.name,
		})),
	};
	const dataset = {
		'@context': 'https://schema.org',
		'@type': 'Dataset',
		name: `PYC ${idxTitle} Digital Visibility Index ${quarter}`,
		description: `League table scoring ${scored.length} ${idxTitle.toLowerCase()}s 0–100 on ${measuredOn}. Measured ${date}.${cov.partial ? ` v0: ${cov.live.length} of ${PILLARS.length} pillars measured.` : ''}`,
		creator: { '@type': 'Organization', name: 'Phil Yarrow Consulting (PYC)', url: SITE },
		dateModified: date,
		distribution: [
			{ '@type': 'DataDownload', encodingFormat: 'application/json', contentUrl: `${SITE}/data/${indexSlug}.json` },
			{ '@type': 'DataDownload', encodingFormat: 'text/csv', contentUrl: `${SITE}/data/${indexSlug}.csv` },
		],
	};

	/* Denominator is firms actually MEASURED on speed. Defaulting an unmeasured
	   firm to 100 counted it as passing and inflated the denominator, so the
	   published percentage understated the problem and implied full coverage. */
	const speedMeasured = scored.filter((b) => typeof b.pillarScores.speed === 'number');
	const failMobile = liveSpeed ? speedMeasured.filter((b) => b.pillarScores.speed < 50).length : null;
	const pct = (failMobile !== null && speedMeasured.length)
		? Math.round((failMobile / speedMeasured.length) * 100) : null;
	const speedDenom = speedMeasured.length;

	const fm = [
		'---',
		`title: ${yamlStr(`${idxTitle} Digital Visibility Index — ${quarter}`)}`,
		`description: ${yamlStr(`PYC's ${idxTitle} Digital Visibility Index for ${quarter}: ${scored.length} firms ranked 0–100 on ${measuredOn}. Every figure dated and reproducible.`)}`,
		`date: ${date}`,
		`lastUpdated: ${date}`,
		'wpType: "page"',
		'---',
	].join('\n');

	return `${fm}

${hubBanner(cov, quarter)}The **PYC ${idxTitle} Digital Visibility Index** ranks ${scored.length} ${idxTitle.toLowerCase()}s on how well they perform online — ${measuredOn} — each scored 0–100 to a single **Digital Visibility Score**. Measured ${human} to the published [methodology](/indices/methodology/).

${pct !== null ? `> As of ${quarter}, ${pct}% of the ${speedDenom} ${idxTitle.toLowerCase()}s measured on Speed & Core Web Vitals score below 50 on mobile (PYC ${idxTitle} Digital Visibility Index, measured ${human}).\n` : ''}
## The league table

| Rank | ${idxTitle} | Score | Speed | Technical | Local | Visibility | AI | Content |
|-----:|-------------|------:|------:|----------:|------:|-----------:|---:|--------:|
${tableRows}

## Which ${idxTitle.toLowerCase()} has the best website?

${scored.length ? `${scored[0].name} tops the ${quarter} index with a Digital Visibility Score of ${scored[0].digitalVisibilityScore}/100.` : ''} Each firm has a full diagnostic scorecard linked from the table above.

## How this is measured

Every score follows the same six-pillar [methodology](/indices/methodology/): Speed & Core Web Vitals (20%), Technical foundation (20%), Local presence (20%), Visibility (15%), AI search presence (15%) and Content & trust (10%).${cov.partial ? ` **This ${quarter} release (v0) measures ${cov.live.length} of those ${PILLARS.length} pillars** — ${cov.liveLabels.join(' and ')} — with weights renormalised to ${cov.weightLine}. The remaining pillars are added in a later refresh.` : ''} Download the full dataset: [JSON](/data/${indexSlug}.json) · [CSV](/data/${indexSlug}.csv).

Spotted an error? [Request a correction](mailto:info@philyarrow.co.uk?subject=Correction:%20${encodeURIComponent(idxTitle)}%20Index).

<script type="application/ld+json">${JSON.stringify(dataset)}</script>
<script type="application/ld+json">${JSON.stringify(itemList)}</script>
`;
}

/* ---- exports ---- */

function exportJson(ranked, quarter, indexSlug) {
	return {
		index: indexSlug,
		title: `PYC ${indexTitle(indexSlug)} Digital Visibility Index`,
		quarter,
		measuredAt: ranked.scoredAt,
		methodology: `${SITE}/indices/methodology/`,
		weights: ranked.weights,
		pillarCoverage: ranked.pillarCoverage,
		overallMedian: ranked.overallMedian ?? null,
		/* Weights are renormalised PER BUSINESS around whatever that business
		   could be measured on, so there is no single index-level set. Publishing
		   businesses[0]'s as if there were made the dataset unreproducible for
		   every row with a different coverage shape. */
		effectiveWeightsNote:
			'Weights are renormalised per business around its measured pillars. '
			+ 'See each business\'s effectiveWeights; there is no index-level set.',
		sectorMedians: ranked.sectorMedians,
		businesses: ranked.businesses.map((b) => ({
			rank: b.rank,
			name: b.name,
			url: b.url,
			digitalVisibilityScore: b.digitalVisibilityScore,
			pillarScores: b.pillarScores,
			includedPillars: b.includedPillars,
			excludedPillars: b.excludedPillars,
			effectiveWeights: b.effectiveWeights,
		})),
	};
}

function exportCsv(ranked) {
	const cols = ['rank', 'name', 'url', 'digitalVisibilityScore', ...PILLARS.map((p) => p.key)];
	const rows = ranked.businesses.map((b) => ({
		rank: b.rank,
		name: b.name,
		url: b.url,
		digitalVisibilityScore: b.digitalVisibilityScore,
		...Object.fromEntries(PILLARS.map((p) => [p.key, b.pillarScores[p.key]])),
	}));
	return toCsv(rows, cols);
}

/* ---- main ---- */

/* Flags that consume the following argument. Without this list a value like
   the --site-root path is mistaken for the index slug whenever the flag is
   written before the slug. */
const VALUE_FLAGS = new Set(['--quarter', '--site-root']);

function parseArgs(argv) {
	const args = { indexSlug: null, quarter: null };
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--quarter') args.quarter = argv[++i];
		else if (VALUE_FLAGS.has(a)) i++; // consumed elsewhere; skip its value
		else if (a.startsWith('--')) continue;
		else if (!args.indexSlug) args.indexSlug = a;
	}
	return args;
}

function defaultQuarter() {
	const now = new Date();
	const q = Math.floor(now.getMonth() / 3) + 1;
	return `Q${q}-${now.getFullYear()}`;
}

async function main() {
	const { indexSlug, quarter: qArg } = parseArgs(process.argv);
	if (!indexSlug) {
		console.error('Usage: node generate.mjs <index-slug> [--quarter Q2-2026]');
		process.exit(1);
	}
	const quarter = qArg || defaultQuarter();
	const rankedFile = join(DATA_ROOT, indexSlug, '_ranked.json');

	let ranked;
	try {
		ranked = JSON.parse(await readFile(rankedFile, 'utf8'));
	} catch (e) {
		console.error(`Cannot read ${rankedFile}: ${e.message}`);
		console.error('Run score.mjs first: node score.mjs ' + indexSlug);
		process.exit(1);
	}

	const contentDir = join(CONTENT_ROOT, indexSlug);
	await mkdir(contentDir, { recursive: true });
	await mkdir(PUBLIC_DATA, { recursive: true });

	// hub
	await writeFile(join(contentDir, 'index.md'), hubMdx(ranked, quarter, indexSlug));
	// scorecards
	let cards = 0;
	for (const b of ranked.businesses) {
		await writeFile(join(contentDir, `${b.slug}.md`), scorecardMdx(b, ranked, quarter, indexSlug));
		cards++;
	}
	// exports — the site's "latest" copy, overwritten each quarter
	const json = JSON.stringify(exportJson(ranked, quarter, indexSlug), null, 2) + '\n';
	const csv = exportCsv(ranked);
	await writeFile(join(PUBLIC_DATA, `${indexSlug}.json`), json);
	await writeFile(join(PUBLIC_DATA, `${indexSlug}.csv`), csv);

	/* Dated open-data snapshot, written into THIS repo's data/ directory.
	   Published snapshots are the audit trail — the site's copy is replaced
	   every quarter, these are kept forever so movement over time stays
	   verifiable. Writing them here, in the same step that generates the pages,
	   is deliberate: when this was a separate export script it was possible to
	   publish an index to the site and forget the receipt. */
	const q = quarter.toLowerCase();
	const snapshotDir = join(SNAPSHOT_ROOT, indexSlug);
	await mkdir(snapshotDir, { recursive: true });
	await writeFile(join(snapshotDir, `${q}.json`), json);
	await writeFile(join(snapshotDir, `${q}.csv`), csv);

	console.log(`Generated hub + ${cards} scorecards in ${contentDir}`);
	console.log(`Wrote site exports to  ${PUBLIC_DATA}/${indexSlug}.{json,csv}`);
	console.log(`Wrote open snapshot to data/${indexSlug}/${q}.{json,csv}`);
	console.log(`\nNext: commit the generated pages in the site repo, and commit + tag the snapshot here.`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
