/* score.mjs — Local Digital Visibility Index scorer.

   Reads every per-business JSON for an index, converts each pillar's raw
   signals into a 0-100 pillar score, applies the EXACT six-pillar weights from
   the published methodology, computes the weighted Digital Visibility Score,
   ranks the businesses, and computes sector medians per pillar.

   Writes: scripts/index/data/<index-slug>/_ranked.json

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

/* Local presence — STUB until Places/GBP wired. */
function scoreLocal(p) {
	if (!p || p.stub) return null;
	// Reference scoring (used once real data lands). Kept here so wiring the
	// collector is the only change needed.
	const parts = [];
	if (typeof p.profileCompleteness === 'number') parts.push(clamp100(p.profileCompleteness * 100));
	if (typeof p.avgRating === 'number') parts.push(clamp100((p.avgRating / 5) * 100));
	if (typeof p.reviewCount === 'number') parts.push(clamp100(Math.min(100, Math.log10(p.reviewCount + 1) * 50)));
	if (typeof p.reviewsLast90d === 'number') parts.push(clamp100(Math.min(100, p.reviewsLast90d * 10)));
	if (typeof p.napConsistent === 'boolean') parts.push(p.napConsistent ? 100 : 50);
	if (!parts.length) return null;
	return clamp100(Math.round(parts.reduce((a, b) => a + b, 0) / parts.length));
}

/* Visibility — STUB until SERP source wired. */
function scoreVisibility(p) {
	if (!p || p.stub) return null;
	if (typeof p.rankedKeywords !== 'number' || typeof p.basketSize !== 'number' || !p.basketSize) return null;
	const coverage = (p.rankedKeywords / p.basketSize) * 100;
	const posBonus = typeof p.avgPosition === 'number' ? Math.max(0, (11 - p.avgPosition) / 10) * 30 : 0;
	const packBonus = typeof p.localPackAppearances === 'number' && p.basketSize
		? (p.localPackAppearances / p.basketSize) * 20 : 0;
	return clamp100(Math.round(coverage * 0.5 + posBonus + packBonus));
}

/* AI search presence — STUB until AI-engine querying wired. */
function scoreAi(p) {
	if (!p || p.stub) return null;
	if (typeof p.citedQueryCount !== 'number' || typeof p.basketSize !== 'number' || !p.basketSize) return null;
	return clamp100(Math.round((p.citedQueryCount / p.basketSize) * 100));
}

/* Content & trust — about/team/credentials are real; indexed-count is stub. */
function scoreContent(p) {
	if (!p) return null;
	const checks = [p.hasAboutLink, p.hasTeamLink, p.hasCredentialsLink];
	const known = checks.filter((c) => typeof c === 'boolean');
	// indexedPageCount / contentFreshnessDays are stubbed (null) and excluded.
	if (!known.length) return null;
	const passed = known.filter(Boolean).length;
	return clamp100(Math.round((passed / known.length) * 100));
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

function computeBusiness(record) {
	const pillarScores = {};
	for (const { key } of PILLARS) {
		pillarScores[key] = SCORERS[key](record.pillars?.[key]);
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
		digitalVisibilityScore: score,
		pillarScores,
		includedPillars: included,
		excludedPillars: PILLARS.map((p) => p.key).filter((k) => !included.includes(k)),
		effectiveWeights,
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

	const businesses = [];
	for (const f of files) {
		try {
			const record = JSON.parse(await readFile(join(dir, f), 'utf8'));
			businesses.push(computeBusiness(record));
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

	const out = {
		schemaVersion: 1,
		index: indexSlug,
		scoredAt: new Date().toISOString(),
		weights: Object.fromEntries(PILLARS.map((p) => [p.key, p.weight])),
		pillarLabels: Object.fromEntries(PILLARS.map((p) => [p.key, p.label])),
		stubNote:
			'Pillars with no data (stubbed source or per-business collection failure) are excluded from that business\'s weighting and the remaining weights are renormalised to 100. See effectiveWeights per business.',
		count: businesses.length,
		overallMedian,
		sectorMedians,
		pillarCoverage,
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
