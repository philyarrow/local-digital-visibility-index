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

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PILLARS, toCsv } from './lib/common.mjs';
import { packFirms } from './lib/match.mjs';

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
${cov.affectedCount === 1 ? 'One firm below is' : `${cov.affectedCount} of the firms below are`} missing at least one pillar: ${cov.incompleteLabels.join(', ')}. Where a pillar could not be measured for a firm it is **excluded from that firm's score** and its remaining weights are renormalised, rather than scored zero — so ${cov.affectedCount === 1 ? 'it is' : 'those firms are'} ranked on less evidence than the rest, and ${cov.affectedCount === 1 ? 'its' : 'their'} position should be read with that in mind. Affected: ${cov.affectedNames.join(', ')}. See the [methodology](/indices/methodology/).
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

${divergingPillars(b, ranked.sectorMedians, deltaScale(ranked))}

| Pillar | Score | Sector median | Reading |
|--------|------:|--------------:|---------|
${pillarRows}

${section('Where this firm ranks', keywordTable(b))}
${section('The gap to the leader', gapDumbbell(b, ranked))}
${section('Closest to the first page', nearMisses(ranked, { slug: b.slug }))}
${section('AI search presence', aiCitations(b))}
${section('Local presence', localCard(b))}
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


/* -------------------------------------------------------------------------- */
/* Diagrams — inline SVG/HTML, rendered at build time.                        */
/*                                                                            */
/* No client JS by design. Every number stays in the markup, because the       */
/* index's whole purpose is being read and cited — by people and by crawlers.  */
/* A chart drawn in the browser is invisible to both.                          */
/* -------------------------------------------------------------------------- */

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* Pillar performance as bars diverging from the sector median. The delta IS
   the story; a table of two numbers per row buries it. */
function divergingPillars(b, medians, scaleTo = 25) {
	const scale = Math.max(10, scaleTo);
	const rows = PILLARS.map((p) => {
		const v = b.pillarScores[p.key];
		const med = medians[p.key];
		if (v === null || v === undefined || med === null || med === undefined) {
			return `<tr><th scope="row">${esc(p.label)}</th><td class="pyc-dv-track"><span class="pyc-dv-mid"></span></td><td class="pyc-dv-val pyc-dv-na">not measured</td></tr>`;
		}
		const delta = Math.round((v - med) * 10) / 10;
		const over = Math.abs(delta) > scale;
		const mag = (Math.min(Math.abs(delta), scale) / scale) * 50;
		const side = delta >= 0 ? 'pos' : 'neg';
		const bar = `<span class="pyc-dv-bar pyc-dv-${side}${over ? ' pyc-dv-over' : ''}" style="width:${mag.toFixed(1)}%"></span>`;
		// "+0" reads as a rounding artefact; a firm exactly on the median is "0".
		const label = delta === 0 ? '0' : `${delta > 0 ? '+' : ''}${delta}`;
		const valCls = delta === 0 ? 'pyc-dv-na' : `pyc-dv-${side}`;
		return `<tr><th scope="row">${esc(p.label)}</th>`
			+ `<td class="pyc-dv-track"><span class="pyc-dv-mid"></span>${bar}</td>`
			+ `<td class="pyc-dv-val ${valCls}">${label}</td></tr>`;
	}).join('');

	return `<figure class="pyc-fig">
<figcaption>Pillar performance against the sector median. Bars right of centre are above the median, left are below.</figcaption>
<table class="pyc-diverge"><tbody>${rows}</tbody></table>
</figure>`;
}

/* Every keyword this firm was measured on, with its live position. The single
   most useful thing the pipeline produces, and previously unpublished. */
function keywordTable(b) {
	const ev = b.evidence;
	if (!ev || !ev.keywordBasket?.length) return '';
	const rows = ev.keywordBasket.map((kw) => {
		const pos = ev.positions?.[kw];
		const cls = pos === undefined || pos === null ? 'pyc-kw-none' : pos <= 3 ? 'pyc-kw-top' : pos <= 10 ? 'pyc-kw-page1' : 'pyc-kw-back';
		const label = pos === undefined || pos === null ? 'not in top 100' : `#${pos}`;
		return `<tr><td>${esc(kw)}</td><td class="pyc-kw-pos ${cls}">${label}</td></tr>`;
	}).join('');
	const summary = ev.rankedKeywords !== null
		? `Ranks for ${ev.rankedKeywords} of ${ev.keywordBasket.length} keywords`
		+ (ev.avgPosition !== null ? `, average position ${ev.avgPosition}` : '')
		+ (ev.localPackAppearances !== null
			? `, in the local 3-pack for ${ev.localPackAppearances} ${ev.localPackAppearances === 1 ? 'keyword' : 'keywords'}`
			: '') + '.'
		: '';
	return `<figure class="pyc-fig">
<figcaption>${esc(summary)}</figcaption>
<table class="pyc-kw"><thead><tr><th scope="col">Keyword</th><th scope="col">Position</th></tr></thead><tbody>${rows}</tbody></table>
</figure>`;
}

/* Which AI answers named this firm, and on what evidence. A domain citation is
   stronger than a bare name mention, so the distinction is shown. */
function aiCitations(b) {
	const ev = b.evidence;
	if (!ev || !ev.aiQueryBasket?.length) return '';
	const cited = new Map((ev.aiCitedQueries || []).map((c) =>
		typeof c === 'string' ? [c, 'name'] : [c.prompt, c.matchedBy || 'name']));
	const rows = ev.aiQueryBasket.map((q) => {
		const how = cited.get(q);
		return `<tr><td class="pyc-ai-mark ${how ? 'pyc-ai-yes' : 'pyc-ai-no'}">${how ? '&#10003;' : '&#10007;'}</td>`
			+ `<td>${esc(q)}</td>`
			+ `<td class="pyc-ai-how">${how ? esc(how === 'domain' ? 'cited by domain' : 'named') : ''}</td></tr>`;
	}).join('');
	return `<figure class="pyc-fig">
<figcaption>Named in ${cited.size} of ${ev.aiQueryBasket.length} AI answers. A domain citation is stronger evidence than a name mention.</figcaption>
<table class="pyc-ai"><tbody>${rows}</tbody></table>
</figure>`;
}

/* Google Business Profile, in raw numbers rather than a compressed pillar
   score. The Local pillar spans 86-98 across a sector whose review counts span
   6x — the underlying figures discriminate where the score does not. */
