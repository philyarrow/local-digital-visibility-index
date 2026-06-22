/* generate.mjs — Local Digital Visibility Index generator.

   Reads scripts/index/data/<index-slug>/_ranked.json and produces:
     (a) the index hub MDX + one scorecard MDX per business under
         new/src/content/docs/indices/<index-slug>/
     (b) machine-readable exports:
         new/public/data/<index-slug>.json
         new/public/data/<index-slug>.csv

   Usage:
     node generate.mjs <index-slug> [--quarter Q2-2026]
     node generate.mjs bristol-estate-agents --quarter Q2-2026

   !! DO NOT RUN WITHOUT REAL DATA. With pillars stubbed, the generated pages
      would publish null/placeholder scores and break the production build with
      meaningless content. Run collect.mjs + score.mjs with live data sources
      first, then run this. This file is intentionally kept ready-but-unrun.

   Conventions matched:
     - Starlight frontmatter (title, description, date, lastUpdated, wpType)
       per new/src/content/docs/indices/methodology.md
     - Deep-scorecard format per §4 of LOCAL-INDEX-STRATEGY.md and the
       methodology page.
     - GEO layer: Dataset + ItemList JSON-LD, quotable stat sentences,
       question-shaped H2s, JSON/CSV exports.
*/

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PILLARS, toCsv } from './lib/common.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const DATA_ROOT = join(HERE, 'data');
const CONTENT_ROOT = join(REPO, 'new', 'src', 'content', 'docs', 'indices');
const PUBLIC_DATA = join(REPO, 'new', 'public', 'data');
const SITE = 'https://hub.pyc.agency';

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

function coverage(ranked) {
	const live = PILLARS.filter((p) => ranked.pillarCoverage?.[p.key]?.live);
	const missing = PILLARS.filter((p) => !ranked.pillarCoverage?.[p.key]?.live);
	const ew = ranked.businesses[0]?.effectiveWeights || {};
	const liveLabels = live.map((p) => p.label);
	const missingLabels = missing.map((p) => p.label);
	const weightLine = live.map((p) => `${p.label} ${Math.round(ew[p.key] ?? 0)}%`).join(', ');
	return { partial: missing.length > 0, live, missing, liveLabels, missingLabels, weightLine };
}

function hubBanner(cov, quarter) {
	if (!cov.partial) return '';
	return `:::caution[v0 — ${cov.live.length} of ${PILLARS.length} pillars measured (${quarter})]
This release scores only **${cov.liveLabels.join(' + ')}**. ${cov.missingLabels.join(', ')} are **not yet measured** and are excluded from the Digital Visibility Score, with the remaining weights renormalised (${cov.weightLine}). Rankings will change when the remaining pillars are added next refresh. Full detail in the [methodology](/indices/methodology/).
:::

`;
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

${topFixes(b).map((f, i) => `${i + 1}. ${f}`).join('\n')}

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
		if (them - me >= 10) gaps.push(`${p.label} (${me} vs ${them})`);
	}
	return gaps.length
		? `The largest gaps are: ${gaps.join('; ')}.`
		: 'The gap to the leader is small and spread evenly across pillars.';
}

function topFixes(b) {
	const fixes = [];
	const order = [...PILLARS].sort((a, c) => (b.pillarScores[a.key] ?? 101) - (b.pillarScores[c.key] ?? 101));
	const tips = {
		speed: 'Cut mobile LCP below 2.5s (optimise images and remove render-blocking resources) — the biggest score and ranking lever.',
		technical: 'Add valid LocalBusiness/RealEstateAgent schema, fix indexability, and ensure a fresh XML sitemap is referenced in robots.txt.',
		local: 'Restart Google review generation and complete the Business Profile to close the local-pack gap.',
		visibility: 'Build local landing pages for the core keyword basket to lift organic and local-pack appearance.',
		ai: 'Publish structured, citable content and entity schema so AI engines surface the business for core local queries.',
		content: 'Add about/team/credentials pages (Propertymark, RICS, Ombudsman) and refresh stale content.',
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
	const measuredOn = cov.partial ? cov.liveLabels.join(', ').toLowerCase() : 'website speed, technical SEO, local presence, search visibility and AI search presence';

	const tableRows = scored.map((b) =>
		`| ${b.rank} | [${b.name}](/indices/${indexSlug}/${b.slug}/) | ${b.digitalVisibilityScore} | ${b.pillarScores.speed ?? '—'} | ${b.pillarScores.technical ?? '—'} | ${b.pillarScores.content ?? '—'} |`,
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

	const failMobile = liveSpeed
		? scored.filter((b) => (b.pillarScores.speed ?? 100) < 50).length
		: null;
	const pct = (failMobile !== null && scored.length)
		? Math.round((failMobile / scored.length) * 100) : null;

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

${pct !== null ? `> As of ${quarter}, ${pct}% of ${idxTitle.toLowerCase()}s in this index score below 50 on mobile Speed & Core Web Vitals (PYC ${idxTitle} Digital Visibility Index, measured ${human}).\n` : ''}
## The league table

| Rank | ${idxTitle} | Score | Speed | Technical | Content |
|-----:|-------------|------:|------:|----------:|--------:|
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
		effectiveWeights: ranked.businesses[0]?.effectiveWeights ?? null,
		sectorMedians: ranked.sectorMedians,
		businesses: ranked.businesses.map((b) => ({
			rank: b.rank,
			name: b.name,
			url: b.url,
			digitalVisibilityScore: b.digitalVisibilityScore,
			pillarScores: b.pillarScores,
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

function parseArgs(argv) {
	const args = { indexSlug: null, quarter: null };
	for (let i = 2; i < argv.length; i++) {
		if (argv[i] === '--quarter') args.quarter = argv[++i];
		else if (!args.indexSlug) args.indexSlug = argv[i];
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
	// exports
	await writeFile(join(PUBLIC_DATA, `${indexSlug}.json`), JSON.stringify(exportJson(ranked, quarter, indexSlug), null, 2) + '\n');
	await writeFile(join(PUBLIC_DATA, `${indexSlug}.csv`), exportCsv(ranked));

	console.log(`Generated hub + ${cards} scorecards in ${contentDir}`);
	console.log(`Wrote exports to ${PUBLIC_DATA}/${indexSlug}.{json,csv}`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
