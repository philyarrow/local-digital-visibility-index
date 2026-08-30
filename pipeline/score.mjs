/* score.mjs — Local Digital Visibility Index scorer.

   Reads every per-business JSON for an index, converts each pillar's raw
   signals into a 0-100 pillar score, applies the EXACT six-pillar weights from
   the published methodology, computes the weighted Digital Visibility Score,
   ranks the businesses, and computes sector medians per pillar.

   Writes: pipeline/data/<index-slug>/_ranked.json

   Usage:
     node score.mjs <index-slug>
     node score.mjs bristol-estate-agents

   Weights (must match new/src/content/docs/indices/methodology.md):
     Speed & CWV 20 | Technical 20 | Local 20 | Visibility 15 | AI 15 | Content 10

   HANDLING STUBBED / NULL PILLARS:
     A pillar whose score is null (because its data source is stubbed, or
     collection failed for that business) is EXCLUDED from that business's
     weighting, and the remaining pillar weights are RE-NORMALISED to sum to
     100. Rationale: scoring an unmeasured pillar 0 would unfairly punish every
     business equally and make the Digital Visibility Score meaningless while
     Local/Visibility/AI are stubbed. Renormalising keeps the score on a true
     0-100 scale built only from what was actually measured. Each business
     record reports which pillars were `included` and the `effectiveWeights`
     used, so the score is fully reproducible.
*/

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PILLARS, clamp100, median } from './lib/common.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = join(HERE, 'data');

/* -------------------------------------------------------------------------- */
/* Pillar scorers: raw signals -> 0-100 (or null if not measurable)           */
/* -------------------------------------------------------------------------- */

/* Speed & CWV — blend Lighthouse mobile perf score with CrUX CWV pass/fail. */
function scoreSpeed(p) {
	if (!p || p.stub) return null;
	let labScore = typeof p.mobilePerformanceScore === 'number' ? p.mobilePerformanceScore : null;

	// CWV threshold bonus/penalty when field (CrUX) thresholds are known.
	let cwvScore = null;
	const lcp = p.lcpMs, inp = p.inpMs, cls = p.cls;
	const parts = [];
	if (typeof lcp === 'number') parts.push(lcp <= 2500 ? 100 : lcp <= 4000 ? 60 : 20);
	if (typeof inp === 'number') parts.push(inp <= 200 ? 100 : inp <= 500 ? 60 : 20);
	if (typeof cls === 'number') parts.push(cls <= 0.1 ? 100 : cls <= 0.25 ? 60 : 20);
	if (parts.length) cwvScore = parts.reduce((a, b) => a + b, 0) / parts.length;

	if (labScore !== null && cwvScore !== null) return clamp100(Math.round(labScore * 0.6 + cwvScore * 0.4));
	if (labScore !== null) return clamp100(labScore);
	if (cwvScore !== null) return clamp100(Math.round(cwvScore));
	return null;
}

/* Technical — equal-weight checklist of the measured boolean signals. */
function scoreTechnical(p) {
	if (!p || p.stub) return null;
	const checks = [
		p.https,
		p.hasJsonLd,
		p.hasLocalBusinessSchema,
		p.hasViewportMeta,
		p.indexable,
		p.hasSitemap,
		p.hasRobotsTxt,
		p.robotsAllowsIndexing,
	];
	const known = checks.filter((c) => typeof c === 'boolean');
	if (!known.length) return null;
	const passed = known.filter(Boolean).length;
	return clamp100(Math.round((passed / known.length) * 100));
}

/* Local presence — live. Google Business Profile completeness, review volume
   and recency, NAP consistency and local-pack coverage, from DataForSEO's
   business_data endpoints. */
/* Review velocity is scored against the cohort, not against an absolute.
 *
 * The absolute version (min(100, velocity * 10)) treated ten new reviews in
 * ninety days as full marks for everyone. That is routine for a restaurant and
 * exceptional for a solicitor, so the component was largely measuring which
 * trade a business is in. Correcting the underlying count on 30 August made it
 * worse, not better: it lifted restaurants and estate agents and left
 * construction and accountancy untouched, widening the gap between them from
 * 15 points to 31.
 *
 * `ref` is the cohort's 90th percentile, floored at 3 so a tiny cohort cannot
 * produce a reference of 1 where a single review scores full marks.
 *
 * `ref === null` means the cohort is degenerate — see cohortVelocityRef. */