function localCard(b) {
	const l = b.evidence?.local;
	// A card needs at least one figure that distinguishes this firm. Reviews 0
	// with no rating tells a reader nothing and reads as a broken card.
	if (!l) return '';
	if (l.avgRating === null && !l.reviewCount) return '';
	/* Joined without newlines: a blank line inside a raw HTML block terminates
	   it in CommonMark, which would break the table under any processor that
	   wraps loose lines in <p>. */
	const rows = (pairs) => pairs
		.filter(([, v]) => v !== null && v !== undefined)
		.map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${esc(v)}</td></tr>`)
		.join('');
	return `<figure class="pyc-fig">
<figcaption>Google Business Profile${l.matchedBy === 'name-category' ? ' — matched on name and category; the profile lists a different website to the one indexed' : ''}.</figcaption>
<table class="pyc-kv"><tbody>${rows([
	['Rating', l.avgRating !== null ? `${l.avgRating} / 5` : null],
	['Reviews', l.reviewCount],
	['Locations', l.branchCount],
	['Reviews in last 90 days', l.reviewsLast90d],
	['Address matches website', l.napConsistent === null ? null : (l.napConsistent ? 'yes' : 'no')],
])}</tbody></table>
</figure>`;
}

/* Who actually owns page one. The seed competes with directories and national
   chains, not only with itself, and that is invisible in a league table. */
function shareOfVoice(ranked) {
	const ls = ranked.landscape;
	if (!ls || !ls.summary || !ls.summary.slotsAvailable) return '';
	const { heldBySeed, slotsAvailable, seedSharePct, distinctDomains } = ls.summary;
	const others = slotsAvailable - heldBySeed;
	const seedPct = (heldBySeed / slotsAvailable) * 100;

	const gaps = (ls.seedGaps || []).slice(0, 5)
		.map((d) => `<li><span class="pyc-dom">${esc(d.domain)}</span> — ${d.top10Slots} top-10 slot${d.top10Slots === 1 ? '' : 's'}, best #${d.bestPosition ?? 'n/a'}</li>`)
		.join('');

	return `<figure class="pyc-fig">
<figcaption>Across ${ls.measuredKeywords} keywords there are ${slotsAvailable} first-page organic slots. The firms in this index hold ${heldBySeed} of them (${seedSharePct}%); ${distinctDomains} distinct domains appear in total.</figcaption>
<div class="pyc-sov" role="img" aria-label="Indexed firms hold ${heldBySeed} of ${slotsAvailable} first-page slots">
<span class="pyc-sov-us" style="width:${seedPct.toFixed(1)}%"></span><span class="pyc-sov-them" style="width:${(100 - seedPct).toFixed(1)}%"></span>
</div>
<p class="pyc-sov-key"><span class="pyc-sw pyc-sw-us"></span> this index (${heldBySeed}) &nbsp; <span class="pyc-sw pyc-sw-them"></span> directories, national chains and firms not indexed (${others})</p>
${gaps ? `<p class="pyc-gapnote">Ranking well but not currently indexed:</p><ul class="pyc-gaps">${gaps}</ul>` : ''}
</figure>
${takeaway(`<strong>${(100 - seedSharePct).toFixed(1)}% of the first page</strong> belongs to businesses outside this index &mdash; directories, national chains and local firms not tracked here. These firms are not mainly competing with each other.`)}`;
}

/* Keyword x firm position matrix. Dense, and the only view that shows both
   contested terms and uncontested ground. */
function positionHeatmap(ranked) {
	const scored = ranked.businesses.filter((b) => b.rank !== null && b.evidence?.keywordBasket?.length);
	if (scored.length < 2) return '';
	const kws = scored[0].evidence.keywordBasket;
	if (!kws.length) return '';

	/* Columns come from one firm's basket and every other firm is looked up by
	   those keys. Baskets are index-wide today, but a divergent one would render
	   as blank cells indistinguishable from "not ranked" — so say so instead. */
	const divergent = scored.filter((b) =>
		b.evidence.keywordBasket.length !== kws.length
		|| b.evidence.keywordBasket.some((k, i) => k !== kws[i]));
	if (divergent.length) {
		console.warn(`  ! heatmap skipped: ${divergent.length} business(es) have a different keyword basket `
			+ `(${divergent.slice(0, 3).map((b) => b.name).join(', ')})`);
		return '';
	}

	const band = (p) => p === undefined || p === null ? 0 : p <= 3 ? 4 : p <= 10 ? 3 : p <= 20 ? 2 : 1;
	/* The town repeats in every keyword and is already in the page title, so it
	   is dropped from the column label. Without this the longest label runs to
	   41 characters and overflows the header. Full text stays in the cell title. */
	const town = (indexTitle(ranked.index || '') || '').split(' ')[0];
	const shortKw = (k) => {
		const trimmed = town ? k.replace(new RegExp(`\\s*\\b${town}\\b\\s*`, 'i'), ' ').trim() : k;
		return trimmed.length > 28 ? trimmed.slice(0, 27) + '\u2026' : (trimmed || k);
	};
	const head = `<tr><th scope="col" class="pyc-hm-corner"></th>`
		+ kws.map((k) => `<th scope="col" title="${esc(k)}"><span>${esc(shortKw(k))}</span></th>`).join('') + '</tr>';
	const body = scored.map((b) => `<tr data-pyc-firm="|${esc(b.slug)}|"><th scope="row">${esc(b.name)}</th>`
		+ kws.map((k) => {
			const p = b.evidence.positions?.[k];
			const lvl = band(p);
			return `<td class="pyc-hm-${lvl}" title="${esc(b.name)} — ${esc(k)} — ${p ? '#' + p : 'not in top 100'}">${p ? p : ''}</td>`;
		}).join('') + '</tr>').join('');

	return `<figure class="pyc-fig pyc-fig-wide">
<figcaption>Every firm against every keyword, shaded by position. Darker is stronger; blank means outside the top 100. Read down a column for a contested term, across a row for a firm's reach.</figcaption>
<div class="pyc-scroll"><table class="pyc-heat">${head}${body}</table></div>
<p class="pyc-key"><span class="pyc-sw pyc-hm-4"></span> 1&ndash;3 <span class="pyc-sw pyc-hm-3"></span> 4&ndash;10 <span class="pyc-sw pyc-hm-2"></span> 11&ndash;20 <span class="pyc-sw pyc-hm-1"></span> 21+ <span class="pyc-sw pyc-hm-0"></span> absent</p>
</figure>
${(() => {
	// The emptiest column is uncontested ground, and a league table cannot show it.
	const counts = kws.map((k) => ({ k, n: scored.filter((b) => { const p = b.evidence.positions?.[k]; return p && p <= 10; }).length }));
	const open = counts.filter((c) => c.n === 0);
	if (!open.length) return '';
	// Escape the keyword only — escaping the whole string would escape the
	// ampersands of the quote entities and print them as literal text.
	const quoted = open.slice(0, 3).map((c) => `&ldquo;${esc(c.k)}&rdquo;`).join(', ');
	return takeaway(`No firm in this index reaches the first page for <strong>${quoted}</strong>${open.length > 3 ? ` and ${open.length - 3} other keyword${open.length - 3 === 1 ? '' : 's'}` : ''}. That is uncontested ground, and it is invisible in a league table.`);
})()}`;
}



/* A stated conclusion, not a description. The difference between a chart and an
   argument is that the argument tells you what it means — and it must be
   computed from the data, never templated, or it will eventually be wrong. */
function takeaway(html) {
	return html ? `<p class="pyc-takeaway">${html}</p>` : '';
}


/* Place a label beside a point without letting it run off the viewBox.

   Anchoring on dot position alone was not enough: a long name on a dot just
   left of the threshold still overflowed ("Redland Road Dental Practice" needs
   ~51 units at the mobile type size and was clipped). This estimates the text
   width and flips the anchor when the label would not fit, offsetting by the
   mark's radius rather than a flat gap so a large bubble does not sit under
   its own label. */
