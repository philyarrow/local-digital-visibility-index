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
/* `--archive-only` writes a dated measurement into THIS repo and touches the
   site not at all, so it must not demand a checkout of a repo it will never
   write to. That matters for CI: the site repo is private, the pipeline repo
   is public, and the scheduled collection runs in the public one. */
const ARCHIVE_ONLY = process.argv.includes('--archive-only');

function resolveSiteRoot({ required = true } = {}) {
	const flagIndex = process.argv.indexOf('--site-root');
	const fromFlag = flagIndex !== -1 ? process.argv[flagIndex + 1] : null;
	const root = fromFlag || process.env.INDEX_SITE_ROOT;
	if (!root && !required) return null;
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

const SITE_ROOT = resolveSiteRoot({ required: !ARCHIVE_ONLY });
const CONTENT_ROOT = SITE_ROOT ? join(SITE_ROOT, 'new', 'src', 'content', 'docs', 'indices') : null;
const PUBLIC_DATA = SITE_ROOT ? join(SITE_ROOT, 'new', 'public', 'data') : null;

/* Dated open-data snapshots live in THIS repo, not the site's. */
const SNAPSHOT_ROOT = join(HERE, '..', 'data');


/* ---- licence ----
   The data is CC BY 4.0: free to reuse, including commercially and in AI
   answers, on the condition of a named credit and a link. That condition only
   binds anyone if they can find it, and it was stated in the repo alone — not
   on the site, not in the downloads, and not in the Dataset JSON-LD that
   machine consumers and AI engines actually read. */
const LICENCE = {
	name: 'CC BY 4.0',
	url: 'https://creativecommons.org/licenses/by/4.0/',
	holder: 'Phil Yarrow (PYC)',
	terms: `${SITE}/indices/licence/`,
};

/* Two levels, because a per-dataset line was too narrow: it credited one index
   in one quarter, so anyone drawing on several indices, on the methodology, or
   on the body of work as a whole had no credit that actually covered what they
   used.

   The REQUIRED credit names the work and its author and covers every dataset on
   the site. The CITATION adds which index and quarter a specific figure came
   from, for anyone quoting one precisely. */
const WORK = 'Local Digital Visibility Index';
const attributionRequired = () => `${LICENCE.holder} — ${WORK}. ${SITE}/indices/`;
const citationFor = (indexSlug, quarter) =>
	`${LICENCE.holder} — ${WORK}: ${indexTitle(indexSlug)}, ${quarter}. ${SITE}/indices/${indexSlug}/`;

/* ---- contextual bridges ----

   The index used to be an island: 89 pages linking only to the methodology and
   the site root, and nothing anywhere on the hub linking out to pyc.agency. So
   authority flowed into the index and stopped there.

   A pillar is the hinge. Each one is a thing measured here, explained in the
   knowledge base, computed with a method in the glossary, and fixed by a
   service on the agency site. Encoding that once means every generated page
   carries the bridges without anyone hand-editing 89 files.

   This MIRRORS new/src/lib/bridge.ts in the site repo (PILLAR_KB and
   PILLAR_AGENCY). The site is authoritative — same rule as methodology.md. If
   you change a mapping, change it there first, then copy it here. A broken KB
   slug produces a 404 on every scorecard at once, so both halves are checked
   against the site's content tree by --check-bridges before writing. */

const PILLAR_KB = {
	speed: 'solving-mobile-seo-problems-a-checklist-for-troubleshooting',
	technical: 'advanced-technical-seo-best-practices-and-strategies-for-improved-performance',
	local: 'advanced-local-seo-strategies-for-dominating-local-search-results',
	visibility: 'advanced-keyword-research-techniques-for-finding-untapped-opportunities',
	ai: 'the-power-of-big-data-in-seo-leveraging-data-analytics-for-better-insights',
	content: 'the-role-of-content-in-seo-best-practices-for-creating-seo-friendly-content',
};

/* Analytical companions, not the scorer. score.mjs computes every pillar with
   plain arithmetic on purpose; these are the methods for reading the result. */
const PILLAR_METHOD = {
	speed: 'time-series-analysis-in-seo-unravelling-patterns-and-trends-over-time',
	technical: 'coordinate-descent-in-seo-a-mathematical-formula-for-optimisation',
	local: 'how-is-k-nearest-neighbors-used-in-seo',
	visibility: 'how-is-regression-analysis-used-in-seo',
	ai: 'how-is-dempster-shafer-theory-used-in-seo',
	content: 'breaking-down-kolmogorov-complexity-in-seo',
};

const AGENCY = 'https://pyc.agency';

/* `speed` is null on purpose: pyc.agency has no performance page, and pointing
   at an unrelated one to fill the slot is the dilution this map exists to
   prevent. Add the target when the page exists. */
const PILLAR_AGENCY = {
	speed: null,
	technical: { href: `${AGENCY}/guides/seo-automation/`, label: 'SEO automation',
		context: 'running these technical checks continuously rather than once a quarter' },
	local: { href: `${AGENCY}/proof/`, label: 'local case studies',
		context: 'what moving these signals did for comparable service businesses' },
	visibility: { href: `${AGENCY}/guides/topical-authority/`, label: 'topical authority',
		context: 'why ranking breadth across a sector beats chasing single terms' },
	ai: { href: `${AGENCY}/guides/generative-engine-optimization/`, label: 'generative engine optimisation',
		context: 'getting named by the answer engines this pillar measures' },
	content: { href: `${AGENCY}/guides/topical-authority/`, label: 'topical authority',
		context: 'how depth and coverage compound into citation-worthiness' },
};

const kbHref = (key) => `/kb/${PILLAR_KB[key]}/`;
const methodHref = (key) => `/glossary/${PILLAR_METHOD[key]}/`;

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
	const date = new Date(ranked.measuredAt ?? ranked.scoredAt).toISOString();
	const human = humanDate(ranked.measuredAt ?? ranked.scoredAt);
	const leader = ranked.businesses.find((x) => x.rank === 1);
	const medians = ranked.sectorMedians;
	const cov = coverage(ranked);

	/* Entity identification.
	 *
	 * The scorecard used to carry one blank LocalBusiness node nested inside
	 * Dataset.about — no @id, so nothing could reconcile it with anything, and
	 * "this dataset is about X" is not the same claim as "this page is about X".
	 * Scorecards are wpType "page", so Head.astro emits no Article and there was
	 * no WebPage node either: across 271 pages the only entity statement was one
	 * buried inside a Dataset.
	 *
	 * Now a connected @graph — WebPage about the business, the business itself
	 * with an @id in our own namespace, and the Dataset — with sameAs pointing at
	 * where the entity is authoritatively described.
	 *
	 * What is deliberately NOT asserted, permanently: address, telephone and
	 * aggregateRating. We hold avgRating and reviewCount and they must never be
	 * emitted — third-party review markup about an entity you do not own is a
	 * self-serving-review violation. The only address available anywhere is a
	 * Companies House registered office, which is frequently the firm's
	 * accountant rather than its premises, and 22 of these businesses have two to
	 * five branches so a single address is wrong by construction.
	 *
	 * The line: name, url, sameAs and identifier are REFERENCE claims — here is
	 * where this entity is authoritatively described. Address, telephone and
	 * rating are ATTRIBUTE claims — here is what this entity is. A third party
	 * publishes the first set only. */
	const cardUrl = `${SITE}/indices/${indexSlug}/${b.slug}/`;
	const bizId = `${cardUrl}#business`;

	const sameAs = [];
	const pid = b.evidence?.local?.placeId;
	/* Gated on match quality. A name-only listing match is the one case where the
	   identity claim is weakest, and sameAs is a hard assertion. */
	if (pid && /^ChIJ[A-Za-z0-9_-]+$/.test(pid) && b.evidence?.local?.matchedBy !== 'name-category') {
		sameAs.push(`https://www.google.com/maps/place/?q=place_id:${pid}`);
	}
	const ch = b.enrichment?.companies;
	const chNum = ch?.matched && /^(?:\d{8}|[A-Z]{2}\d{6})$/.test(ch.companyNumber || '') ? ch.companyNumber : null;
	if (chNum) sameAs.push(`https://find-and-update.company-information.service.gov.uk/company/${chNum}`);

	const business = {
		'@type': sectorCopy(indexSlug)?.schemaType || 'LocalBusiness',
		'@id': bizId,
		name: b.name,
		...(b.url ? { url: b.url } : {}),
		...(sameAs.length ? { sameAs } : {}),
		...(chNum ? {
			identifier: {
				'@type': 'PropertyValue',
				propertyID: 'GB-COH',
				name: 'UK Companies House company number',
				value: chNum,
			},
		} : {}),
	};

	const dataset = {
		'@type': 'Dataset',
		'@id': `${cardUrl}#dataset`,
		url: cardUrl,
		name: `${b.name} — ${idTitleQuarter(idxTitle, quarter)}`,
		description: `Digital Visibility Score and six-pillar breakdown for ${b.name}, measured ${date} via the PYC ${idxTitle} Digital Visibility Index.`,
		/* Reference the site-wide Organization node by @id rather than declaring a
		   second one. The generated pages previously minted an Organization named
		   "Phil Yarrow Consulting (PYC)" while astro.config.mjs declared one named
		   "PYC Hub" — two unlinked entities, so the index's authority accrued to
		   neither. sameAs points at the domain the work is meant to credit. */
		creator: { '@id': `${SITE}/#org` },
		publisher: { '@id': `${SITE}/#org` },
		license: LICENCE.url,
		usageInfo: LICENCE.terms,
		isAccessibleForFree: true,
		copyrightHolder: { '@id': `${SITE}/#phil` },
		copyrightYear: new Date(ranked.measuredAt ?? ranked.scoredAt).getUTCFullYear(),
		dateModified: date,
		isPartOf: { '@type': 'Dataset', name: `PYC ${idxTitle} Digital Visibility Index`, url: `${SITE}/indices/${indexSlug}/` },
		about: { '@id': bizId },
		mainEntityOfPage: { '@id': `${cardUrl}#webpage` },
	};

	const graph = {
		'@context': 'https://schema.org',
		'@graph': [
			{
				'@type': 'WebPage',
				'@id': `${cardUrl}#webpage`,
				url: cardUrl,
				name: `${b.name} — ${idxTitle} Digital Visibility Score`,
				isPartOf: { '@id': `${SITE}/#site` },
				about: { '@id': bizId },
				mainEntity: { '@id': bizId },
				publisher: { '@id': `${SITE}/#org` },
				datePublished: date,
				dateModified: date,
			},
			business,
			dataset,
		],
	};

	const fm = [
		'---',
		`title: ${yamlStr(`${b.name} — ${idxTitle} Digital Visibility Score`)}`,
		/* Rank and quarter first, index name dropped.
		   The old wording ran to a median 171 characters with 248 of 271 over the
		   ~160 a search result shows, and what got truncated was "Measured
		   <quarter>" — the freshness stamp, which is the one thing distinguishing
		   this page from the business's own site and from every directory. It also
		   spent its budget restating the name and the index, both already in the
		   title. Rank against cohort is the fact no competing result can state. */
		`description: ${yamlStr(`${b.name} scored ${b.digitalVisibilityScore ?? 'n/a'}/100 in ${quarter}, rank ${b.rank ?? '—'} of ${ranked.count}. Pillar breakdown, sector medians and prioritised fixes — every figure reproducible.`)}`,
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

${pillarTable(b, ranked.sectorMedians)}

${divergingPillars(b, ranked.sectorMedians, deltaScale(ranked))}

${section('Problems found', problemsFound(b))}
${section('Where this firm ranks', keywordTable(b))}
${section('The gap to the leader', gapDumbbell(b, ranked))}
${section('Closest to the first page', nearMisses(ranked, { slug: b.slug }))}
${section('AI search presence', aiCitations(b))}
${section('Local presence', localCard(b))}
${section('Lab speed against real users', labVsField(b))}
${section('What customers talk about', reviewThemes(b))}
${section('Why this score', whyThisScore(b))}
## Key findings

${keyFindings(b, ranked).map((f) => `- ${f}`).join('\n')}

${leader && leader.slug !== b.slug ? `## How this compares to the leader

${leader.name} leads the index with ${leader.digitalVisibilityScore}/100. ${gapToLeader(b, leader)}
` : ''}

## Top fixes (ranked by impact)

${topFixes(b, sectorCopy(indexSlug)).map((f, i) => `${i + 1}. ${f}`).join('\n')}

${section('Firms ranked near this one', comparables(b, ranked, indexSlug))}
${contextCard(b)}
${whereToFix(b)}
${pager(b, ranked, indexSlug)}

---

*How this is measured: see the [index methodology](/indices/methodology/), and the [statistical methods](/glossary/) behind each pillar. This index is published by [PYC](https://pyc.agency/about/); if you want this score moved, [start here](https://pyc.agency/).*

<script type="application/ld+json">${JSON.stringify(graph)}</script>
`;
}

/* The outbound half of the bridge, and the only place the hub leaves itself.

   Driven by the firm's own lowest-scoring pillars so the link is relevant to
   the page it sits on. Two filters apply and BOTH used to be invisible in the
   copy: a pillar with no honest agency target is skipped (speed), and two
   pillars can share one target (visibility and content both point at topical
   authority).

   The first version de-duplicated by href and then still called the survivors
   "the two weakest", which published a falsehood: Amicus Law's weakest are
   Content 33 and Visibility 46, but Visibility was dropped as a duplicate and
   Local presence 78 — the firm's second-STRONGEST pillar — was named in its
   place and recommended for remediation.

   So: take the two genuinely lowest-scoring pillars that have a target, and
   group them by target instead of discarding one. A shared target yields one
   link naming both pillars. The heading states the filter rather than
   implying there is none. */
function whereToFix(b) {
	const ranked = PILLARS
		.filter((p) => typeof b.pillarScores[p.key] === 'number' && PILLAR_AGENCY[p.key])
		.sort((x, y) => b.pillarScores[x.key] - b.pillarScores[y.key])
		.slice(0, 2);

	if (!ranked.length) return '';

	/* Group the picks by target so a shared guide is linked once, without any
	   pillar silently vanishing from the list. */
	const groups = [];
	for (const p of ranked) {
		const target = PILLAR_AGENCY[p.key];
		const existing = groups.find((g) => g.target.href === target.href);
		if (existing) existing.pillars.push(p);
		else groups.push({ target, pillars: [p] });
	}

	const lines = groups.map(({ target, pillars }) => {
		const named = pillars
			.map((p) => `**${p.label}** (${b.pillarScores[p.key]}/100)`)
			.join(' and ');
		const methods = pillars
			.map((p) => `[${p.label.toLowerCase()}](${methodHref(p.key)})`)
			.join(', ');
		return `- ${named} — read [${target.label}](${target.href}) on ${target.context}. `
			+ `Background on analysing ${pillars.length > 1 ? 'these pillars' : 'this pillar'}: ${methods}.`;
	});

	const noun = ranked.length > 1 ? 'pillars' : 'pillar';
	return `## Where to get this fixed

${b.name}'s lowest-scoring ${noun} among those we publish remediation guidance for:

${lines.join('\n')}
`;
}

/* The pillar breakdown — the first thing on every scorecard, and the only
   table here that was still plain markdown. That meant it inherited Starlight's
   `table { display:block; overflow:auto }` fallback while every other figure had
   been given a real table layout, so the most important table on the page was
   the one that scrolled sideways on a phone: its four columns need ~544px and a
   414px phone offers ~340px.

   The "Reading" column was the cause — "Above sector median" is 19 characters
   restating a comparison the reader can already see. Replaced with the signed
   delta, which is the same comparison quantified, in a third of the width. The
   median stays the reference on every figure on this site; here the table does
   the subtraction rather than asking the reader to. */
function pillarTable(b, medians) {
	const rows = PILLARS.map((p) => {
		const score = b.pillarScores[p.key];
		const med = medians[p.key];
		const label = `<a href="${kbHref(p.key)}">${esc(p.label)}</a>`;

		if (score === null || score === undefined) {
			return `<tr><th scope="row">${label}</th>`
				+ `<td class="pyc-pl-n" data-label="Score">—</td>`
				+ `<td class="pyc-pl-n pyc-pl-med" data-label="Median">${med ?? '—'}</td>`
				+ `<td class="pyc-pl-d pyc-pl-na" data-label="vs median">not measured</td></tr>`;
		}

		const d = med === null || med === undefined ? null : Math.round((score - med) * 10) / 10;
		/* The sign carries direction, so the reading never depends on colour. */
		const dTxt = d === null ? '—' : d > 0 ? `+${d}` : d < 0 ? `−${Math.abs(d)}` : 'level';
		const dCls = d === null ? '' : d >= 5 ? ' pyc-pl-up' : d <= -5 ? ' pyc-pl-down' : ' pyc-pl-level';

		return `<tr><th scope="row">${label}</th>`
			+ `<td class="pyc-pl-n" data-label="Score">${score}</td>`
			+ `<td class="pyc-pl-n pyc-pl-med" data-label="Median">${med ?? '—'}</td>`
			+ `<td class="pyc-pl-d${dCls}" data-label="vs median">${dTxt}</td></tr>`;
	}).join('');

	return `<figure class="pyc-fig">
<figcaption>Each pillar scored 0–100 against the sector median for this index. The final column is this firm's distance from that median.</figcaption>
<table class="pyc-pillars"><thead><tr><th scope="col">Pillar</th><th scope="col" class="pyc-pl-n">Score</th><th scope="col" class="pyc-pl-n">Median</th><th scope="col" class="pyc-pl-d">vs median</th></tr></thead><tbody>${rows}</tbody></table>
</figure>`;
}

/* Rank-aware pagination.
   
   Scorecards set `sidebar: hidden`, which suppresses Starlight's prev/next, so
   79 scorecards had no navigation at all — the only way from one firm to
   another was back to the league table. On a ranked index the ordering is the
   navigation: the interesting neighbour of a firm is the firm one place above
   or below it, and moving through the table in rank order is how anyone reads
   a league.
   
   Static HTML, no script. It also puts ~158 contextual links into the index
   cluster, each one carrying a rank and a score as its own context. */
/* Firms immediately around this one in the ranking, beyond the pager's ±1.
 *
 * Scorecards had a median of three inbound internal links: one from the league
 * table row, two from the pagers of the firms either side. The top and bottom
 * of each index had two, and a deep page on a young domain with two inbound
 * links is crawled rarely and ranks weakly.
 *
 * A symmetric rank window, and nothing cleverer. Two designs were rejected in
 * favour of it. Linking the sector leader from every card gave rank-1 pages 55,
 * 52, 44 and 41 inbound links — the footprint of a link scheme rather than a
 * reader feature. Adding "beats you on your weakest pillar" and "closest
 * profile match" slots bought one extra median link and pushed the maximum
 * in-degree to 34 of 55, and both collapse where a cohort ties: Gloucester
 * restaurants has sector medians of 0 for Visibility and AI, so dozens of firms
 * are exactly equal and every page would point at the same firm.
 *
 * The window is flat by construction. In-degree is structural — every firm sits
 * in the window of the four firms nearest it in rank, whether or not it picks
 * them back — so no page can accumulate an anomalous share.
 *
 * Every row states why it is there in terms the reader can check against the
 * table they just looked at, and the anchor is the firm's name with its rank
 * and score beside it, the same convention the pager uses. */
function comparables(b, ranked, indexSlug) {
	if (b.rank === null || b.rank === undefined) return '';
	const byRank = ranked.businesses
		.filter((x) => x.rank !== null && x.rank !== undefined)
		.sort((x, y) => x.rank - y.rank);
	const i = byRank.findIndex((x) => x.slug === b.slug);
	if (i < 0 || byRank.length < 4) return '';

	/* Never duplicate the pager: it already links ±1. */
	const taken = new Set([b.slug, byRank[i - 1]?.slug, byRank[i + 1]?.slug].filter(Boolean));
	const picked = [];
	/* Walk outward from d=2. The outward walk is what lets the top and bottom
	   of the table fill four slots too, rather than falling short. */
	for (let d = 2; d < byRank.length && picked.length < 4; d++) {
		for (const cand of [byRank[i - d], byRank[i + d]]) {
			if (picked.length >= 4) break;
			if (!cand || taken.has(cand.slug)) continue;
			taken.add(cand.slug);
			const places = Math.abs(cand.rank - b.rank);
			picked.push({
				firm: cand,
				why: `${places} place${places === 1 ? '' : 's'} ${cand.rank < b.rank ? 'above' : 'below'} you`,
			});
		}
	}
	if (!picked.length) return '';

	const rows = picked.map(({ firm, why }) =>
		`<tr><th scope="row"><a href="/indices/${esc(indexSlug)}/${esc(firm.slug)}/">${esc(firm.name)}</a></th>`
		+ `<td class="pyc-cmp-n">#${firm.rank}</td>`
		+ `<td class="pyc-cmp-n">${firm.digitalVisibilityScore}/100</td>`
		+ `<td>${esc(why)}</td></tr>`).join('');

	return `<figure class="pyc-fig">
<figcaption>The firms nearest ${esc(b.name)} in this ranking, beyond the two either side.</figcaption>
<table class="pyc-cmp"><thead><tr><th scope="col">Firm</th><th scope="col">Rank</th><th scope="col">Score</th><th scope="col">Why it is here</th></tr></thead><tbody>${rows}</tbody></table>
</figure>`;
}

function pager(b, ranked, indexSlug) {
	if (b.rank === null || b.rank === undefined) return '';
	const byRank = ranked.businesses
		.filter((x) => x.rank !== null && x.rank !== undefined)
		.sort((x, y) => x.rank - y.rank);
	if (byRank.length < 2) return '';

	const i = byRank.findIndex((x) => x.slug === b.slug);
	const prev = i > 0 ? byRank[i - 1] : null;             // ranked above
	const next = i >= 0 && i < byRank.length - 1 ? byRank[i + 1] : null;

	const link = (firm, dir) => firm
		? `<a class="pyc-pg pyc-pg-${dir}" href="/indices/${esc(indexSlug)}/${esc(firm.slug)}/">`
			+ `<span class="pyc-pg-dir">${dir === 'prev' ? '↑ Ranked above' : '↓ Ranked below'}</span>`
			+ `<span class="pyc-pg-firm">${esc(firm.name)}</span>`
			+ `<span class="pyc-pg-meta">#${firm.rank} · ${firm.digitalVisibilityScore}/100</span></a>`
		: `<span class="pyc-pg pyc-pg-${dir} pyc-pg-end">`
			+ `<span class="pyc-pg-dir">${dir === 'prev' ? 'Top of the index' : 'Bottom of the index'}</span></span>`;

	return `<nav class="pyc-pager" aria-label="Move through the ranking">
${link(prev, 'prev')}
<a class="pyc-pg pyc-pg-up" href="/indices/${esc(indexSlug)}/"><span class="pyc-pg-dir">Full index</span><span class="pyc-pg-firm">All ${byRank.length} firms</span></a>
${link(next, 'next')}
</nav>`;
}

/* Context block — recorded, never scored.

   Kept visually and verbally separate from the pillars because none of it
   carries weight. The heading says so, and each row names its source, so a
   reader can never mistake a company age or a field-speed reading for
   something that moved the ranking. */
function contextCard(b) {
	const e = b.enrichment;
	if (!e) return '';
	const rows = [];

	const ch = e.companies;
	if (ch && ch.matched) {
		const bits = [`Company ${esc(ch.companyNumber)}`];
		if (ch.ageYears !== null && ch.ageYears !== undefined) bits.push(`${ch.ageYears} years old`);
		if (ch.companyStatus) bits.push(esc(ch.companyStatus));
		if (ch.sicCodes?.length) bits.push(`SIC ${ch.sicCodes.map(esc).join(', ')}`);
		rows.push(['Companies House', bits.join(' · ')]);
	} else if (ch && ch.matched === false) {
		rows.push(['Companies House', 'No confident match on the registered name']);
	}

	const cx = e.crux;
	if (cx && cx.available) {
		const p = [];
		if (cx.lcpMs !== null) p.push(`LCP ${cx.lcpMs}ms`);
		if (cx.inpMs !== null) p.push(`INP ${cx.inpMs}ms`);
		if (cx.cls !== null) p.push(`CLS ${cx.cls}`);
		if (cx.passesCwv !== null) p.push(cx.passesCwv ? 'passes Core Web Vitals' : 'does not pass Core Web Vitals');
		rows.push(['Real-user speed (CrUX)', p.join(' · ')]);
	} else if (cx && cx.available === false) {
		rows.push(['Real-user speed (CrUX)', 'Too little traffic to appear in Chrome\u2019s public dataset']);
	}

	const fsa = e.fsa;
	if (fsa && fsa.matched) {
		const bits = [];
		bits.push(fsa.ratingNumeric !== null ? `Rating ${fsa.ratingValue} of 5` : `Rating: ${esc(fsa.ratingValue)}`);
		if (fsa.ratingDate) bits.push(`inspected ${esc(fsa.ratingDate)}`);
		if (fsa.localAuthority) bits.push(esc(fsa.localAuthority));
		rows.push(['Food hygiene (FSA)', bits.join(' · ')]);
	} else if (fsa && fsa.matched === false) {
		rows.push(['Food hygiene (FSA)', 'No confident match on the registered trading name']);
	}

	/* Lighthouse: the categories the Speed pillar does not score. Kept out of
	   the score deliberately — adding categories to a published pillar would
	   move every ranking retroactively. */
	const lh = e.lighthouse;
	if (lh && lh.performance !== null && lh.performance !== undefined) {
		const parts = [`Performance ${lh.performance}`];
		if (lh.accessibility !== null && lh.accessibility !== undefined) parts.push(`accessibility ${lh.accessibility}`);
		if (lh.bestPractices !== null && lh.bestPractices !== undefined) parts.push(`best practices ${lh.bestPractices}`);
		if (lh.seo !== null && lh.seo !== undefined) parts.push(`SEO ${lh.seo}`);
		let row = parts.join(' · ');
		if (lh.failing?.length) {
			row += ` — biggest losses: ${lh.failing.slice(0, 3).map((f) => esc(f.title)).join('; ')}`;
		}
		rows.push(['Lighthouse (lab, mobile)', row]);
	}

	/* Google profile detail the Local pillar computes over rather than reports. */
	const g = e.gbpDetail;
	if (g) {
		const parts = [];
		if (g.totalPhotos !== null && g.totalPhotos !== undefined) parts.push(`${g.totalPhotos} photo${g.totalPhotos === 1 ? '' : 's'}`);
		if (g.isClaimed !== null && g.isClaimed !== undefined) parts.push(g.isClaimed ? 'claimed' : 'unclaimed');
		if (g.hasDescription !== null) parts.push(g.hasDescription ? 'has a description' : 'no description');
		if (g.hasHours !== null) parts.push(g.hasHours ? 'hours listed' : 'no hours listed');
		const rd = g.ratingDistribution;
		if (rd && typeof rd === 'object') {
			const total = Object.values(rd).reduce((a, b) => a + (Number(b) || 0), 0);
			const ones = Number(rd['1']) || 0;
			/* The distribution behind an average: a 4.5 built from consistent
			   fours reads very differently from one built from fives and ones. */
			if (total >= 5) parts.push(`${ones} of ${total} reviews are one star`);
		}
		if (parts.length) rows.push(['Google profile detail', parts.join(' · ')]);
	}

	/* Backlinks: the only signal here bought per business rather than per index. */
	const bl = e.backlinks;
	if (bl && bl.referringDomains !== null && bl.referringDomains !== undefined) {
		const parts = [`${bl.referringDomains} referring domains`];
		if (bl.backlinks !== null && bl.backlinks !== undefined) parts.push(`${bl.backlinks} links`);
		if (bl.rank !== null && bl.rank !== undefined) parts.push(`rank ${bl.rank}`);
		if (bl.brokenBacklinks) parts.push(`${bl.brokenBacklinks} broken`);
		rows.push(['Backlinks', parts.join(' · ')]);
	}

	const cr = e.crawl;
	if (cr && cr.pagesCrawled) {
		const p = [`${cr.pagesCrawled} pages crawled`];
		if (cr.avgInternalLinksPerPage !== null) p.push(`${cr.avgInternalLinksPerPage} internal links per page`);
		const d = cr.keyPageDepth || {};
		const depths = Object.entries(d).filter(([, v]) => v !== null).map(([k, v]) => `${k} ${v} click${v === 1 ? '' : 's'}`);
		if (depths.length) p.push(`reachable in: ${depths.join(', ')}`);
		if (cr.genericAnchorRatio !== null) p.push(`${Math.round(cr.genericAnchorRatio * 100)}% of links use a generic anchor`);
		if (cr.orphanCandidates !== null) p.push(`${cr.orphanCandidates} sitemap pages not reachable by following links`);
		rows.push(['Site structure', p.join(' · ')]);

		/* A sitemap is a claim about what a site contains; these are the checks
		   on whether the claim holds. */
		const sm = [];
		if (cr.sitemapUrls !== null && cr.sitemapUrls !== undefined) sm.push(`${cr.sitemapUrls} URLs listed`);
		if (cr.sitemapDeclaredInRobots !== null && cr.sitemapDeclaredInRobots !== undefined) {
			sm.push(cr.sitemapDeclaredInRobots ? 'declared in robots.txt' : 'not declared in robots.txt');
		}
		if (cr.sitemapStaleDays !== null && cr.sitemapStaleDays !== undefined) {
			sm.push(`newest entry ${cr.sitemapStaleDays} day${cr.sitemapStaleDays === 1 ? '' : 's'} old`);
		} else if (cr.sitemapHasLastmod === false) {
			sm.push('no lastmod dates');
		}
		if (cr.sitemapSampleChecked) sm.push(`${cr.sitemapSampleResolved} of ${cr.sitemapSampleChecked} sampled URLs resolve`);
		if (sm.length) rows.push(['Sitemap', sm.join(' · ')]);
	} else if (cr && cr.robotsDisallowedAll) {
		rows.push(['Site structure', 'robots.txt asks crawlers not to read this site, so it was not crawled']);
	} else if (cr && (cr.error || cr.stoppedBecause)) {
		/* A failed crawl was indistinguishable from an absent one. */
		rows.push(['Site structure', `Not crawled — ${esc(cr.error || cr.stoppedBecause)}`]);
	}

	if (!rows.length) return '';

	return `## Context (not scored)

<figure class="pyc-fig">
<figcaption>Recorded alongside the measurement to make it easier to judge, but carrying no weight in the Digital Visibility Score. See the <a href="/indices/methodology/">methodology</a>.</figcaption>
<table class="pyc-kv"><tbody>${rows.map(([k, v]) => `<tr><th scope="row">${k}</th><td>${v}</td></tr>`).join('')}</tbody></table>
</figure>
`;
}

/* SIC labels for the codes these sectors actually produce. Unknown codes are
   shown bare rather than guessed at — a wrong label on official registry data
   would be worse than no label. */
const SIC_LABELS = {
	'41100': 'Development of building projects',
	'41201': 'Construction of commercial buildings',
	'41202': 'Construction of domestic buildings',
	'43999': 'Other specialised construction',
	'43310': 'Plastering', '43320': 'Joinery installation', '43341': 'Painting',
	'43210': 'Electrical installation', '43220': 'Plumbing and heating',
	'56101': 'Licensed restaurants', '56102': 'Unlicensed restaurants and cafes',
	'56103': 'Take-away food shops', '56302': 'Public houses and bars',
	'55100': 'Hotels and similar accommodation',
	'69201': 'Accounting and auditing', '69202': 'Bookkeeping', '69203': 'Tax consultancy',
	'69102': 'Solicitors', '69109': 'Other legal activities',
	'68310': 'Real estate agencies', '68320': 'Management of real estate',
	'86230': 'Dental practice',
	'82110': 'Combined office administrative services',
	'70229': 'Management consultancy',
	'43390': 'Other building completion and finishing',
	'42990': 'Construction of other civil engineering projects',
	'43342': 'Glazing',
	'43120': 'Site preparation',
	'43910': 'Roofing activities',
	'43290': 'Other construction installation',
	'43110': 'Demolition',
	'70100': 'Activities of head offices',
	'70221': 'Financial management',
	'71111': 'Architectural activities',
	'71129': 'Other engineering activities',
	'68100': 'Buying and selling of own real estate',
	'68209': 'Other letting and operating of real estate',
	'68201': 'Renting and operating of Housing Association real estate',
	'81300': 'Landscape service activities',
	'96090': 'Other service activities',
	'47990': 'Other retail sale not in stores',
	'62020': 'Information technology consultancy',
};

/* What the public register says this cohort is.
 *
 * The seed list is curated from trading names, which is how a firm presents
 * itself rather than what it is registered to do. For Gloucester accountants
 * those disagreed: six firms trading as "Accountancy" or "Accounting" are
 * registered under bookkeeping. Publishing the mix is more useful than quietly
 * narrowing the cohort to fit its own title, and it is the one place the
 * Companies House data says something about the sector rather than one firm. */
function registryMix(ranked) {
	const matched = ranked.businesses.filter((b) => b.enrichment?.companies?.matched === true);
	if (matched.length < 5) return '';

	const counts = new Map();
	for (const b of matched) {
		for (const c of b.enrichment.companies.sicCodes || []) {
			counts.set(c, (counts.get(c) || 0) + 1);
		}
	}
	if (!counts.size) return '';

	const rows = [...counts.entries()]
		.sort((a, c) => c[1] - a[1])
		.map(([code, n]) => `<tr><th scope="row">${esc(code)}</th><td>${esc(SIC_LABELS[code] || 'Not labelled here')}</td><td class="pyc-pl-n">${n}</td></tr>`)
		.join('');

	/* [len >> 1] is the upper middle, not the median, for an even-sized set —
	   it published 15.3 for Cheltenham construction where the median is 14.7. */
	const ages = matched.map((b) => b.enrichment.companies.ageYears).filter((v) => typeof v === 'number').sort((a, c) => a - c);
	const mid = ages.length >> 1;
	const ageMedian = !ages.length ? null
		: ages.length % 2 ? ages[mid]
		: Math.round(((ages[mid - 1] + ages[mid]) / 2) * 10) / 10;
	const ageLine = ageMedian !== null
		? ` Median company age is ${ageMedian} years, ranging from ${ages[0]} to ${ages[ages.length - 1]}.`
		: '';

	/* Address corroboration only happens when the index config carries a town.
	   Claiming it unconditionally would assert a check that never ran. */
	const corroborated = matched.filter((b) => b.enrichment.companies.matchConfidence === 'unique-name-and-town').length;
	const howMatched = corroborated === matched.length
		? 'on an exact name with a corroborating registered address'
		: corroborated === 0
			? 'on an exact, unique registered name'
			: `on an exact, unique registered name — ${corroborated} of them also corroborated by the registered address`;

	/* Firms whose profile returned no SIC codes contribute no row, so say so
	   rather than implying the table covers every matched firm. And the counts
	   only exceed the cohort when firms actually hold multiple codes. */
	const noSic = matched.length - matched.filter((b) => (b.enrichment.companies.sicCodes || []).length).length;
	const codeTotal = [...counts.values()].reduce((a, c) => a + c, 0);
	const sumNote = codeTotal > matched.length - noSic
		? ' A company may register several SIC codes, so these counts sum to more than the number of firms.'
		: '';
	const missingNote = noSic ? ` ${noSic} matched ${noSic === 1 ? 'firm lists' : 'firms list'} no SIC code and ${noSic === 1 ? 'is' : 'are'} absent from the table.` : '';

	return `## What the register says this cohort is

<figure class="pyc-fig">
<figcaption>Companies House matched ${matched.length} of ${ranked.businesses.length} businesses ${howMatched}. Firms are seeded by trading name, which is how a business presents itself rather than what it is registered to do — so the mix below is often broader than the index title suggests.${sumNote}${missingNote}${ageLine} Recorded alongside the measurement and carrying no weight in any score.</figcaption>
<table class="pyc-kv"><thead><tr><th scope="col">SIC</th><th scope="col">Registered activity</th><th scope="col" class="pyc-pl-n">Firms</th></tr></thead><tbody>${rows}</tbody></table>
</figure>
`;
}

/* Hygiene rating against digital visibility.
 *
 * This is the cross-check the professional regulators made impossible: the FSA
 * publishes ratings as genuinely open data, so a food cohort can be compared
 * against an official assessment nobody in this project produced.
 *
 * The match rate is low and stated, because venues register with the FSA under
 * a name that often differs from the one they trade under, and a hygiene rating
 * published against the wrong restaurant is worse than no rating at all. */
function hygieneCrossCheck(ranked) {
	const m = ranked.businesses.filter((b) => b.enrichment?.fsa?.matched === true && b.digitalVisibilityScore != null);
	if (m.length < 5) return '';

	const byRating = new Map();
	for (const b of m) {
		const r = b.enrichment.fsa.ratingValue;
		if (!byRating.has(r)) byRating.set(r, []);
		byRating.get(r).push(b.digitalVisibilityScore);
	}
	const med = (a) => {
		const x = [...a].sort((p, q) => p - q); const i = x.length >> 1;
		return x.length % 2 ? x[i] : Math.round(((x[i - 1] + x[i]) / 2) * 10) / 10;
	};
	const rows = [...byRating.entries()]
		.sort((a, c) => String(c[0]).localeCompare(String(a[0])))
		.map(([r, v]) => `<tr><th scope="row">${esc(r)}</th><td class="pyc-pl-n">${v.length}</td><td class="pyc-pl-n">${med(v)}</td></tr>`)
		.join('');

	const top = m.filter((b) => b.enrichment.fsa.ratingNumeric === 5).map((b) => b.digitalVisibilityScore);
	const rest = m.filter((b) => b.enrichment.fsa.ratingNumeric !== null && b.enrichment.fsa.ratingNumeric < 5).map((b) => b.digitalVisibilityScore);
	const line = top.length >= 3 && rest.length >= 3
		? ` Firms rated 5 have a median Digital Visibility Score of ${med(top)}; those rated below 5, ${med(rest)}. On ${m.length} matched venues that is suggestive, not conclusive.`
		: '';

	return `## Food hygiene rating against digital visibility

<figure class="pyc-fig">
<figcaption>Food Standards Agency hygiene ratings, matched to ${m.length} of ${ranked.businesses.length} businesses on an exact registered name with the location corroborated by distance or local authority. The match rate is low by design: venues register under names that differ from the one they trade under, and an unmatched venue is left unmatched rather than guessed at.${line} Recorded alongside the measurement and carrying no weight in any score.</figcaption>
<table class="pyc-kv"><thead><tr><th scope="col">Hygiene rating</th><th scope="col" class="pyc-pl-n">Venues</th><th scope="col" class="pyc-pl-n">Median visibility score</th></tr></thead><tbody>${rows}</tbody></table>
</figure>
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
/* Lab against field: the same site, measured two ways.
 *
 * Lighthouse runs one throttled load on a datacentre machine. CrUX reports what
 * actual Chrome users experienced over 28 days. Across the businesses where we
 * hold both, the median lab LCP is seven times the real-user figure —
 * 11.9 seconds against 1.7 — and the two verdicts disagree for roughly a third
 * of sites.
 *
 * That matters commercially, because the lab number is the one most often put
 * in front of a business owner as evidence they need performance work. Where
 * field data exists it is the better evidence, and a business is entitled to
 * see both before being sold anything.
 *
 * Only rendered where BOTH exist. CrUX needs enough real traffic to report, so
 * the quieter sites have no field data and get nothing here rather than a
 * comparison against an absence. */
function labVsField(b) {
	const lh = b.enrichment?.lighthouse;
	const cx = b.enrichment?.crux;
	if (!lh || !cx || !cx.available) return '';
	const labLcp = lh.lcpMs, fieldLcp = cx.lcpMs;
	if (!Number.isFinite(labLcp) || !Number.isFinite(fieldLcp) || !fieldLcp) return '';

	const ratio = Math.round((labLcp / fieldLcp) * 10) / 10;
	const labSlow = typeof lh.performance === 'number' && lh.performance < 50;
	const fieldFail = cx.passesCwv === false;

	/* Name the metric that actually fails. The table above compares LCP, but the
	   pass/fail verdict is the whole Core Web Vitals set — so a site with a fast
	   real-user LCP and a layout-shift problem read as a flat contradiction:
	   "1.5s" directly above "real visitors are failing Core Web Vitals". */
	const failing = [
		cx.lcpGood === false && 'loading (LCP)',
		cx.inpGood === false && 'responsiveness (INP)',
		cx.clsGood === false && 'layout shift (CLS)',
	].filter(Boolean);
	const failingText = failing.length ? ` The metric failing for real users is ${failing.join(' and ')}.` : '';

	let verdict;
	if (labSlow && !fieldFail) {
		verdict = `The lab test rates this site poorly, but real visitors are not experiencing it that way — Core Web Vitals pass on field data. Treat a low lab score here as a lead to investigate, not a fault to pay to fix.`;
	} else if (!labSlow && fieldFail) {
		verdict = `The lab test looks acceptable while real visitors are failing Core Web Vitals. This is the more serious direction of disagreement: the problem is real and a one-off lab run is missing it.${failingText}`;
	} else if (fieldFail) {
		verdict = `Both agree there is a problem, and the field data confirms real visitors are affected. This is worth fixing.${failingText}`;
	} else {
		verdict = `Both agree the site is performing acceptably for real visitors.`;
	}

	const sec = (ms) => `${(ms / 1000).toFixed(1)}s`;
	return `<figure class="pyc-fig">
<figcaption>Largest Contentful Paint measured two ways: one throttled lab run, against 28 days of real Chrome users.</figcaption>
<table class="pyc-lab"><tbody>
<tr><th scope="row">Lab (Lighthouse, mobile)</th><td class="pyc-lab-n">${sec(labLcp)}</td><td>one throttled load on a datacentre machine</td></tr>
<tr><th scope="row">Field (real users)</th><td class="pyc-lab-n">${sec(fieldLcp)}</td><td>75th percentile of actual Chrome visitors over 28 days</td></tr>
</tbody></table>
<p class="pyc-takeaway">The lab figure is <strong>${ratio}\u00d7</strong> the real-user figure. ${esc(verdict)}</p>
</figure>`;
}

/* Hard failures, named, above the fold.
 *
 * A pillar score of 45 tells a business it is behind. It does not tell it that
 * its own robots.txt is instructing search engines to stay away — which is true
 * of 46 of the businesses in these indices, is free to fix, and was previously
 * knowable from the published dataset but stated nowhere on the page.
 *
 * Only unambiguous, checkable, actionable failures go here. Not "your score is
 * low": that is what the score is for. */
function problemsFound(b) {
	const t = b.evidence?.technical || {};
	const c = b.evidence?.content || {};
	const items = [];

	if (t.robotsAllowsIndexing === false) {
		items.push(['critical', 'Search engines are being told not to index this site',
			'The site\u2019s own robots.txt disallows crawling. Until that changes, nothing else on this page can help — the pages cannot enter the index in the first place.']);
	}
	if (t.indexable === false) {
		items.push(['critical', 'The homepage carries a noindex instruction',
			'A meta robots or X-Robots-Tag directive is asking search engines to leave this page out of results.']);
	}
	if (t.https === false) {
		items.push(['critical', 'The site is not served over HTTPS',
			'Browsers mark it as not secure, and it is a ranking signal in its own right.']);
	}
	if (t.hasSitemap === false) {
		items.push(['warning', 'No XML sitemap found',
			'Search engines have to discover every page by following links. On a small site that is survivable; on a large one it is not.']);
	}
	if (t.hasJsonLd === false) {
		items.push(['warning', 'No structured data on the homepage',
			'Nothing tells a search engine or an assistant what this business is, where it is, or what it does — in machine-readable terms.']);
	} else if (t.hasLocalBusinessSchema === false) {
		items.push(['warning', 'Structured data present, but no LocalBusiness markup',
			'The page describes something to machines, but not that it is a local business with an address and opening hours.']);
	}
	if (t.hasViewportMeta === false) {
		items.push(['warning', 'No mobile viewport tag',
			'The page is not telling phones how to lay itself out. Most local searches happen on one.']);
	}
	if (c.hasBlogLink === false && typeof c.wordCount === 'number' && c.wordCount < 400) {
		items.push(['warning', 'Very little published content',
			`The homepage carries ${c.wordCount} words and the site links to no blog, news or insights section. There is little here for a search engine to match, or for an assistant to quote.`]);
	}
	if (typeof c.contentFreshnessDays === 'number' && c.contentFreshnessDays > 730) {
		items.push(['note', 'The site has not changed in a long time',
			`The homepage last reported a change ${Math.round(c.contentFreshnessDays / 365 * 10) / 10} years ago.`]);
	}
	if (!items.length) return '';

	const label = { critical: 'Critical', warning: 'Worth fixing', note: 'Worth knowing' };
	const rows = items.map(([sev, head, body]) =>
		`<li class="pyc-prob pyc-prob-${sev}"><span class="pyc-prob-tag">${label[sev]}</span><b>${esc(head)}</b><span>${esc(body)}</span></li>`).join('');
	const crit = items.filter((i) => i[0] === 'critical').length;
	return `<figure class="pyc-fig">
<figcaption>${crit ? `${crit} critical ${crit === 1 ? 'problem' : 'problems'} found. ` : ''}These are specific, checkable faults on the site — not opinions about it.</figcaption>
<ul class="pyc-probs">${rows}</ul>
</figure>`;
}

/* The arithmetic behind each pillar, on the page. The project's central claim is
   that any published figure can be recomputed from the open data without
   trusting anyone; that is easier to believe with the components printed next
   to the number. */
function whyThisScore(b) {
	const c = b.evidence?.content || {};
	const l = b.evidence?.local || {};
	const ev = b.evidence || {};
	const yn = (v) => v === true ? 'yes' : v === false ? 'no' : '—';
	const rows = [];

	const contentBits = [
		`about page: ${yn(c.hasAboutLink)}`, `team page: ${yn(c.hasTeamLink)}`,
		`credentials: ${yn(c.hasCredentialsLink)}`, `blog or news: ${yn(c.hasBlogLink)}`,
	];
	if (typeof c.wordCount === 'number') contentBits.push(`homepage: ${c.wordCount.toLocaleString('en-GB')} words`);
	if (typeof c.contentFreshnessDays === 'number') contentBits.push(`last changed: ${c.contentFreshnessDays} days ago`);
	if (typeof b.pillarScores?.content === 'number') rows.push(['Content &amp; trust', b.pillarScores.content, contentBits]);

	if (typeof b.pillarScores?.visibility === 'number' && ev.keywordBasket?.length) {
		const bits = [`ranks for ${ev.rankedKeywords ?? 0} of ${ev.keywordBasket.length} keywords`];
		if (ev.avgPosition !== null && ev.avgPosition !== undefined) bits.push(`average position ${ev.avgPosition}`);
		if (ev.localPackAppearances !== null && ev.localPackAppearances !== undefined) bits.push(`local 3-pack: ${ev.localPackAppearances}`);
		rows.push(['Visibility', b.pillarScores.visibility, bits]);
	}

	if (typeof b.pillarScores?.local === 'number') {
		const bits = [];
		if (l.reviewCount !== null && l.reviewCount !== undefined) bits.push(`${l.reviewCount} reviews`);
		if (l.avgRating !== null && l.avgRating !== undefined) bits.push(`rated ${l.avgRating}`);
		if (l.reviewsLast90d !== null && l.reviewsLast90d !== undefined) bits.push(`${l.reviewsLast90d} new in 90 days`);
		if (bits.length) rows.push(['Local presence', b.pillarScores.local, bits]);
	}

	const t = b.evidence?.technical || {};
	if (typeof b.pillarScores?.technical === 'number' && Object.values(t).some((v) => v !== null)) {
		/* robots.txt is listed alongside the page-level noindex check on
		   purpose. They are different mechanisms and a site can pass one while
		   failing the other, which reads as a contradiction unless both are
		   shown: "indexable: yes" next to a critical robots warning is
		   confusing, "page allows indexing / robots.txt blocks it" is not. */
		rows.push(['Technical', b.pillarScores.technical, [
			`HTTPS: ${yn(t.https)}`,
			`page allows indexing: ${yn(t.indexable)}`,
			`robots.txt allows crawling: ${yn(t.robotsAllowsIndexing)}`,
			`sitemap: ${yn(t.hasSitemap)}`,
			`structured data: ${yn(t.hasJsonLd)}`,
		]]);
	}

	if (!rows.length) return '';
	const body = rows.map(([name, score, bits]) =>
		`<tr><th scope="row">${name}</th><td class="pyc-why-n">${score}</td><td>${bits.map(esc).join(' · ')}</td></tr>`).join('');
	return `<figure class="pyc-fig">
<figcaption>What each score is made of. Every input here is in the <a href="/indices/licence/">open dataset</a>, so the arithmetic can be checked rather than taken on trust.</figcaption>
<table class="pyc-why"><thead><tr><th scope="col">Pillar</th><th scope="col">Score</th><th scope="col">Made up of</th></tr></thead><tbody>${body}</tbody></table>
</figure>`;
}

/* What customers actually say, per Google's own topic extraction. The only
   qualitative signal in the index, and it was going unpublished. */
function reviewThemes(b) {
	const topics = b.enrichment?.gbpDetail?.placeTopics;
	if (!topics || typeof topics !== 'object') return '';
	const list = Object.entries(topics)
		.filter(([, n]) => typeof n === 'number' && n > 0)
		.sort((a, c) => c[1] - a[1])
		.slice(0, 10);
	if (list.length < 3) return '';
	const max = list[0][1];
	const rows = list.map(([topic, n]) =>
		`<li><span class="pyc-th-lab">${esc(topic)}</span><span class="pyc-th-bar" style="width:${Math.round((n / max) * 100)}%"></span><span class="pyc-th-n">${n}</span></li>`).join('');
	return `<figure class="pyc-fig">
<figcaption>Themes Google extracted from this business’s reviews, by how often customers raise them. Not scored — this is what people say, not how findable the business is.</figcaption>
<ul class="pyc-themes">${rows}</ul>
</figure>`;
}

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
	['Address matches website', (l.domainConsistent ?? l.napConsistent) === null ? null : ((l.domainConsistent ?? l.napConsistent) ? 'yes' : 'no')],
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

	/* Attach the label to its OWN mark.

	   Side-placing put "CJ Hole" (visibility 52) directly above Ocean Estate
	   Agents' dot (visibility 61, identical AI score), so the chart appeared to
	   name the wrong firm — the focus highlight was right and the label was not.

	   Centring the label over its own dot removes the ambiguity where there is
	   horizontal room, and a hairline leader ties label to mark either way. */
	const labels = placed.map(({ b, x, y }) => {
		const half = (b.name.length * 3.6 * 0.5) / 2;
		const above = y > PAD + 8;
		const ly = above ? y - 4.5 : y + 6;

		let el, lx;
		if (x - half >= 1 && x + half <= W - 1) {
			lx = x;
			el = `<text class="pyc-q-lab" data-pyc-firm="|${esc(b.slug)}|" x="${x.toFixed(2)}" y="${ly.toFixed(2)}" text-anchor="middle">${esc(b.name)}</text>`;
		} else {
			const pos = placeLabel(b.name, x, ly, { width: W, radius: 1.6 });
			if (!pos) return '';
			lx = pos.x;
			el = `<text class="pyc-q-lab" data-pyc-firm="|${esc(b.slug)}|" x="${pos.x}" y="${pos.y}" text-anchor="${pos.anchor}">${esc(b.name)}</text>`;
		}
		const leader = `<line class="pyc-q-leader" data-pyc-firm="|${esc(b.slug)}|" x1="${x.toFixed(2)}" y1="${(above ? y - 2 : y + 2).toFixed(2)}" x2="${lx.toFixed(2)}" y2="${(above ? ly + 1.2 : ly - 3).toFixed(2)}"/>`;
		return leader + el;
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
	function apply(slug, push, restoring) {
		current = slug;
		document.body.classList.toggle('pyc-focusing', !!slug);
		main.querySelectorAll('[data-pyc-firm]').forEach(function (el) {
			var on = !!slug && el.getAttribute('data-pyc-firm').indexOf('|' + slug + '|') !== -1;
			el.classList.toggle('pyc-on', on);
		});
		chips.querySelectorAll('button').forEach(function (b) {
			var on = b.dataset.slug === (slug || '');
			b.setAttribute('aria-pressed', String(on));
			// Scroll the chip row only. scrollIntoView walks every scrollable
			// ancestor including the viewport, so restoring a firm from the URL
			// scrolled the page past its own title. Only on restore, never on a
			// click — yanking the row under the cursor that just clicked is
			// disorienting.
			if (on && slug && restoring) {
				chips.scrollLeft = b.offsetLeft - (chips.clientWidth - b.offsetWidth) / 2;
			}
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
	apply(firms.some(function (f) { return f.s === want; }) ? want : null, false, true);
})();
</script>`;
}

/* Sortable league table.

   "Who is actually best at AI search?" is the question this table exists to
   answer and could not: the reader had to scan 18 rows of one column by eye.
   Sorting is the interaction the data asks for.

   Same contract as focusScript: the server renders the table in rank order,
   which is the ordering that matters most and the one a crawler or an answer
   engine sees. The script only upgrades the existing <th> into a button, so
   without JavaScript there is no dead control — just a table already sorted
   the right way.

   Two rules the sort must not break:
     - A firm with no score for a pillar sorts LAST in both directions, never
       as a zero. Missing data is not a bad score; the weighting already
       refuses to treat it as one, and the table must agree.
     - The rank badge keeps showing overall rank when sorted by a pillar. That
       is the point: seeing #14 at the top of the AI column is the finding. */
function sortScript() {
	return `<script>
(function () {
	var table = document.querySelector('.pyc-league');
	if (!table || !table.tBodies.length) return;
	var tbody = table.tBodies[0];
	var heads = Array.prototype.slice.call(table.querySelectorAll('th[data-sort]'));
	if (!heads.length) return;

	var rows = Array.prototype.slice.call(tbody.rows);
	var active = 'rank', dir = 1;
	var _sync = null;
	var status = null;

	// Column index per sort key, resolved once. Body rows and the header row
	// have the same cell count, so a header's position is its column.
	var colOf = {};
	heads.forEach(function (h) {
		colOf[h.dataset.sort] = Array.prototype.indexOf.call(h.parentNode.cells, h);
	});

	function valueAt(row, key) {
		var c = row.cells[colOf[key]];
		if (!c) return null;
		var v = c.getAttribute('data-v');
		return v === null ? null : Number(v);
	}

	function apply(key, direction, push) {
		active = key; dir = direction;
		var sorted;
		if (key === 'rank' && direction === 1) {
			sorted = rows.slice();
		} else {
			sorted = rows.slice().sort(function (a, b) {
				var av = valueAt(a, key), bv = valueAt(b, key);
				// Unmeasured always last, whichever way the column is pointing.
				if (av === null && bv === null) return 0;
				if (av === null) return 1;
				if (bv === null) return -1;
				return (av - bv) * direction;
			});
		}
		sorted.forEach(function (r) { tbody.appendChild(r); });

		heads.forEach(function (h) {
			var on = h.dataset.sort === key;
			h.setAttribute('aria-sort', on ? (direction === 1 ? 'ascending' : 'descending') : 'none');
			h.classList.toggle('pyc-lg-sorted', on);
			var btn = h.querySelector('button');
			if (btn) btn.dataset.dir = on ? (direction === 1 ? 'up' : 'down') : '';
		});

		if (_sync) _sync(key, direction);
		/* Below 46rem the table is restacked with display:block, which drops the
		   implicit table roles and removes the headers from the a11y tree — so
		   aria-sort conveys nothing exactly where the select is the only
		   control. A live region states the sort in words instead. */
		if (status) {
			var hName = '';
			heads.forEach(function (h) {
				if (h.dataset.sort !== key) return;
				var a = h.querySelector('abbr');
				hName = (a && a.getAttribute('title')) || h.getAttribute('title') || h.textContent.trim();
			});
			status.textContent = key === 'rank' && direction === 1
				? 'Sorted by rank, best first.'
				: 'Sorted by ' + hName + ', ' + (direction === 1 ? 'lowest' : 'highest') + ' first.';
		}

		if (push && window.history && history.replaceState) {
			var u = new URL(location.href);
			// Always explicit. A bare key used to mean "ascending" on write and
			// "descending" on read, so sorting a column ascending and sharing
			// the URL handed someone the opposite order.
			if (key === 'rank' && direction === 1) u.searchParams.delete('sort');
			else u.searchParams.set('sort', key + (direction === 1 ? '.asc' : '.desc'));
			history.replaceState(null, '', u);
		}
	}

	heads.forEach(function (h) {
		var key = h.dataset.sort;
		var abbr = h.querySelector('abbr');
		var label = (abbr && abbr.getAttribute('title')) || h.getAttribute('title') || h.textContent.trim();
		var btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'pyc-lg-sort';
		// Keep the abbr (and its title) rather than flattening to text.
		while (h.firstChild) btn.appendChild(h.firstChild);
		btn.setAttribute('aria-label', 'Sort by ' + label);
		h.appendChild(btn);
		btn.addEventListener('click', function () {
			// Scores read best high-to-low; rank reads best low-to-high.
			var firstDir = key === 'rank' ? 1 : -1;
			apply(key, active === key ? -dir : firstDir, true);
		});
	});

	/* On a phone the table restacks as cards and <thead> is display:none, so the
	   header buttons disappear exactly where scanning a column by eye is
	   hardest.

	   A second chip row was the obvious answer and the wrong one: this page
	   already has one (focus a firm), and two rows of identical chips a figure
	   apart, doing different things, is a puzzle rather than a control. A
	   native select is unmistakably not the focus chips, opens the platform
	   picker, and costs no layout.

	   It sorts descending only. Direction toggling is a desktop refinement; on
	   a phone the question is "who is best at this", and one tap answers it. */
	var bar = document.createElement('div');
	bar.className = 'pyc-sortbar';
	// One league table per page, so a fixed id is unique by construction and
	// avoids a generated one that would differ between renders.
	var id = 'pyc-sort-select';
	var lab = document.createElement('label');
	lab.className = 'pyc-sortbar-label';
	lab.setAttribute('for', id);
	lab.textContent = 'Sort by';
	var sel = document.createElement('select');
	sel.className = 'pyc-sortsel';
	sel.id = id;

	/* Both directions, in two groups.

	   A single "highest first" option per column could not express a table the
	   desktop headers had put in ascending order, so narrowing the window left
	   the select describing the opposite of what was on screen — and re-picking
	   the same option fires no change event, so there was no way back except
	   Rank. Every state the table can hold is now selectable.

	   Ascending is not filler here: "who is weakest on AI" is the view that
	   says who needs the work. */
	function nameOf(h) {
		var a = h.querySelector('abbr');
		return (a && a.getAttribute('title')) || h.getAttribute('title') || h.textContent.trim();
	}
	var rankHead = null;
	heads.forEach(function (h) { if (h.dataset.sort === 'rank') rankHead = h; });
	if (rankHead) {
		var ro = document.createElement('option');
		ro.value = 'rank.asc';
		ro.textContent = 'Rank (default)';
		sel.appendChild(ro);
	}
	[['desc', 'Highest first'], ['asc', 'Lowest first']].forEach(function (pair) {
		var g = document.createElement('optgroup');
		g.label = pair[1];
		heads.forEach(function (h) {
			if (h.dataset.sort === 'rank') return;
			var o = document.createElement('option');
			o.value = h.dataset.sort + '.' + pair[0];
			o.textContent = nameOf(h);
			g.appendChild(o);
		});
		sel.appendChild(g);
	});
	sel.addEventListener('change', function () {
		var p = sel.value.split('.');
		apply(p[0], p[1] === 'asc' ? 1 : -1, true);
	});
	bar.appendChild(lab);
	bar.appendChild(sel);
	table.parentNode.insertBefore(bar, table);

	status = document.createElement('p');
	status.className = 'pyc-sr';
	status.setAttribute('role', 'status');
	status.setAttribute('aria-live', 'polite');
	table.parentNode.insertBefore(status, table);

	_sync = function (key, direction) {
		sel.value = key + (direction === 1 ? '.asc' : '.desc');
	};

	table.classList.add('pyc-league-sortable');

	var want = new URL(location.href).searchParams.get('sort');
	var restored = false;
	if (want) {
		var parts = want.split('.');
		if (heads.some(function (h) { return h.dataset.sort === parts[0]; })) {
			// Unsuffixed keys are still honoured for links shared before the
			// suffix existed: fall back to each column's natural direction.
			var d = parts[1] === 'asc' ? 1 : parts[1] === 'desc' ? -1 : (parts[0] === 'rank' ? 1 : -1);
			apply(parts[0], d, false);
			restored = true;
		}
	}
	// Without this the rank column is the active sort but carries no accent or
	// caret, while the select already reads "Rank". Both now agree on load.
	if (!restored) apply('rank', 1, false);
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


/* Distances are collected and computed in kilometres — the latitude/longitude
   maths needs them — but this is a UK site read by UK businesses, so every
   figure a reader sees is in miles. One conversion, at the display layer. */
const MILES_PER_KM = 0.621371;
const miles = (km, dp = 1) => {
	const m = km * MILES_PER_KM;
	// Whole numbers read better than "4.0 miles".
	return Number.isInteger(Number(m.toFixed(dp))) ? String(Math.round(m)) : m.toFixed(dp);
};

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
		return `<p class="pyc-geo-null">Searching &ldquo;${esc(g.keyword)}&rdquo; from ${g.points.length} points across a ${miles(g.radiusKm * 2)}-mile square, <strong>not one of the ${ranked.businesses.length} firms in this index appeared in the local 3-pack at any location</strong>. The pack was held entirely by businesses outside the index.</p>`;
	}

	/* The figure says "across the city" but rendered nine anonymous squares: a
	   reader could not tell which cell was Clifton and which was Brislington.
	   The coordinates were collected all along, so each cell now carries its
	   compass position and its actual lat/lng, and the figure gets a north
	   marker and a scale bar. That is what makes it a map — not tiles, which
	   would need client JS and put the data out of reach of the crawlers this
	   index is written for. */
	/* Compass names only work on a 3x3, where every cell is an edge or the
	   middle. At the documented size 5 the nine names collapse — sixteen of
	   twenty-five cells would read "centre" or share an edge name — so anything
	   larger falls back to a grid reference, which stays unique at any size. */
	const useCompass = n === 3;
	const compass = (r, c) => {
		const ns = r === 0 ? 'north' : r === n - 1 ? 'south' : '';
		const ew = c === 0 ? 'west' : c === n - 1 ? 'east' : '';
		if (!ns && !ew) return 'centre';
		if (!ns) return ew;
		if (!ew) return ns;
		return `${ns}-${ew}`;
	};
	const abbrev = { 'north-west': 'NW', north: 'N', 'north-east': 'NE', west: 'W', centre: '·', east: 'E', 'south-west': 'SW', south: 'S', 'south-east': 'SE' };
	const ref = (r, c) => `${String.fromCharCode(65 + c)}${r + 1}`;
	const where = (r, c) => useCompass ? compass(r, c) : ref(r, c);
	const shortWhere = (r, c) => useCompass ? (abbrev[compass(r, c)] || compass(r, c)) : ref(r, c);

	const cells = [];
	for (let r = 0; r < n; r++) {
		const row = [];
		for (let c = 0; c < n; c++) {
			const firms = firmsAt.get(`${r}:${c}`);
			const pt = g.points.find((p) => p.row === r && p.col === c);
			const place = where(r, c);
			const cls = firms === null ? 'x' : String(Math.min(firms.length, 3));
			const coords = pt ? `${pt.lat.toFixed(3)}, ${pt.lng.toFixed(3)}` : '';
			const who = firms === null
				? 'no result at this point'
				: firms.length ? firms.map((f) => f.name).join(', ') : 'no indexed firm in the pack here';
			/* title is invisible on touch and unreachable by keyboard, and the
			   coordinates are the one thing with no other route to them — so the
			   full reading also goes in visually-hidden text inside the cell. */
			row.push(`<td class="pyc-geo-${cls}" title="${esc(place)} (${esc(coords)}) — ${esc(who)}">`
				+ `<span class="pyc-geo-n">${firms && firms.length ? firms.length : ''}</span>`
				+ `<span class="pyc-geo-where">${esc(shortWhere(r, c))}</span>`
				+ `<span class="pyc-sr">${esc(place)}${coords ? `, ${esc(coords)}` : ''} — ${esc(who)}</span>`
				+ `</td>`);
		}
		cells.push(`<tr>${row.join('')}</tr>`);
	}

	const distinct = new Set([...firmsAt.values()].filter(Boolean).flat().map((f) => f.name));
	return `<figure class="pyc-fig">
<figcaption>Local 3-pack for &ldquo;${esc(g.keyword)}&rdquo; searched from ${g.points.length} points on a ${n}&times;${n} grid across a ${miles(g.radiusKm * 2)}-mile square centred on ${g.centre ? `${g.centre.lat.toFixed(3)}, ${g.centre.lng.toFixed(3)}` : 'the city'}. North is up; each cell names its position and carries its coordinates and the firms found there. Each cell counts how many indexed firms hold a pack slot at that location; a chain counts wherever any of its branches appears. ${covered} of ${g.points.length} points contain at least one indexed firm, and ${distinct.size} of the ${ranked.businesses.length} indexed firms appear somewhere on the grid.</figcaption>
<div class="pyc-geo-wrap">
<span class="pyc-geo-north" aria-hidden="true">N &uarr;</span>
<table class="pyc-geo"><caption class="pyc-sr">Indexed firms holding a local pack slot, by grid position from north-west to south-east</caption>${cells.join('')}</table>
<span class="pyc-geo-scale" aria-hidden="true"><i></i>${miles((2 * g.radiusKm) / Math.max(1, n - 1))} miles between points</span>
</div>
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
	const date = new Date(ranked.measuredAt ?? ranked.scoredAt).toISOString();
	const human = humanDate(ranked.measuredAt ?? ranked.scoredAt);
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

	/* data-sort marks a column as sortable and names it. The header stays a
	   plain <th> in the HTML — the script upgrades it to a button, so without
	   JavaScript there is no dead control, only a table already ordered by
	   rank, which is the order that matters most. */
	const leagueHead = '<tr>'
		+ '<th scope="col" class="pyc-lg-rank" data-sort="rank" title="Rank" aria-sort="ascending">#</th>'
		+ `<th scope="col" class="pyc-lg-name">${esc(idxTitle)}</th>`
		+ '<th scope="col" class="pyc-lg-score" data-sort="score" title="Digital Visibility Score">Score</th>'
		+ PILLARS.map((p) => `<th scope="col" class="pyc-lg-p" data-sort="${esc(p.key)}"><abbr title="${esc(p.label)}">${esc(SHORT[p.key] || p.label)}</abbr></th>`).join('')
		+ '</tr>';

	/* data-label carries the column name onto each cell so the table can restack
	   as cards on a phone without JavaScript and without losing what each number
	   means. Nine columns cannot fit 340px of content width, and dropping the
	   pillars that discriminate most would be the wrong half to lose.

	   data-v carries the numeric value for sorting. A missing pillar gets no
	   data-v at all rather than a zero: an unmeasured firm must never sort as
	   though it scored nothing, which is the same rule the weighting follows. */
	const sortAttr = (v) => (typeof v === 'number' ? ` data-v="${v}"` : '');
	const leagueBody = scored.map((b) => `<tr data-pyc-firm="|${esc(b.slug)}|">`
		+ `<td class="pyc-lg-rank" data-label="Rank" data-v="${b.rank}">${b.rank}</td>`
		+ `<th scope="row" class="pyc-lg-name"><a href="/indices/${esc(indexSlug)}/${esc(b.slug)}/">${esc(b.name)}</a></th>`
		+ `<td class="pyc-lg-score" data-label="Score"${sortAttr(b.digitalVisibilityScore)}>${cell(b.digitalVisibilityScore)}</td>`
		+ PILLARS.map((p) => `<td class="pyc-lg-p" data-label="${esc(SHORT[p.key] || p.label)}"${sortAttr(b.pillarScores[p.key])}>${cell(b.pillarScores[p.key])}</td>`).join('')
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
		/* Reference the site-wide Organization node by @id rather than declaring a
		   second one. The generated pages previously minted an Organization named
		   "Phil Yarrow Consulting (PYC)" while astro.config.mjs declared one named
		   "PYC Hub" — two unlinked entities, so the index's authority accrued to
		   neither. sameAs points at the domain the work is meant to credit. */
		creator: { '@id': `${SITE}/#org` },
		publisher: { '@id': `${SITE}/#org` },
		license: LICENCE.url,
		usageInfo: LICENCE.terms,
		isAccessibleForFree: true,
		copyrightHolder: { '@id': `${SITE}/#phil` },
		copyrightYear: new Date(ranked.measuredAt ?? ranked.scoredAt).getUTCFullYear(),
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
${hygieneCrossCheck(ranked)}
${registryMix(ranked)}
## Which ${idxTitle.toLowerCase()} has the best website?

${scored.length ? `${scored[0].name} tops the ${quarter} index with a Digital Visibility Score of ${scored[0].digitalVisibilityScore}/100.` : ''} Each firm has a full diagnostic scorecard linked from the table above.

## How this is measured

Every score follows the same six-pillar [methodology](/indices/methodology/): [Speed & Core Web Vitals](${kbHref('speed')}) (20%), [Technical foundation](${kbHref('technical')}) (20%), [Local presence](${kbHref('local')}) (20%), [Visibility](${kbHref('visibility')}) (15%), [AI search presence](${kbHref('ai')}) (15%) and [Content & trust](${kbHref('content')}) (10%). Each pillar links to the knowledge-base article that explains what it measures; the [statistical methods](/glossary/) behind the scoring are written up separately.${cov.partial ? ` **This ${quarter} release (v0) measures ${cov.live.length} of those ${PILLARS.length} pillars** — ${cov.liveLabels.join(' and ')} — with weights renormalised to ${cov.weightLine}. The remaining pillars are added in a later refresh.` : ''} Download the full dataset: [JSON](/data/${indexSlug}.json) · [CSV](/data/${indexSlug}.csv).

## Who publishes this

The index is compiled and published by [PYC](https://pyc.agency/), a search consultancy run by [Phil Yarrow](https://pyc.agency/about/). It exists because the questions it answers — who is actually visible in a local market, and by how much — were being answered with opinion. The collection and scoring code is [open source](https://github.com/philyarrow/local-digital-visibility-index), so any figure here can be recomputed rather than taken on trust.

Related reading on the practice behind the measurements: [topical authority](https://pyc.agency/guides/topical-authority/), [generative engine optimisation](https://pyc.agency/guides/generative-engine-optimization/), and [case studies](https://pyc.agency/proof/) from comparable service businesses.

## Using this data

This dataset is published under [${LICENCE.name}](${LICENCE.url}). You may reuse it, including commercially and in AI-generated answers, **provided you credit ${LICENCE.holder} by name and link back**. That credit is a condition of use, not a courtesy.

> ${attributionRequired()}

That one credit covers every dataset on this site — one figure or all of them. When quoting this particular dataset precisely, the fuller form is:

> ${citationFor(indexSlug, quarter)}

Full terms: [licence and attribution](/indices/licence/).

Spotted an error? [Request a correction](mailto:info@philyarrow.co.uk?subject=Correction:%20${encodeURIComponent(idxTitle)}%20Index).

<script type="application/ld+json">${JSON.stringify(dataset)}</script>
<script type="application/ld+json">${JSON.stringify(itemList)}</script>
${focusScript(ranked, indexSlug)}
${sortScript()}
`;
}

/* ---- exports ---- */

function exportJson(ranked, quarter, indexSlug, cfg = null, sectorCfg = null) {
	return {
		index: indexSlug,
		title: `PYC ${indexTitle(indexSlug)} Digital Visibility Index`,
		/* Town, sector and basket size stated rather than left to be parsed out
		   of the slug. The site was splitting on the first hyphen, which turns
		   "weston-super-mare-dentists" into the town "weston" and the sector
		   "super-mare-dentists" — a spurious row and column in any grid built
		   from it. The keyword count is exported for the same reason: published
		   analysis was asserting "twelve keywords" while the basket size is
		   per-index configurable. */
		town: cfg?.town ?? null,
		sector: cfg?.sector ?? null,
		sectorLabel: sectorCfg?.label ?? null,
		keywordsPerIndex: ranked.businesses?.[0]?.evidence?.keywordBasket?.length ?? null,
		quarter,
		/* measuredAt only. scoredAt is wall-clock at the scoring run, so
		   publishing it would churn the dated snapshot on every no-op
		   regeneration — the same defect in miniature. It stays in the
		   internal _ranked.json for provenance. */
		measuredAt: ranked.measuredAt ?? ranked.scoredAt,
		/* Who actually holds the first page. Collected since launch, rendered on
		   the index page, and until now not exported — so the site could draw
		   the chart but nothing else could use the numbers. It is the single
		   most useful thing for answering "why is my business not showing up":
		   in most of these sectors the majority of page-one slots belong to
		   directories and national chains rather than to any local firm, and a
		   business told to "rank higher" is being pointed at a contest it is
		   not actually in. Top domains are capped at ten; the full landscape
		   stays in the pipeline's own snapshot. */
		landscape: ranked.landscape ? {
			measuredKeywords: ranked.landscape.measuredKeywords ?? null,
			slotsAvailable: ranked.landscape.summary?.slotsAvailable ?? null,
			heldBySeed: ranked.landscape.summary?.heldBySeed ?? null,
			heldByOthers: ranked.landscape.summary?.heldByOthers ?? null,
			seedSharePct: ranked.landscape.summary?.seedSharePct ?? null,
			distinctDomains: ranked.landscape.summary?.distinctDomains ?? null,
			topDomains: (ranked.landscape.topDomains || []).slice(0, 10).map((d) => ({
				domain: d.domain,
				inSeed: d.inSeed === true,
				top10Slots: d.top10Slots ?? null,
				bestPosition: d.bestPosition ?? null,
			})),
		} : null,
		methodology: `${SITE}/indices/methodology/`,
		license: { name: LICENCE.name, url: LICENCE.url, terms: LICENCE.terms },
		attribution: attributionRequired(),
		citation: citationFor(indexSlug, quarter),
		attributionNote: 'Reuse of ANY data from this index — a single figure, one dataset, '
			+ 'several, or all of them — requires the `attribution` credit above, reproduced and '
			+ 'linked. `citation` is the fuller form for quoting this particular dataset. Reuse is '
			+ 'permitted commercially and in AI-generated answers on that condition.',
		weights: ranked.weights,
		pillarCoverage: ranked.pillarCoverage,
		overallMedian: ranked.overallMedian ?? null,
		/* Weights are renormalised PER BUSINESS around whatever that business
		   could be measured on, so there is no single index-level set. Publishing
		   businesses[0]'s as if there were made the dataset unreproducible for
		   every row with a different coverage shape. */
		contextNote: 'The `context` block on each business is recorded alongside the '
			+ 'measurement and carries NO weight in the Digital Visibility Score. See '
			+ `${SITE}/indices/methodology/.`,
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
			/* Published so the homepage-link analysis on the blog is
			   reproducible from this file, as that piece states it is. */
			contentChecks: b.evidence?.content ?? null,
			/* The identifiers behind the scorecard's sameAs claims. Exported because a
			   page must not assert anything the dated snapshot cannot reproduce — the
			   entity identification is now part of what is published, so it has to be
			   checkable from the open data like every score is. */
			localMatch: b.evidence?.local
				? { placeId: b.evidence.local.placeId ?? null, matchedBy: b.evidence.local.matchedBy ?? null }
				: null,
			/* The scorecard publishes a Companies House number, a CrUX reading
			   and crawl metrics. The dated snapshot is this project's receipt
			   for what was published, so anything asserted on a page has to be
			   reproducible from it — otherwise the page makes claims the open
			   data cannot support. Unscored, and labelled as such. */
			context: b.enrichment ?? null,
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

/* An unrecognised --flag used to be swallowed, so a typo'd or imagined flag
   ran a full generation while the operator believed something else happened.
   Fail loudly instead. */
function parseArgs(argv) {
	const args = { indexSlug: null, quarter: null };
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--quarter') args.quarter = argv[++i];
		else if (VALUE_FLAGS.has(a)) i++; // consumed elsewhere; skip its value
		else if (a === '--check-bridges' || a === '--archive-only') continue; // handled in main()
		else if (a.startsWith('--')) {
			console.error(`Unknown flag: ${a}`);
			process.exit(1);
		}
		else if (!args.indexSlug) args.indexSlug = a;
	}
	return args;
}

function defaultQuarter() {
	const now = new Date();
	const q = Math.floor(now.getMonth() / 3) + 1;
	return `Q${q}-${now.getFullYear()}`;
}

/* Validate every bridge slug against the site's content tree. Exits non-zero on
   the first missing target. Writes nothing — safe to run before a real
   generation, and the only thing standing between a renamed KB article and 79
   simultaneous 404s. */
async function checkBridges(siteRoot) {
	const docs = join(siteRoot, 'new', 'src', 'content', 'docs');
	const targets = [
		...Object.entries(PILLAR_KB).map(([k, slug]) => [k, join(docs, 'kb', `${slug}.md`), `/kb/${slug}/`]),
		...Object.entries(PILLAR_METHOD).map(([k, slug]) => [k, join(docs, 'glossary', `${slug}.md`), `/glossary/${slug}/`]),
	];

	const missing = [];
	for (const [pillar, file, href] of targets) {
		try {
			await readFile(file);
		} catch {
			missing.push(`  ${pillar.padEnd(11)} ${href}`);
		}
	}

	const noTarget = Object.entries(PILLAR_AGENCY).filter(([, v]) => !v).map(([k]) => k);
	if (noTarget.length) console.log(`no agency target (intentional): ${noTarget.join(', ')}`);

	if (missing.length) {
		console.error(`${missing.length} bridge target(s) missing from ${docs}:`);
		console.error(missing.join('\n'));
		process.exitCode = 1;
		return false;
	}
	console.log(`all ${targets.length} bridge targets resolve under ${docs}`);
	return true;
}

async function main() {
	/* Validation mode: check the bridge maps and exit without writing. Placed
	   before the index-slug requirement so it can be run on its own. */
	if (process.argv.includes('--check-bridges')) {
		await checkBridges(SITE_ROOT);
		return;
	}

	const { indexSlug, quarter: qArg } = parseArgs(process.argv);
	if (!indexSlug) {
		console.error('Usage: node generate.mjs <index-slug> [--quarter Q2-2026]');
		process.exit(1);
	}
	const quarter = qArg || defaultQuarter();
	const rankedFile = join(DATA_ROOT, indexSlug, '_ranked.json');

	/* Index and sector config, so the exported dataset can state its own town
	   and sector instead of leaving the site to parse them out of the slug. */
	let indexCfg = null, sectorCfg = null;
	try {
		const indices = JSON.parse(await readFile(join(HERE, 'config', 'indices.json'), 'utf8'));
		indexCfg = indices[indexSlug] ?? null;
		if (indexCfg?.sector) {
			const sectors = JSON.parse(await readFile(join(HERE, 'config', 'sectors.json'), 'utf8'));
			sectorCfg = sectors[indexCfg.sector] ?? null;
		}
	} catch (e) {
		/* Config is a convenience here, not a requirement: the dataset still
		   generates, it just cannot state its own town. */
		console.warn(`Could not read config for ${indexSlug}: ${e.message}`);
	}

	let ranked;
	try {
		ranked = JSON.parse(await readFile(rankedFile, 'utf8'));
	} catch (e) {
		console.error(`Cannot read ${rankedFile}: ${e.message}`);
		console.error('Run score.mjs first: node score.mjs ' + indexSlug);
		process.exit(1);
	}

	/* Archive mode: write a dated interim measurement and stop.

	   Monthly collection exists to build the time series that quarter-on-quarter
	   comparison and the statistical methods in the glossary actually need — you
	   cannot run ANOVA on one data point. But a monthly measurement is NOT a
	   published ranking, and it must never overwrite `<quarter>.json`: that file
	   is the receipt for what the site published, and freezing it is the whole
	   reason it exists.

	   So interim runs land in data/<index>/history/<YYYY-MM>.json, carry
	   status: "interim", and say in the file that they are not the ranking. */
	if (ARCHIVE_ONLY) {
		const period = new Date(ranked.measuredAt ?? ranked.scoredAt).toISOString().slice(0, 7);
		const payload = {
			...exportJson(ranked, quarter, indexSlug, indexCfg, sectorCfg),
			status: 'interim',
			period,
			statusNote:
				'Interim monthly measurement, not a published ranking. The published index for '
				+ `this quarter is data/${indexSlug}/${quarter.toLowerCase()}.json and on the site at `
				+ `${SITE}/indices/${indexSlug}/. Interim files exist so movement over time can be `
				+ 'analysed; they are not editorially reviewed and firms are not ranked on them.',
		};
		const historyDir = join(SNAPSHOT_ROOT, indexSlug, 'history');
		await mkdir(historyDir, { recursive: true });
		await writeFile(join(historyDir, `${period}.json`), JSON.stringify(payload, null, 2) + '\n');
		await writeFile(join(historyDir, `${period}.csv`), exportCsv(ranked));
		console.log(`Archived interim measurement to data/${indexSlug}/history/${period}.{json,csv}`);
		return;
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
	/* Stale-scorecard tripwire.
	 *
	 * This generator writes and never prunes, so a business dropped from a seed
	 * leaves its scorecard behind permanently — live, canonical, in the sitemap,
	 * and publishing a rank against a cohort size that no longer exists. Three
	 * Cheltenham venues sat that way for two days after being removed from the
	 * Gloucester restaurant index, one of them showing 23/100 for a named real
	 * business on a page asserting every figure is reproducible from a dataset
	 * that no longer contained it.
	 *
	 * It WARNS rather than deletes, deliberately. Deleting would drop a live URL
	 * with no redirect, which is the one rule CLAUDE.md states flatly — and this
	 * script cannot know what the right redirect target is. Retiring a scorecard
	 * is an editorial decision with a redirect attached, not a cleanup step. */
	try {
		const present = (await readdir(contentDir))
			.filter((f) => f.endsWith('.md') && f !== 'index.md')
			.map((f) => f.replace(/\.md$/, ''));
		const current = new Set(ranked.businesses.map((b) => b.slug));
		const stale = present.filter((slug) => !current.has(slug));
		if (stale.length) {
			console.warn(
				`\n  ! ${stale.length} stale scorecard(s) in ${indexSlug} — not in this index any more:\n`
				+ stale.map((s2) => `      ${s2}`).join('\n')
				+ `\n    They are still live and in the sitemap. Retire them: delete the .md and add a`
				+ `\n    301 to new/public/_redirects by hand. Do NOT run scripts/build-redirects.mjs —`
				+ `\n    it overwrites that file and drops every hand-added rule.\n`,
			);
		}
	} catch { /* a first run has no content dir yet; nothing to compare against */ }

	// exports — the site's "latest" copy, overwritten each quarter
	const json = JSON.stringify(exportJson(ranked, quarter, indexSlug, indexCfg, sectorCfg), null, 2) + '\n';
	const csv = exportCsv(ranked);
	await writeFile(join(PUBLIC_DATA, `${indexSlug}.json`), json);
	await writeFile(join(PUBLIC_DATA, `${indexSlug}.csv`), csv);
	/* The CSV stays strictly parseable — a comment line would break strict
	   readers — so the terms travel beside it rather than inside it. */
	await writeFile(join(PUBLIC_DATA, `${indexSlug}.LICENCE.txt`),
		`REQUIRED CREDIT — covers any use of any data from this index:\n\n`
		+ `    ${attributionRequired()}\n\n`
		+ `CITATION for this particular dataset:\n\n`
		+ `    ${citationFor(indexSlug, quarter)}\n\n`
		+ `Licence: ${LICENCE.name} — ${LICENCE.url}\n`
		+ `Terms:   ${LICENCE.terms}\n\n`
		+ `Reuse is permitted, including commercially and in AI-generated answers,\n`
		+ `provided the required credit above is reproduced and linked.\n`);

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