function velocityScore(v, ref) {
	if (typeof v !== 'number' || ref === null) return null;
	return clamp100(Math.min(100, (v / ref) * 100));
}

/* The reference for one index, or null when velocity cannot discriminate in it.
 *
 * When three quarters of a cohort sit at zero — 83% of Cheltenham builders,
 * 88% of Gloucester accountants — there is no distribution to normalise
 * against. Scaling to the cohort maximum would score a builder with three
 * reviews at 100 and forty-three builders at 0, manufacturing a hundred-point
 * spread out of a nought-to-three range. Percentile rank is worse: the tied
 * zeros take a midrank near the 41st percentile, so a business would be
 * REWARDED for having no reviews at all.
 *
 * So the component is excluded for that cohort and the Local pillar is computed
 * from its remaining parts. This is the same rule the rest of the pipeline
 * follows — a signal that cannot be measured is left out, never scored as zero.
 * A builder is not digitally weak for working in a trade whose customers do not
 * leave Google reviews. */
function cohortVelocityRef(records) {
	const v = records
		.map((r) => r?.pillars?.local?.reviewsLast90d)
		.filter((x) => typeof x === 'number')
		.sort((a, b) => a - b);
	if (v.length < 4) return null;
	const at = (q) => v[Math.min(v.length - 1, Math.floor(v.length * q))];
	if (at(0.75) === 0) return null;
	return Math.max(3, at(0.9));
}

function scoreLocal(p, ctx = {}) {
	if (!p || p.stub) return null;
	const parts = [];
	if (typeof p.profileCompleteness === 'number') parts.push(clamp100(p.profileCompleteness * 100));
	if (typeof p.avgRating === 'number') parts.push(clamp100((p.avgRating / 5) * 100));
	if (typeof p.reviewCount === 'number') parts.push(clamp100(Math.min(100, Math.log10(p.reviewCount + 1) * 50)));
	const vel = velocityScore(p.reviewsLast90d, ctx.velocityRef ?? null);
	if (vel !== null) parts.push(vel);
	if (typeof p.napConsistent === 'boolean') parts.push(p.napConsistent ? 100 : 50);
	if (!parts.length) return null;
	return clamp100(Math.round(parts.reduce((a, b) => a + b, 0) / parts.length));
}

/* Visibility — live. Ranked share of the sector keyword basket, weighted by
   average position, with a local-pack bonus. SERP data from DataForSEO. */
function scoreVisibility(p) {
	if (!p || p.stub) return null;
	if (typeof p.rankedKeywords !== 'number' || typeof p.basketSize !== 'number' || !p.basketSize) return null;
	const coverage = (p.rankedKeywords / p.basketSize) * 100;
	const posBonus = typeof p.avgPosition === 'number' ? Math.max(0, (11 - p.avgPosition) / 10) * 30 : 0;
	const packBonus = typeof p.localPackAppearances === 'number' && p.basketSize
		? (p.localPackAppearances / p.basketSize) * 20 : 0;
	return clamp100(Math.round(coverage * 0.5 + posBonus + packBonus));
}

/* AI search presence — live. Share of the sector's AI prompts in which the
   business is named, from ai_optimization llm_responses. */
function scoreAi(p) {
	if (!p || p.stub) return null;
	if (typeof p.citedQueryCount !== 'number' || typeof p.basketSize !== 'number' || !p.basketSize) return null;
	return clamp100(Math.round((p.citedQueryCount / p.basketSize) * 100));
}

/* Content & trust — about/team/credentials are real; indexed-count is stub. */
/* Content & trust.
 *
 * This pillar was four boolean-derived values wide — 0, 33, 67 or 100 — because
 * it read three link checks and nothing else, while two further signals sat as
 * permanent nulls and the published methodology claimed both. It is the
 * strongest predictor of findability in the whole index (r = 0.52 against
 * Visibility), and it was the most coarsely measured.
 *
 * Now: four link checks plus depth and freshness, each scored on its own and
 * averaged. Any signal we could not read is excluded rather than counted
 * against the business, so a site that publishes no modification date is not
 * marked stale for it. */