function placeLabel(name, x, y, { width = 100, radius = 2, fontUnits = 3.6 } = {}) {
	// ~0.5em per character is a good enough proxy for a proportional face.
	const textUnits = name.length * fontUnits * 0.5;
	const gap = radius + 1.5;
	const fitsRight = x + gap + textUnits <= width - 1;
	const fitsLeft = x - gap - textUnits >= 1;
	// A long name on a central dot fits neither side. Forcing it clips the name
	// either way, so it is dropped: the hover title still carries it, and the
	// takeaway names the firm that matters.
	if (!fitsRight && !fitsLeft) return null;
	const anchor = fitsRight ? 'start' : 'end';
	const tx = fitsRight ? x + gap : x - gap;
	return { anchor, x: Number(tx.toFixed(2)), y: Number(y.toFixed(2)) };
}

/* Visibility against AI presence. Two pillars that ought to correlate; where a
   firm sits off the diagonal is the whole point. */
function visibilityAiQuadrant(ranked) {
	const pts = ranked.businesses.filter((b) => b.rank !== null
		&& typeof b.pillarScores.visibility === 'number'
		&& typeof b.pillarScores.ai === 'number');
	if (pts.length < 3) return '';

	const W = 100, H = 74, PAD = 3;
	const px = (v) => PAD + (v / 100) * (W - PAD * 2);
	const py = (v) => (H - PAD) - (v / 100) * (H - PAD * 2);

	const dots = pts.map((b) => {
		const x = px(b.pillarScores.visibility), y = py(b.pillarScores.ai);
		return `<circle class="pyc-q-dot" data-pyc-firm="|${esc(b.slug)}|" cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="1.6"><title>${esc(b.name)} — visibility ${b.pillarScores.visibility}, AI ${b.pillarScores.ai}</title></circle>`;
	}).join('');

	/* Label only the extremes, and only where a label will not collide. Three
	   labels placed blind overlapped into unreadable mush on a phone
	   ("ConCellapBeilst&Matthews" — two firms sharing the same baseline). Each
	   candidate is now rejected if it lands near one already placed. */
	const ranked_ = [...pts].sort((a, c) =>
		Math.abs(c.pillarScores.visibility - c.pillarScores.ai) - Math.abs(a.pillarScores.visibility - a.pillarScores.ai));

	const placed = [];
	for (const b of ranked_) {
		if (placed.length >= 3) break;
		const x = px(b.pillarScores.visibility), y = py(b.pillarScores.ai);
		// A label is roughly 3 units tall and as wide as its text; keep generous
		// clearance vertically since that is where the collisions happened.
		const clashes = placed.some((q) => Math.abs(q.y - y) < 6 && Math.abs(q.x - x) < 46);
		if (clashes) continue;
		placed.push({ b, x, y });
	}

	const labels = placed.map(({ b, x, y }) => {
		const dy = y < PAD + 6 ? 4 : -3; // nudge below if it would clip the top
		const pos = placeLabel(b.name, x, y + dy, { width: W, radius: 1.6 });
		return pos ? `<text class="pyc-q-lab" data-pyc-firm="|${esc(b.slug)}|" x="${pos.x}" y="${pos.y}" text-anchor="${pos.anchor}">${esc(b.name)}</text>` : '';
	}).filter(Boolean).join('');

	// The named firm must be one that is actually labelled on the chart, so the
	// sentence and the picture agree.
	const offDiag = (placed[0] && placed[0].b) || ranked_[0];
	const gap = offDiag ? offDiag.pillarScores.ai - offDiag.pillarScores.visibility : 0;
	/* The wording has to match the chart. Describing visibility 52 as "barely
	   ranking" contradicted a dot plotted right of the midline, so the strong
	   phrasing is gated on the absolute value as well as the gap. */
	const vis = offDiag?.pillarScores.visibility ?? 0;
	const ai = offDiag?.pillarScores.ai ?? 0;
	const weak = (v) => v < 40;
	const insight = offDiag && Math.abs(gap) >= 20
		? `<strong>${esc(offDiag.name)}</strong> is the widest split: ${gap > 0
			? `AI engines name it far more readily than search surfaces it (AI ${ai}, visibility ${vis})${weak(vis) ? '&nbsp;&mdash; brand without search' : ''}`
			: `search surfaces it far more readily than AI engines name it (visibility ${vis}, AI ${ai})${weak(ai) ? '&nbsp;&mdash; search without brand' : ''}`}. Those are different problems behind a similar overall score.`
		: '';

	return `<figure class="pyc-fig">
<figcaption>Search visibility against AI search presence. The dashed diagonal is parity; a firm far from it is strong in one channel and weak in the other.</figcaption>
<svg class="pyc-quad" viewBox="0 0 ${W} ${H}" role="img" aria-label="Scatter plot of search visibility against AI presence for ${pts.length} firms">
<line class="pyc-q-axis" x1="${PAD}" y1="${H - PAD}" x2="${W - PAD}" y2="${H - PAD}"/>
<line class="pyc-q-axis" x1="${PAD}" y1="${PAD}" x2="${PAD}" y2="${H - PAD}"/>
<line class="pyc-q-mid" x1="${px(50).toFixed(2)}" y1="${PAD}" x2="${px(50).toFixed(2)}" y2="${H - PAD}"/>
<line class="pyc-q-mid" x1="${PAD}" y1="${py(50).toFixed(2)}" x2="${W - PAD}" y2="${py(50).toFixed(2)}"/>
<line class="pyc-q-diag" x1="${px(0).toFixed(2)}" y1="${py(0).toFixed(2)}" x2="${px(100).toFixed(2)}" y2="${py(100).toFixed(2)}"/>
${dots}${labels}
</svg>
<p class="pyc-key"><span class="pyc-q-axname">horizontal: search visibility &rarr;</span> &nbsp; <span class="pyc-q-axname">vertical: AI presence &uarr;</span></p>
</figure>
${takeaway(insight)}`;
}

/* Firm-keyword pairs sitting just off the first page. The most directly useful
   thing the dataset produces, and it costs nothing extra to derive. */
function nearMisses(ranked, opts = {}) {
	const only = opts.slug || null;
	const rows = [];
	for (const b of ranked.businesses) {
		if (b.rank === null || !b.evidence?.positions) continue;
		if (only && b.slug !== only) continue;
		for (const [kw, pos] of Object.entries(b.evidence.positions)) {
			if (typeof pos === 'number' && pos >= 11 && pos <= 20) rows.push({ name: b.name, slug: b.slug, kw, pos });
		}
	}
	if (!rows.length) return '';
	rows.sort((a, b) => a.pos - b.pos);
	const shown = rows.slice(0, only ? 12 : 10);

	const body = shown.map((r) => `<tr data-pyc-firm="|${esc(r.slug)}|">`
		+ (only ? '' : `<th scope="row" class="pyc-nm-firm">${esc(r.name)}</th>`)
		+ `<td class="pyc-nm-kw"><span class="pyc-nm-firm-inline">${only ? '' : esc(r.name) + ' &mdash; '}</span>${esc(r.kw)}</td>`
		+ `<td class="pyc-nm-track"><span class="pyc-nm-bar" style="width:${(((21 - r.pos) / 10) * 100).toFixed(0)}%"></span></td>`
		+ `<td class="pyc-nm-pos">#${r.pos}</td></tr>`).join('');

	// Counted over every qualifying row, not the truncated display list —
	// pairing a truncated firm count with the full position count understated it.
	const firms = new Set(rows.map((r) => r.name)).size;
	const insight = only
		? `<strong>${rows.length} position${rows.length === 1 ? '' : 's'}</strong> sit${rows.length === 1 ? 's' : ''} between #11 and #20 &mdash; one page away, and the cheapest ranking work available to this firm.`
		: `<strong>${rows.length} winnable position${rows.length === 1 ? '' : 's'}</strong> across ${firms} firm${firms === 1 ? '' : 's'} sit between #11 and #20 &mdash; one page off, and closer than any keyword the index does not already measure.`;

	return `<figure class="pyc-fig">
<figcaption>Ranked between #11 and #20 &mdash; one page from the first, ordered by how close.</figcaption>
<table class="pyc-nearmiss"><tbody>${body}</tbody></table>
</figure>
${takeaway(insight)}`;
}

/* Reputation: review volume against rating. The Local pillar compresses a 6x
   spread in reviews into a 12-point score; the raw figures do not. */
function reputationScatter(ranked) {
	const pts = ranked.businesses.filter((b) => b.rank !== null
		&& typeof b.evidence?.local?.reviewCount === 'number' && b.evidence.local.reviewCount > 0
		&& typeof b.evidence.local.avgRating === 'number');
	if (pts.length < 3) return '';

	const revs = pts.map((b) => b.evidence.local.reviewCount);
	const lo = Math.max(1, Math.min(...revs)), hi = Math.max(...revs);
	/* Ratings cluster hard at the top — 15 of 16 Bristol firms sit between 4.07
	   and 4.9, with one at 1.8. Spanning the full range left a 2.3-star empty
	   band and squashed everyone who matters into a sliver. The axis covers the
	   dense band; anything below is pinned to the floor, drawn hollow and named,
	   so it is visibly off-scale rather than silently rescaling the chart. */
	const rats = pts.map((b) => b.evidence.local.avgRating).sort((a, b) => a - b);
	const p10 = rats[Math.floor(rats.length * 0.1)];
	const top = rats[rats.length - 1];
	// Sit just under the cluster, but keep at least a 0.8-star span so a sector
	// where everyone scores alike does not get an absurdly magnified axis.
	let rlo = Math.max(0, p10 - 0.15);
	const rhi = top + 0.15;
	if (rhi - rlo < 0.8) rlo = Math.max(0, rhi - 0.8);
	const below = pts.filter((b) => b.evidence.local.avgRating < rlo);

	/* Marks are inset by the largest bubble radius so an extreme point sits
	   inside the axis frame rather than overhanging it. */
	const W = 100, H = 62, PAD = 7, R_MAX = 4;
	const px = (v) => PAD + R_MAX + ((Math.log10(v) - Math.log10(lo)) / Math.max(0.01, Math.log10(hi) - Math.log10(lo))) * (W - PAD * 2 - R_MAX * 2);
	const py = (v) => (H - PAD - R_MAX) - ((v - rlo) / Math.max(0.01, rhi - rlo)) * (H - PAD * 2 - R_MAX * 2);

	const dots = pts.map((b) => {
		const l = b.evidence.local;
		const r = 1.2 + Math.sqrt(l.reviewCount) / 12;
		const off = l.avgRating < rlo;
		const cy = off ? (H - PAD) : py(l.avgRating);
		return `<circle class="pyc-r-dot${off ? ' pyc-r-off' : ''}" data-pyc-firm="|${esc(b.slug)}|" cx="${px(l.reviewCount).toFixed(2)}" cy="${cy.toFixed(2)}" r="${Math.min(r, 4).toFixed(2)}"><title>${esc(b.name)} — ${l.reviewCount} reviews, ${l.avgRating}★${off ? ' (below the plotted range)' : ''}${l.branchCount > 1 ? `, ${l.branchCount} locations` : ''}</title></circle>`;
	}).join('');

	const maxRev = Math.max(...pts.map((b) => b.evidence.local.reviewCount));
	const maxRat = Math.max(...pts.map((b) => b.evidence.local.avgRating));
	const mostAll = pts.filter((b) => b.evidence.local.reviewCount === maxRev);
	const bestAll = pts.filter((b) => b.evidence.local.avgRating === maxRat);
	const most = mostAll[0], best = bestAll[0];
	/* Naming one firm out of several tied at 5.0 reads as a fact and is not one. */
	const nameOrTie = (all, value, unit) => all.length === 1
		? `${esc(all[0].name)} (${value}${unit})`
		: `${all.length} firms tied at ${value}${unit}`;
	const localScores = pts.map((b) => b.pillarScores.local).filter((v) => typeof v === 'number');
	const spread = localScores.length ? Math.max(...localScores) - Math.min(...localScores) : null;

	const insight = `Review volume spans <strong>${lo} to ${hi}</strong> and ratings <strong>${Math.min(...rats)} to ${Math.max(...rats)}</strong>`
		+ (spread !== null ? `, yet the Local pillar separates these firms by only <strong>${spread} points</strong>&nbsp;— the raw figures discriminate where the score does not.` : '.')
		+ (mostAll.length === 1 && bestAll.length === 1 && most.slug === best.slug
			? ` ${esc(most.name)} leads on both, with ${maxRev} reviews at ${maxRat}.`
			: ` Most reviews: ${nameOrTie(mostAll, maxRev, '')}. Highest rating: ${nameOrTie(bestAll, maxRat, '')}.`);

	/* Without a scale the plot read as a cluster at the top and one lonely dot in
	   an empty field. Ticks and gridlines make the gap mean something, and the
	   outlier is named so the void is a finding rather than a rendering fault. */
	const ratTicks = [];
	// 4.7 - 0.2 is fractionally above 4.5 in binary, which silently dropped the
	// 4.5 gridline; round before the ceil.
	for (let v = Math.ceil(Number(rlo.toFixed(6)) * 2) / 2; v <= rhi; v += 0.5) ratTicks.push(Number(v.toFixed(1)));
	const yGrid = ratTicks.map((v) => `<line class="pyc-q-grid" x1="${PAD}" y1="${py(v).toFixed(2)}" x2="${W - PAD}" y2="${py(v).toFixed(2)}"/>`
		+ `<text class="pyc-q-tick" x="${(PAD - 1).toFixed(2)}" y="${(py(v) + 1).toFixed(2)}" text-anchor="end">${v}</text>`).join('');

	// On a narrow range the geometric mean rounds onto an endpoint, painting two
	// identical labels at the same x.
	const revTicks = [...new Set([lo, Math.round(Math.sqrt(lo * hi)), hi])];
	const xGrid = revTicks.map((v) => `<text class="pyc-q-tick" x="${px(v).toFixed(2)}" y="${(H - PAD + 3.5).toFixed(2)}" text-anchor="middle">${v}</text>`).join('');

	const outlier = below.map((b) => {
		const label = `${b.name} ${b.evidence.local.avgRating}\u2605`;
		const pos = placeLabel(label, px(b.evidence.local.reviewCount), H - PAD + 1, { width: W, radius: 3 });
		return pos ? `<text class="pyc-q-lab" x="${pos.x}" y="${pos.y}" text-anchor="${pos.anchor}">${esc(label)}</text>` : '';
	}).filter(Boolean).join('');

	return `<figure class="pyc-fig">
<figcaption>Google review volume (log scale) against average rating. Bubble size is review count.${below.length ? ` The rating axis starts at ${rlo.toFixed(1)} so the cluster is readable; ${below.length === 1 ? 'one firm rated' : `${below.length} firms rated`} below that ${below.length === 1 ? 'sits' : 'sit'} on the floor, drawn hollow and named.` : ''}</figcaption>
<svg class="pyc-repscatter" viewBox="0 0 ${W} ${H + 5}" role="img" aria-label="Review volume against average rating for ${pts.length} firms">
${yGrid}${xGrid}
<line class="pyc-q-axis" x1="${PAD}" y1="${H - PAD}" x2="${W - PAD}" y2="${H - PAD}"/>
<line class="pyc-q-axis" x1="${PAD}" y1="${PAD}" x2="${PAD}" y2="${H - PAD}"/>
${dots}${outlier}
</svg>
<p class="pyc-key"><span class="pyc-q-axname">horizontal: reviews (log) &rarr;</span> &nbsp; <span class="pyc-q-axname">vertical: rating &uarr;</span></p>
</figure>
${takeaway(insight)}`;
}