function scoreContent(p) {
	if (!p) return null;
	const parts = [];

	for (const flag of [p.hasAboutLink, p.hasTeamLink, p.hasCredentialsLink, p.hasBlogLink]) {
		if (typeof flag === 'boolean') parts.push(flag ? 100 : 0);
	}

	/* Homepage depth. Banded rather than continuous because the difference
	   between 900 and 1,100 words is noise, while the difference between 150
	   and 900 is a business that has written something and one that has not.
	   Capped so a wall of boilerplate cannot outscore a substantial page. */
	if (typeof p.wordCount === 'number') {
		const w = p.wordCount;
		parts.push(w >= 800 ? 100 : w >= 400 ? 75 : w >= 200 ? 50 : w >= 80 ? 25 : 0);
	}

	/* Freshness. Generous bands: a local business is not obliged to publish
	   weekly, and the signal being tested is whether the site is maintained at
	   all, not whether it is a news outlet. */
	if (typeof p.contentFreshnessDays === 'number') {
		const d = p.contentFreshnessDays;
		parts.push(d <= 90 ? 100 : d <= 365 ? 75 : d <= 730 ? 45 : 20);
	}

	if (!parts.length) return null;
	return clamp100(Math.round(parts.reduce((a, b) => a + b, 0) / parts.length));
}

const SCORERS = {
	speed: scoreSpeed,
	technical: scoreTechnical,
	local: scoreLocal,
	visibility: scoreVisibility,
	ai: scoreAi,
	content: scoreContent,
};

/* -------------------------------------------------------------------------- */
/* Weighted Digital Visibility Score with renormalisation                     */
/* -------------------------------------------------------------------------- */

function computeBusiness(record, ctx = {}) {
	const pillarScores = {};
	for (const { key } of PILLARS) {
		pillarScores[key] = SCORERS[key](record.pillars?.[key], ctx);
	}

	const included = PILLARS.filter((p) => pillarScores[p.key] !== null).map((p) => p.key);
	const totalIncludedWeight = PILLARS
		.filter((p) => included.includes(p.key))
		.reduce((sum, p) => sum + p.weight, 0);

	const effectiveWeights = {};
	let score = null;
	if (totalIncludedWeight > 0) {
		let acc = 0;
		for (const p of PILLARS) {
			if (!included.includes(p.key)) { effectiveWeights[p.key] = 0; continue; }
			const w = p.weight / totalIncludedWeight; // renormalised to sum 1
			effectiveWeights[p.key] = Number((w * 100).toFixed(2));
			acc += pillarScores[p.key] * w;
		}
		score = Math.round(acc);
	}

	return {
		slug: record.slug,
		name: record.name,
		url: record.url,
		collectedAt: record.collectedAt,
		/* Context data, carried through unscored. It was being collected and
		   then dropped here, which is the worst of both: the cost of gathering
		   it with none of the benefit. */
		enrichment: record.enrichment ?? null,
		digitalVisibilityScore: score,
		pillarScores,
		includedPillars: included,
		excludedPillars: PILLARS.map((p) => p.key).filter((k) => !included.includes(k)),
		effectiveWeights,

		/* Raw evidence carried through for the published diagrams.

		   The scores answer "how well"; these answer "on what". A keyword
		   position table and the AI answers that named a firm are the most
		   compelling thing the pipeline produces, and they were previously
		   stranded in the per-business files where nothing downstream read them. */
		evidence: {
			/* The three homepage link checks that make up the Content & trust
			   pillar. Carried through and exported because published analysis
			   cites them, and this project's rule is that a figure a reader
			   cannot reproduce from the open data does not get published. */
			content: {
				hasAboutLink: record.pillars?.content?.hasAboutLink ?? null,
				hasTeamLink: record.pillars?.content?.hasTeamLink ?? null,
				hasCredentialsLink: record.pillars?.content?.hasCredentialsLink ?? null,
			},
			positions: record.pillars?.visibility?.positions || {},
			keywordBasket: record.pillars?.visibility?.keywordBasket || [],
			rankedKeywords: record.pillars?.visibility?.rankedKeywords ?? null,
			avgPosition: record.pillars?.visibility?.avgPosition ?? null,
			localPackAppearances: record.pillars?.visibility?.localPackAppearances ?? null,
			aiCitedQueries: record.pillars?.ai?.citedQueries || [],
			aiQueryBasket: record.pillars?.ai?.queryBasket || [],
			aiBasketSize: record.pillars?.ai?.basketSize ?? null,
			local: {
				reviewCount: record.pillars?.local?.reviewCount ?? null,
				avgRating: record.pillars?.local?.avgRating ?? null,
				branchCount: record.pillars?.local?.branchCount ?? null,
				reviewsLast90d: record.pillars?.local?.reviewsLast90d ?? null,
				napConsistent: record.pillars?.local?.napConsistent ?? null,
				matchedBy: record.pillars?.local?.matchedBy ?? null,
			},
			speed: {
				lcpMs: record.pillars?.speed?.lcpMs ?? null,
				inpMs: record.pillars?.speed?.inpMs ?? null,
				cls: record.pillars?.speed?.cls ?? null,
				crux: record.pillars?.speed?.crux ?? null,
			},
		},
		errors: record.errors || [],
	};
}

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