/* This firm against the sector median and the category leader, per pillar. The
   chart a marketing agency would actually act on. */
function gapDumbbell(b, ranked) {
	const leader = ranked.businesses.find((x) => x.rank === 1);
	if (!leader || leader.slug === b.slug) return '';

	const rows = PILLARS.map((p) => {
		const me = b.pillarScores[p.key];
		const them = leader.pillarScores[p.key];
		const med = ranked.sectorMedians?.[p.key];
		if (typeof me !== 'number' || typeof them !== 'number') return '';
		/* Markers are centred on their position, so a score of 0 or 100 would hang
		   half outside the track — over the row label at one end and into the
		   value column at the other. 206 markers sat at an extreme. Insetting the
		   scale keeps every marker inside its own track. */
		const INSET = 4;
		const pos = (v) => (INSET + (v / 100) * (100 - INSET * 2)).toFixed(2);
		const loV = Math.min(me, them), hiV = Math.max(me, them);
		return `<tr><th scope="row">${esc(p.label)}</th>`
			+ `<td class="pyc-db-track">`
			+ `<span class="pyc-db-rail"></span>`
			+ `<span class="pyc-db-span" style="left:${pos(loV)}%;width:${(Number(pos(hiV)) - Number(pos(loV))).toFixed(2)}%"></span>`
			+ (typeof med === 'number' ? `<span class="pyc-db-med" style="left:${pos(med)}%" title="sector median ${med}"></span>` : '')
			+ `<span class="pyc-db-lead" style="left:${pos(them)}%" title="leader ${them}"></span>`
			+ `<span class="pyc-db-self" style="left:${pos(me)}%" title="this firm ${me}"></span>`
			+ `</td><td class="pyc-db-val">${me}</td></tr>`;
	}).filter(Boolean).join('');
	if (!rows) return '';

	const gaps = PILLARS.map((p) => ({
		label: p.label,
		gap: (typeof leader.pillarScores[p.key] === 'number' && typeof b.pillarScores[p.key] === 'number')
			? leader.pillarScores[p.key] - b.pillarScores[p.key] : null,
	})).filter((g) => typeof g.gap === 'number' && g.gap > 0).sort((a, c) => c.gap - a.gap);

	const ahead = PILLARS.filter((p) => typeof b.pillarScores[p.key] === 'number'
		&& typeof leader.pillarScores[p.key] === 'number'
		&& b.pillarScores[p.key] >= leader.pillarScores[p.key]).map((p) => p.label);

	/* "The entire deficit is X and Y" was false wherever a third pillar also
	   trailed — most pages. State the total, then what dominates it. */
	const totalGap = gaps.reduce((n, g) => n + g.gap, 0);
	const top2 = gaps.slice(0, 2);
	const top2Sum = top2.reduce((n, g) => n + g.gap, 0);
	const share = totalGap ? Math.round((top2Sum / totalGap) * 100) : 0;

	const insight = top2.length
		? (gaps.length <= 2
			? `The whole deficit to ${esc(leader.name)} is <strong>${esc(top2.map((g) => g.label).join(' and '))}</strong> &mdash; <strong>${totalGap} points</strong>.`
			: `${esc(b.name)} trails ${esc(leader.name)} by <strong>${totalGap} points</strong> across ${gaps.length} pillars, but <strong>${share}% of that</strong> is <strong>${esc(top2.map((g) => g.label).join(' and '))}</strong> alone.`)
			+ (ahead.length ? ` It already matches or beats the leader on ${esc(ahead.join(', '))}.` : '')
		: '';

	return `<figure class="pyc-fig">
<figcaption>This firm against the sector median and the index leader, ${esc(leader.name)}, on every pillar.</figcaption>
<table class="pyc-dumbbell"><tbody>${rows}</tbody></table>
<p class="pyc-key"><span class="pyc-sw pyc-db-k-self"></span> this firm <span class="pyc-sw pyc-db-k-med"></span> sector median <span class="pyc-sw pyc-db-k-lead"></span> leader</p>
</figure>
${takeaway(insight)}`;
}

/* A heading with nothing under it still lands in Starlight's page ToC, so a
   figure that renders nothing must take its heading with it. */

/* Channel overlap. Three sets, few items, membership is the question — the one
   shape a Venn is genuinely right for. Past three sets it stops working and an
   UpSet plot is the correct replacement. */
function channelVenn(ranked) {
	/* A firm whose visibility pillar was never collected is unmeasured, not
	   absent. Bucketing it as "not in the local pack" on a public page asserts
	   something we did not test. */
	const scored = ranked.businesses.filter((b) => b.rank !== null && b.evidence
		&& b.evidence.localPackAppearances !== null && b.evidence.positions);
	const unmeasured = ranked.businesses.filter((b) => b.rank !== null
		&& (!b.evidence || b.evidence.localPackAppearances === null || !b.evidence.positions));
	if (scored.length < 3) return '';

	const inOrganic = (b) => Object.values(b.evidence.positions || {}).some((p) => p && p <= 10);
	const inPack = (b) => (b.evidence.localPackAppearances || 0) > 0;
	const inAi = (b) => (b.evidence.aiCitedQueries || []).length > 0;

	const region = (o, p, a) => scored.filter((b) => inOrganic(b) === o && inPack(b) === p && inAi(b) === a);
	const names = (arr) => arr.map((b) => b.name).join(', ');
	const all3 = region(true, true, true);
	const none = region(false, false, false);
	if (!scored.some(inOrganic) && !scored.some(inPack) && !scored.some(inAi)) return '';

	/* The diagram carries the shape at a glance; the table beneath carries the
	   names, stays readable at any set count, and is what a screen reader gets.
	   Neither alone was right — circles without names say little, a table alone
	   was the visual downgrade. */
	const R = { all3, organicPack: region(true, true, false), organicAi: region(true, false, true),
		packAi: region(false, true, true), organicOnly: region(true, false, false),
		packOnly: region(false, true, false), aiOnly: region(false, false, true) };
	const vn = (x, y, k, cls = '') => (R[k]?.length
		? `<text class="pyc-venn-n-svg ${cls}" x="${x}" y="${y}" text-anchor="middle">${R[k].length}</text>` : '');
	const diagram = `<svg class="pyc-venn-svg" viewBox="0 0 100 94" role="img" aria-label="Venn diagram of channel visibility; the table below names every firm">
<circle class="pyc-vc pyc-vc-a" cx="37" cy="35" r="26"/>
<circle class="pyc-vc pyc-vc-b" cx="63" cy="35" r="26"/>
<circle class="pyc-vc pyc-vc-c" cx="50" cy="58" r="26"/>
<text class="pyc-venn-lab" x="6" y="10">Organic top 10</text>
<text class="pyc-venn-lab" x="94" y="10" text-anchor="end">Local 3-pack</text>
<text class="pyc-venn-lab" x="50" y="92" text-anchor="middle">Named by AI</text>
${vn(24, 30, 'organicOnly')}${vn(76, 30, 'packOnly')}${vn(50, 80, 'aiOnly')}
${vn(50, 25, 'organicPack')}${vn(31, 55, 'organicAi')}${vn(69, 55, 'packAi')}
${vn(50, 46, 'all3', 'pyc-venn-hero')}
</svg>`;

	const cell = (label, arr) => arr.length
		? `<tr data-pyc-firm="|${arr.map((b) => esc(b.slug)).join('|')}|"><th scope="row">${esc(label)}</th><td class="pyc-venn-n">${arr.length}</td><td>${esc(names(arr))}</td></tr>`
		: `<tr class="pyc-venn-empty"><th scope="row">${esc(label)}</th><td class="pyc-venn-n">0</td><td>&mdash;</td></tr>`;

	return `<figure class="pyc-fig">
<figcaption>Where each firm is visible: ranked in the organic top 10 for at least one keyword, present in the local 3-pack, or named in at least one AI answer. ${all3.length} of ${scored.length} appear in all three.${unmeasured.length ? ` ${unmeasured.length} firm${unmeasured.length === 1 ? '' : 's'} could not be measured on these channels and ${unmeasured.length === 1 ? 'is' : 'are'} excluded.` : ''}</figcaption>
${diagram}
<table class="pyc-venn"><thead><tr><th scope="col">Visible in</th><th scope="col">Firms</th><th scope="col">Which</th></tr></thead><tbody>
${cell('All three channels', all3)}
${cell('Organic + local pack', region(true, true, false))}
${cell('Organic + AI', region(true, false, true))}
${cell('Local pack + AI', region(false, true, true))}
${cell('Organic only', region(true, false, false))}
${cell('Local pack only', region(false, true, false))}
${cell('AI only', region(false, false, true))}
${cell('None of the three', none)}
</tbody></table>
</figure>
${takeaway(all3.length === 0
	? `<strong>Not one firm</strong> in this index is visible in all three channels at once.`
	: `<strong>${all3.length} of ${scored.length} firms</strong> are visible in all three channels.${none.length ? ` ${none.length} appear${none.length === 1 ? 's' : ''} in none of them.` : ''}`)}`;
}


/* Firm focus — progressive enhancement.

   Every figure is already complete in the markup: this only adds the ability to
   pick a firm and have the page recede around it. Without JavaScript nothing is
   lost, which matters because the index exists to be read by crawlers and AI
   engines as much as by people, and a chart assembled in the browser is
   invisible to both.

   The control is written by the script rather than shipped in the HTML, so a
   reader without JS never sees a dead widget. */
function focusScript(ranked, indexSlug) {
	const firms = ranked.businesses
		.filter((b) => b.rank !== null)
		.map((b) => ({ n: b.name, s: b.slug }));
	if (firms.length < 3) return '';

	return `<script type="application/json" id="pyc-firms">${JSON.stringify(firms)}</script>
<script>
(function () {
	var data = document.getElementById('pyc-firms');
	if (!data) return;
	var firms;
	try { firms = JSON.parse(data.textContent); } catch (e) { return; }

	var main = document.querySelector('.sl-markdown-content');
	if (!main) return;

	// No text matching: the generator stamps data-pyc-firm on every element that
	// belongs to a firm, delimited on both sides so "setfords" cannot match
	// "setfords-cheltenham". The browser only toggles a class.
	var bar = document.createElement('div');
	bar.className = 'pyc-focus';
	bar.innerHTML = '<span class="pyc-focus-label">Focus a firm</span>';
	var chips = document.createElement('div');
	chips.className = 'pyc-focus-chips';
	bar.appendChild(chips);

	var current = null;
	function apply(slug, push) {
		current = slug;
		document.body.classList.toggle('pyc-focusing', !!slug);
		main.querySelectorAll('[data-pyc-firm]').forEach(function (el) {
			var on = !!slug && el.getAttribute('data-pyc-firm').indexOf('|' + slug + '|') !== -1;
			el.classList.toggle('pyc-on', on);
		});
		chips.querySelectorAll('button').forEach(function (b) {
			b.setAttribute('aria-pressed', String(b.dataset.slug === (slug || '')));
		});
		if (push && window.history && history.replaceState) {
			var u = new URL(location.href);
			if (slug) u.searchParams.set('firm', slug); else u.searchParams.delete('firm');
			history.replaceState(null, '', u);
		}
	}

	[{ n: 'All firms', s: '' }].concat(firms).forEach(function (f) {
		var b = document.createElement('button');
		b.type = 'button';
		b.className = 'pyc-chip';
		b.dataset.slug = f.s;
		b.textContent = f.n;
		b.setAttribute('aria-pressed', 'false');
		b.addEventListener('click', function () { apply(f.s || null, true); });
		chips.appendChild(b);
	});

	var firstFig = main.querySelector('.pyc-fig, .pyc-league');
	if (firstFig && firstFig.parentNode) firstFig.parentNode.insertBefore(bar, firstFig);
	else main.insertBefore(bar, main.firstChild);

	var want = new URL(location.href).searchParams.get('firm');
	apply(firms.some(function (f) { return f.s === want; }) ? want : null, false);
})();
</script>`;
}

/* Movement since the previous snapshot, restricted to pillars measured in BOTH
   quarters.

   Q2 scored two of six pillars; Q3 scores all six. Plotting the headline score
   across that boundary would render a methodology change as a trend, which is
   the one thing a time series must never do. So only the comparable pillars are
   charted, the scope is stated, and unchanged readings are counted rather than
   drawn — eighteen flat lines is not a chart. */