async function main() {
	const indexSlug = process.argv[2];
	if (!indexSlug) {
		console.error('Usage: node score.mjs <index-slug>');
		console.error('Example: node score.mjs bristol-estate-agents');
		process.exit(1);
	}
	const dir = join(DATA_ROOT, indexSlug);

	let files;
	try {
		files = (await readdir(dir)).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
	} catch (e) {
		console.error(`Cannot read data dir ${dir}: ${e.message}`);
		console.error('Run the collector first: node collect.mjs seeds/' + indexSlug + '.csv');
		process.exit(1);
	}
	if (!files.length) {
		console.error(`No business JSON found in ${dir}. Run collect.mjs first.`);
		process.exit(1);
	}

	/* Two passes. Review velocity is scored against the cohort, so every record
	   has to be read before any of them can be scored. */
	const records = [];
	for (const f of files) {
		try {
			records.push({ f, record: JSON.parse(await readFile(join(dir, f), 'utf8')) });
		} catch (e) {
			console.error(`  ! skipping ${f}: ${e.message}`);
		}
	}
	const velocityRef = cohortVelocityRef(records.map((r) => r.record));
	console.log(velocityRef === null
		? '  review velocity: excluded — too few businesses in this cohort receive reviews to compare them'
		: `  review velocity: scored against this cohort, full marks at ${velocityRef} reviews/90d`);

	const businesses = [];
	for (const { f, record } of records) {
		try {
			businesses.push(computeBusiness(record, { velocityRef }));
		} catch (e) {
			console.error(`  ! skipping ${f}: ${e.message}`);
		}
	}

	// Rank by score (nulls sort last).
	businesses.sort((a, b) => {
		if (a.digitalVisibilityScore === null) return 1;
		if (b.digitalVisibilityScore === null) return -1;
		return b.digitalVisibilityScore - a.digitalVisibilityScore;
	});
	const ranked = businesses.length;
	businesses.forEach((b, i) => {
		b.rank = b.digitalVisibilityScore === null ? null : i + 1;
		b.percentile = b.digitalVisibilityScore === null || ranked < 2
			? null
			: Math.round(((ranked - (i + 1)) / (ranked - 1)) * 100);
	});

	// Sector medians per pillar + overall.
	const sectorMedians = {};
	for (const { key } of PILLARS) {
		sectorMedians[key] = median(businesses.map((b) => b.pillarScores[key]));
	}
	const overallMedian = median(businesses.map((b) => b.digitalVisibilityScore));

	// Which pillars are live vs stubbed across the whole index (for the hub copy).
	const pillarCoverage = {};
	for (const { key } of PILLARS) {
		const scored = businesses.filter((b) => b.pillarScores[key] !== null).length;
		pillarCoverage[key] = { scored, total: businesses.length, live: scored > 0 };
	}

	/* The competitive landscape is collected per index and lives beside the
	   business records; surface it here so the hub page can show who really
	   owns page one rather than only how the seed ranks against itself. */
	const sidecar = async (name) => {
		try { return JSON.parse(await readFile(join(dir, name), 'utf8')); }
		catch (e) { if (e.code !== 'ENOENT') throw e; return null; }
	};

	let landscape = null;
	try {
		landscape = JSON.parse(await readFile(join(dir, '_landscape.json'), 'utf8'));
	} catch (e) {
		// Absent is fine — the page omits the figure. Anything else (malformed
		// JSON, permissions) must not masquerade as "not collected yet".
		if (e.code !== 'ENOENT') throw e;
	}

	/* Loaded here rather than inline in `out` because measuredAt below has to
	   see their timestamps. */
	const intent = await sidecar('_intent.json');
	const geoGrid = await sidecar('_geogrid.json');

	/* When the data was actually MEASURED, as distinct from when it was scored.
	   These were conflated: scoredAt was wall-clock at scoring time and every
	   published "Measured <date>" line, every frontmatter date and the
	   measuredAt field in the open dataset were derived from it. Re-running the
	   scorer over unchanged collected data therefore rewrote the measurement
	   date on 79 scorecards and mutated an already-tagged dated snapshot — so
	   the snapshot stopped being a receipt, and the site claimed a measurement
	   that never happened.

	   Scoring is a pure function of collected data, so the honest timestamp is
	   the latest collection in the cohort.

	   That must include the index-level sidecars, not just the per-business
	   records. The geo grid, intent set and landscape are collected AFTER the
	   business sweep and feed the Local and Visibility figures — Exeter's grid
	   was 18 minutes newer than the date the site published. Taking only the
	   business max meant a geo-grid-only re-collection changed a snapshot's
	   contents while its stated measurement date stood still: the same
	   receipt-that-isn't-a-receipt defect, inverted.

	   Falls back to scoring time only if nothing carries a timestamp. */
	const collectionTimes = [
		...businesses.map((b) => b.collectedAt),
		intent?.collectedAt,
		geoGrid?.collectedAt,
		landscape?.collectedAt,
	]
		.filter((t) => typeof t === 'string' && !Number.isNaN(Date.parse(t)))
		.sort();
	const scoredAt = new Date().toISOString();

	const out = {
		schemaVersion: 2,
		index: indexSlug,
		measuredAt: collectionTimes.length ? collectionTimes[collectionTimes.length - 1] : scoredAt,
		scoredAt,
		weights: Object.fromEntries(PILLARS.map((p) => [p.key, p.weight])),
		pillarLabels: Object.fromEntries(PILLARS.map((p) => [p.key, p.label])),
		stubNote:
			'Pillars with no data (stubbed source or per-business collection failure) are excluded from that business\'s weighting and the remaining weights are renormalised to 100. See effectiveWeights per business.',
		count: businesses.length,
		overallMedian,
		sectorMedians,
		pillarCoverage,
		intent,
		geoGrid,
		landscape: landscape ? {
			measuredKeywords: landscape.measuredKeywords,
			summary: landscape.summary,
			topDomains: (landscape.domainShare || []).slice(0, 12),
			seedGaps: (landscape.seedGaps || []).slice(0, 8),
		} : null,
		businesses,
	};

	const outFile = join(dir, '_ranked.json');
	await writeFile(outFile, JSON.stringify(out, null, 2) + '\n');

	console.log(`Scored ${businesses.length} businesses for "${indexSlug}".`);
	console.log('Live pillars: ' + PILLARS.filter((p) => pillarCoverage[p.key].live).map((p) => p.label).join(', '));
	console.log('Stubbed pillars: ' + PILLARS.filter((p) => !pillarCoverage[p.key].live).map((p) => p.label).join(', '));
	console.log(`Overall median Digital Visibility Score: ${overallMedian ?? 'n/a'}`);
	console.log(`Wrote ${outFile}`);
	console.log('Next: node generate.mjs ' + indexSlug);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