function quarterMovement(ranked, prior, quarter) {
	if (!prior?.businesses?.length) return '';

	const liveIn = (snap) => new Set(Object.entries(snap.pillarCoverage || {})
		.filter(([, v]) => v.scored > 0).map(([k]) => k));
	const shared = [...liveIn(prior)].filter((k) => liveIn(ranked).has(k));
	if (!shared.length) return '';

	const was = new Map(prior.businesses.map((b) => [b.name, b]));
	const rows = [];
	for (const b of ranked.businesses) {
		const p = was.get(b.name);
		if (!p) continue;
		for (const key of shared) {
			const from = p.pillarScores?.[key], to = b.pillarScores?.[key];
			if (typeof from !== 'number' || typeof to !== 'number') continue;
			rows.push({ name: b.name, slug: b.slug, key, from, to, delta: to - from });
		}
	}
	if (!rows.length) return '';

	const moved = rows.filter((r) => r.delta !== 0).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
	const flat = rows.length - moved.length;
	const labels = Object.fromEntries(PILLARS.map((p) => [p.key, p.label]));
	const scope = shared.map((k) => labels[k]).join(' and ');

	if (!moved.length) {
		return `<p class="pyc-geo-null">Nothing measurable changed between ${esc(prior.quarter)} and ${esc(quarter)} on the pillars measured in both: ${esc(scope)}. All ${rows.length} readings are identical.</p>`;
	}

	const show = moved.slice(0, 12);

	/* Built as HTML, not SVG. The SVG version placed labels at fixed viewBox
	   coordinates and both ends clipped: "-67 Content & trust" ran past 100 on
	   the right, "Andrews Property Group" past 0 on the left. HTML wraps and
	   ellipsises on its own, matches the other figures, and lets the marks carry
	   the firm attribute so focus dims the whole row rather than only its text. */
	const rows_ = show.map((r) => {
		const up = r.delta > 0;
		const dir = up ? 'pyc-mv-up' : 'pyc-mv-down';
		const lo_ = Math.min(r.from, r.to), hi_ = Math.max(r.from, r.to);
		return `<tr data-pyc-firm="|${esc(r.slug)}|">`
			+ `<th scope="row" class="pyc-mv-name">${esc(r.name)}</th>`
			+ `<td class="pyc-mv-track">`
			+ `<span class="pyc-mv-rail"></span>`
			+ `<span class="pyc-mv-span ${dir}" style="left:${lo_}%;width:${hi_ - lo_}%"></span>`
			+ `<span class="pyc-mv-from" style="left:${r.from}%" title="${esc(prior.quarter)}: ${r.from}"></span>`
			+ `<span class="pyc-mv-to ${dir}" style="left:${r.to}%" title="${esc(quarter)}: ${r.to}"></span>`
			+ `</td>`
			+ `<td class="pyc-mv-val ${dir}">${up ? '+' : ''}${r.delta}</td>`
			+ `<td class="pyc-mv-pillar">${esc(labels[r.key])}</td>`
			+ `</tr>`;
	}).join('');

	// Rows are firm x pillar, so a firm can appear twice; count distinct firms.
	const firmsMoved = new Set(show.map((r) => r.name)).size;
	const big = moved[0];
	return `<figure class="pyc-fig">
<figcaption>Change between ${esc(prior.quarter)} and ${esc(quarter)} on the ${shared.length === 1 ? 'one pillar' : `${shared.length} pillars`} measured in both quarters &mdash; ${esc(scope)}. The other pillars were not measured in ${esc(prior.quarter)}, so no comparison is possible and none is drawn.</figcaption>
<table class="pyc-movement"><tbody>${rows_}</tbody></table>
<p class="pyc-key">Hollow mark is ${esc(prior.quarter)}, solid is ${esc(quarter)}.${moved.length > show.length ? ` Showing the ${show.length} largest of ${moved.length} changes.` : ''} ${flat} reading${flat === 1 ? '' : 's'} unchanged and not drawn, across ${firmsMoved} firm${firmsMoved === 1 ? '' : 's'} that moved.</p>
</figure>
${takeaway(`<strong>${esc(big.name)}</strong> moved furthest: ${esc(labels[big.key])} ${big.delta > 0 ? 'up' : 'down'} <strong>${Math.abs(big.delta)} points</strong> since ${esc(prior.quarter)}. ${moved.length} of ${rows.length} comparable readings changed at all &mdash; which is what a quarter of movement actually looks like.`)}`;
}

/* What the keyword basket is actually asking. A basket that is all one intent
   measures one slice of the funnel, which this figure exists to expose. */
function intentMix(ranked) {
	const it = ranked.intent;
	if (!it || !it.keywords?.length) return '';
	const total = it.keywords.length;
	const mix = Object.entries(it.mix || {}).sort((a, b) => b[1] - a[1]);
	if (!mix.length) return '';

	const bars = mix.map(([label, n]) => `<tr><th scope="row">${esc(label)}</th>`
		+ `<td class="pyc-int-track"><span class="pyc-int-bar" style="width:${((n / total) * 100).toFixed(1)}%"></span></td>`
		+ `<td class="pyc-int-n">${n} of ${total}</td></tr>`).join('');

	const classified = mix.reduce((n, [, c]) => n + c, 0);
	const monotone = mix.length === 1 && classified === total && total > 1
		? ` Every keyword in the basket carries the same intent, so this pillar measures one slice of the funnel rather than the whole journey.`
		: '';

	return `<figure class="pyc-fig">
<figcaption>Search intent across the measured keyword basket, classified by DataForSEO.${esc(monotone)}</figcaption>
<table class="pyc-intent"><tbody>${bars}</tbody></table>
</figure>`;
}

/* Local-pack coverage across the city. Answers a question no other figure can:
   where can people actually find these firms.

   Cells count DISTINCT indexed firms, not pack entries — a chain listing two
   offices in one pack is one firm being findable there. A chain's other branch
   counts toward that chain, which the caption states rather than implying the
   exact indexed office. */
function geoGrid(ranked) {
	const g = ranked.geoGrid;
	if (!g || !g.points?.length) return '';
	const n = g.size || 3;
	if (!g.points.some((p) => p.pack?.length)) return '';

	const firmsAt = new Map();
	for (const pt of g.points) {
		firmsAt.set(`${pt.row}:${pt.col}`, pt.pack ? packFirms(pt.pack, ranked.businesses) : null);
	}
	const counts = [...firmsAt.values()].filter(Boolean).map((f) => f.length);
	const covered = counts.filter((c) => c > 0).length;

	/* Nine identical blank cells under a caption about counting firms is not a
	   figure. When no indexed firm holds a slot anywhere, say that in a sentence
	   — it is a stronger finding than the grid would have been. */
	if (!covered) {
		return `<p class="pyc-geo-null">Searching &ldquo;${esc(g.keyword)}&rdquo; from ${g.points.length} points across a ${g.radiusKm * 2}km square, <strong>not one of the ${ranked.businesses.length} firms in this index appeared in the local 3-pack at any location</strong>. The pack was held entirely by businesses outside the index.</p>`;
	}

	const cells = [];
	for (let r = 0; r < n; r++) {
		const row = [];
		for (let c = 0; c < n; c++) {
			const firms = firmsAt.get(`${r}:${c}`);
			const cls = firms === null ? 'x' : String(Math.min(firms.length, 3));
			const title = firms === null
				? 'no result at this point'
				: firms.length
					? firms.map((f) => f.name).join(', ')
					: 'no indexed firm in the pack here';
			row.push(`<td class="pyc-geo-${cls}" title="${esc(title)}">${firms && firms.length ? firms.length : ''}</td>`);
		}
		cells.push(`<tr>${row.join('')}</tr>`);
	}

	const distinct = new Set([...firmsAt.values()].filter(Boolean).flat().map((f) => f.name));
	return `<figure class="pyc-fig">
<figcaption>Local 3-pack for &ldquo;${esc(g.keyword)}&rdquo; searched from ${g.points.length} points across a ${g.radiusKm * 2}km square. Each cell counts how many indexed firms hold a pack slot at that location; a chain counts wherever any of its branches appears. ${covered} of ${g.points.length} points contain at least one indexed firm, and ${distinct.size} of the ${ranked.businesses.length} indexed firms appear somewhere on the grid.</figcaption>
<table class="pyc-geo"><caption class="pyc-sr">Indexed firms holding a local pack slot, by grid position from north-west to south-east</caption>${cells.join('')}</table>
<p class="pyc-key"><span class="pyc-sw pyc-geo-0"></span> none <span class="pyc-sw pyc-geo-1"></span> 1 firm <span class="pyc-sw pyc-geo-2"></span> 2 <span class="pyc-sw pyc-geo-3"></span> 3 of the pack</p>
</figure>`;
}

/* Largest absolute pillar-vs-median delta anywhere in the index, so every
   scorecard's bars share one scale and are comparable between firms. */

/* A heading with nothing under it still lands in Starlight's page ToC, so a
   figure that renders nothing must take its heading with it — see section(). */

/* Scale the diverging bars to the 90th percentile of deltas, not the maximum.

   Scaling to the max let a single outlier set the scale for the whole index:
   with a max of 70, a median delta of 10 drew a 1.8% sliver and the typical
   firm's chart read as six empty rows. The few bars beyond the scale are
   clipped and flagged rather than allowed to define it. */
function deltaScale(ranked) {
	const deltas = [];
	for (const b of ranked.businesses) {
		for (const p of PILLARS) {
			const v = b.pillarScores?.[p.key];
			const med = ranked.sectorMedians?.[p.key];
			if (typeof v === 'number' && typeof med === 'number') deltas.push(Math.abs(v - med));
		}
	}
	if (!deltas.length) return 25;
	deltas.sort((a, b) => a - b);
	// p75, not p90: at p90 the outliers still set the scale and a typical delta
	// of 10 drew at 15% of half-width. The quarter of bars beyond it are clipped
	// and notched, and their exact value is printed alongside regardless.
	const p75 = deltas[Math.floor(deltas.length * 0.75)];
	// Never smaller than 15: a sector where everyone sits on the median should
	// not magnify noise into apparently dramatic bars.
	return Math.max(15, Math.ceil(p75));
}

function section(heading, body) {
	const content = (body || '').trim();
	return content ? `## ${heading}\n\n${content}\n` : '';
}

/* ---- index hub MDX ---- */

function hubMdx(ranked, quarter, indexSlug, prior = null) {
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
	/* Emitted as HTML rather than a markdown table so the column widths can be
	   controlled. Nine columns under Starlight's default table padding overflow
	   the content column: the page gained a horizontal scrollbar while firm
	   names wrapped onto three lines beside half-empty number columns.

	   Headers are abbreviated with the full pillar name in a title, so the
	   numeric columns can be narrow without losing meaning. */
	const cell = (v) => (v === null || v === undefined ? '<span class="pyc-lg-na">&mdash;</span>' : v);
	const SHORT = { speed: 'Spd', technical: 'Tech', local: 'Local', visibility: 'Vis', ai: 'AI', content: 'Cont' };

	const leagueHead = '<tr>'
		+ '<th scope="col" class="pyc-lg-rank">#</th>'
		+ `<th scope="col" class="pyc-lg-name">${esc(idxTitle)}</th>`
		+ '<th scope="col" class="pyc-lg-score" title="Digital Visibility Score">Score</th>'
		+ PILLARS.map((p) => `<th scope="col" class="pyc-lg-p"><abbr title="${esc(p.label)}">${esc(SHORT[p.key] || p.label)}</abbr></th>`).join('')
		+ '</tr>';

	/* data-label carries the column name onto each cell so the table can restack
	   as cards on a phone without JavaScript and without losing what each number
	   means. Nine columns cannot fit 340px of content width, and dropping the
	   pillars that discriminate most would be the wrong half to lose. */
	const leagueBody = scored.map((b) => `<tr data-pyc-firm="|${esc(b.slug)}|">`
		+ `<td class="pyc-lg-rank" data-label="Rank">${b.rank}</td>`
		+ `<th scope="row" class="pyc-lg-name"><a href="/indices/${esc(indexSlug)}/${esc(b.slug)}/">${esc(b.name)}</a></th>`
		+ `<td class="pyc-lg-score" data-label="Score">${cell(b.digitalVisibilityScore)}</td>`
		+ PILLARS.map((p) => `<td class="pyc-lg-p" data-label="${esc(SHORT[p.key] || p.label)}">${cell(b.pillarScores[p.key])}</td>`).join('')
		+ '</tr>').join('');

	const leagueTable = `<table class="pyc-league"><thead>${leagueHead}</thead><tbody>${leagueBody}</tbody></table>`;

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
${section('Who owns the first page', shareOfVoice(ranked))}
## The league table

${leagueTable}

${section('Which keywords are contested, and which are open?', positionHeatmap(ranked))}
${section('Where each firm is visible', channelVenn(ranked))}
${section('Search visibility against AI presence', visibilityAiQuadrant(ranked))}
${section('Closest to the first page', nearMisses(ranked))}
${section('Reputation: reviews against rating', reputationScatter(ranked))}
${section('What the keyword basket is asking', intentMix(ranked))}
${section('Local pack coverage across the city', geoGrid(ranked))}
${section('What changed since last quarter', quarterMovement(ranked, prior, quarter))}
## Which ${idxTitle.toLowerCase()} has the best website?

${scored.length ? `${scored[0].name} tops the ${quarter} index with a Digital Visibility Score of ${scored[0].digitalVisibilityScore}/100.` : ''} Each firm has a full diagnostic scorecard linked from the table above.

## How this is measured

Every score follows the same six-pillar [methodology](/indices/methodology/): Speed & Core Web Vitals (20%), Technical foundation (20%), Local presence (20%), Visibility (15%), AI search presence (15%) and Content & trust (10%).${cov.partial ? ` **This ${quarter} release (v0) measures ${cov.live.length} of those ${PILLARS.length} pillars** — ${cov.liveLabels.join(' and ')} — with weights renormalised to ${cov.weightLine}. The remaining pillars are added in a later refresh.` : ''} Download the full dataset: [JSON](/data/${indexSlug}.json) · [CSV](/data/${indexSlug}.csv).

Spotted an error? [Request a correction](mailto:info@philyarrow.co.uk?subject=Correction:%20${encodeURIComponent(idxTitle)}%20Index).

<script type="application/ld+json">${JSON.stringify(dataset)}</script>
<script type="application/ld+json">${JSON.stringify(itemList)}</script>
${focusScript(ranked, indexSlug)}
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

	/* The previous quarter's published snapshot, if one exists. Read from this
	   repo's own data/ — the site copy is overwritten each quarter. */
	/* Filenames sort lexicographically, which puts quarter before year:
	   [q1-2027, q3-2026, q4-2026] would pick q4-2026 as "latest". Parse and sort
	   numerically, and only consider snapshots BEFORE the quarter being
	   generated so regenerating an old quarter cannot pick a future one. */
	let prior = null;
	const ord = (q, y) => Number(y) * 4 + Number(q);
	const cur = quarter.match(/^Q(\d)-(\d{4})$/);
	try {
		const files = (await readdir(join(SNAPSHOT_ROOT, indexSlug)))
			.map((f) => {
				const m = f.match(/^q(\d)-(\d{4})\.json$/);
				return m ? { file: f, ord: ord(m[1], m[2]) } : null;
			})
			.filter(Boolean)
			.filter((x) => !cur || x.ord < ord(cur[1], cur[2]))
			.sort((a, b) => a.ord - b.ord);
		if (files.length) {
			const pick = files[files.length - 1].file;
			// Parse OUTSIDE the ENOENT guard: a malformed snapshot must not be
			// indistinguishable from "no prior snapshot", which would silently
			// drop the whole section from the published page.
			prior = JSON.parse(await readFile(join(SNAPSHOT_ROOT, indexSlug, pick), 'utf8'));
		}
	} catch (e) {
		if (e.code !== 'ENOENT') throw e;
	}

	const contentDir = join(CONTENT_ROOT, indexSlug);
	await mkdir(contentDir, { recursive: true });
	await mkdir(PUBLIC_DATA, { recursive: true });

	// hub
	await writeFile(join(contentDir, 'index.md'), hubMdx(ranked, quarter, indexSlug, prior));
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
