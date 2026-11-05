/* The logic of a monthly release: naming it, comparing it with the last one,
 * deciding whether it is safe to publish unattended, and writing its changelog
 * entry.
 *
 * Pure: no file reads, no clock, no network. publish-month.mjs does the I/O.
 * That split matters more than usual because nobody reads a release before it
 * goes out. Every sentence below ends up on a public page about named firms, so
 * each one is pinned by test/release.test.mjs.
 */

import { PILLARS } from './common.mjs';
import { diffRuns } from './diff.mjs';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
	'August', 'September', 'October', 'November', 'December'];

/* Limits above which a release waits for a person. Each is set just beyond the
   largest genuine movement in the data so far: Q3-2026 to Q4-2026 moved one
   index median by 9, and one pillar mean by 7. Those were real, and published.
   The limits are for faults: a blocked crawler, a dead API, a broken scorer. */
export const HOLD_LIMITS = {
	newTechnicalZeros: 15,
	indexMedianShift: 15,
	pillarMeanShift: 12,
	unmeasuredRisePct: 10,
};

/* The files that decide a score. A change to any of them between two releases
   means a score can move because the ruler did, and the changelog's "nothing in
   the scoring changed" would be false. */
export const SCORING_FILES = [
	'pipeline/score.mjs',
	'pipeline/collect.mjs',
	'pipeline/lib/common.mjs',
	'pipeline/lib/match.mjs',
	'pipeline/lib/people.mjs',
	'pipeline/config/engine.json',
	'pipeline/config/sectors.json',
];

const PAID_ENRICHMENT = ['gbpDetail', 'backlinks'];
const PERIOD = /^(\d{4})-(0[1-9]|1[0-2])$/;

export const isPeriod = (value) => PERIOD.test(String(value));

function parsePeriod(period) {
	const m = String(period).match(PERIOD);
	if (!m) throw new Error(`'${period}' is not a period (YYYY-MM)`);
	return { year: Number(m[1]), month: Number(m[2]) };
}

export function releaseLabel(period) {
	const { year, month } = parsePeriod(period);
	return `${MONTHS[month - 1]} ${year}`;
}

export function calendarQuarter(period) {
	const { year, month } = parsePeriod(period);
	return `Q${Math.ceil(month / 3)}-${year}`;
}

/* Months since year 0. A quarter counts from its first month, which is when
   each quarterly snapshot was measured. */
function snapshotOrder(name) {
	const quarter = name.match(/^q([1-4])-(\d{4})$/i);
	if (quarter) return Number(quarter[2]) * 12 + (Number(quarter[1]) - 1) * 3;
	if (isPeriod(name)) {
		const { year, month } = parsePeriod(name);
		return year * 12 + month - 1;
	}
	return null;
}

export function latestPriorSnapshot(filenames, { period = null, quarter = null }) {
	const current = snapshotOrder(period ?? quarter);
	const candidates = filenames
		.filter((f) => f.endsWith('.json'))
		.map((file) => ({ file, order: snapshotOrder(file.replace(/\.json$/, '')) }))
		.filter(({ order }) => order !== null && order < current)
		.sort((a, b) => a.order - b.order);
	return candidates.at(-1)?.file ?? null;
}

/* A reading beats an error, whichever connection got it. The recheck wins when
   both reached the site, so every firm's Technical and Content come from the
   same place month to month. */
export function chooseReading(github, recheck) {
	if (recheck?.error && github && !github.error) return github;
	return recheck;
}

/* Paid enrichment is bought in the first month of a quarter only. The months
   between must not lose it from the scorecards, so it is carried forward from
   the previous release and dated, so a reader knows how old it is. */
export function carryForwardPaid(record, priorBusiness, priorLabel) {
	const context = priorBusiness?.context;
	if (!context) return record;
	const carried = {};
	for (const key of PAID_ENRICHMENT) {
		if (record.enrichment?.[key] == null && context[key] != null) {
			carried[key] = { carriedFrom: priorLabel, ...context[key] };
		}
	}
	if (!Object.keys(carried).length) return record;
	return { ...record, enrichment: { ...record.enrichment, ...carried } };
}

const labelOf = (run) => run?.releaseLabel ?? run?.quarter ?? run?.period ?? null;
const emptyPillarTally = () => ({ up: 0, down: 0, sum: 0, compared: 0, unmeasuredPrior: 0, unmeasuredCurrent: 0 });

/* The identity logic in diffRuns is what matters here. Its version guard does
   not apply, because no snapshot declares a methodologyVersion yet; the same
   guarantee comes from the SCORING_FILES hold, which runs on every release. */
function diffPair({ prior, current }, manualIds) {
	return diffRuns({ ...prior, methodologyVersion: 1 }, { ...current, methodologyVersion: 1 }, { manualIds });
}

function newFirstPlace(pair, diff) {
	const top = pair.current.businesses?.[0];
	const priorTop = pair.prior.businesses?.[0];
	if (!top || !priorTop) return null;
	const row = diff.matched.find((m) => m.rank.b === top.rank && m.url === top.url);
	if (row?.rank.a === priorTop.rank) return null;
	return { title: pair.title, from: priorTop.name, to: top.name };
}

function tallyPillars(tally, diff) {
	for (const row of diff.matched) {
		for (const { key } of PILLARS) {
			const { delta } = row.pillars[key];
			if (delta === null) continue;
			tally[key].compared += 1;
			tally[key].sum += delta;
			if (delta > 0) tally[key].up += 1;
			if (delta < 0) tally[key].down += 1;
		}
	}
}

function tallyUnmeasured(tally, pair) {
	for (const { key } of PILLARS) {
		const unmeasured = (run) => (run.businesses || []).filter((b) => b.pillarScores?.[key] == null).length;
		tally[key].unmeasuredPrior += unmeasured(pair.prior);
		tally[key].unmeasuredCurrent += unmeasured(pair.current);
	}
}

const round1 = (n) => Number(n.toFixed(1));

function finishPillars(tally) {
	return Object.fromEntries(Object.entries(tally).map(([key, { sum, compared, ...rest }]) => (
		[key, { ...rest, compared, mean: compared ? round1(sum / compared) : 0 }]
	)));
}

export function summariseRelease(pairs, { manualIds = null } = {}) {
	const tally = Object.fromEntries(PILLARS.map(({ key }) => [key, emptyPillarTally()]));
	const out = {
		indexSlugs: [], firms: 0, changed: 0, higher: 0, lower: 0, rankChanged: 0,
		newFirstPlaces: [], newTechnicalZeros: [], medians: [], joined: [], left: [],
		priorLabel: labelOf(pairs[0]?.prior),
	};

	for (const pair of pairs) {
		const diff = diffPair(pair, manualIds);
		out.indexSlugs.push(pair.slug);
		out.firms += pair.current.businesses?.length ?? 0;
		out.medians.push({ title: pair.title, firms: diff.cohort.sizeB, prior: diff.cohort.medianA, current: diff.cohort.medianB });
		out.joined.push(...diff.entries.map((e) => ({ title: pair.title, name: e.name })));
		out.left.push(...diff.exits.map((e) => ({ title: pair.title, name: e.name })));
		const first = newFirstPlace(pair, diff);
		if (first) out.newFirstPlaces.push(first);
		tallyPillars(tally, diff);
		tallyUnmeasured(tally, pair);

		for (const row of diff.matched) {
			const delta = row.composite.delta;
			if (delta) {
				out.changed += 1;
				if (delta > 0) out.higher += 1; else out.lower += 1;
			}
			if (row.rank.delta) out.rankChanged += 1;
			const { a, b } = row.pillars.technical;
			if (b === 0 && a !== 0) {
				out.newTechnicalZeros.push({ title: pair.title, name: row.name, error: pair.technicalErrors?.[row.url] ?? null });
			}
		}
	}
	return { ...out, pillars: finishPillars(tally) };
}

/* Why a release should wait for a person. Empty means publish. */
export function findHolds(summary, { expectedSlugs, scoringChanges, staleScorecards, measuredPeriod, period }) {
	const holds = [];
	const missing = expectedSlugs.filter((s) => !summary.indexSlugs.includes(s));
	if (missing.length) holds.push(`Missing or incomplete indices: ${missing.join(', ')}`);
	if (measuredPeriod !== period) holds.push(`Expected a measurement from ${period}, found one from ${measuredPeriod}`);
	if (scoringChanges.length) holds.push(`Scoring code changed since the last release, so "nothing in the scoring changed" would be false, and the methodology page may need updating: ${scoringChanges.join(', ')}`);
	if (staleScorecards.length) holds.push(`Scorecards need retiring with a redirect, which is an editorial decision: ${staleScorecards.join(', ')}`);

	const zeros = summary.newTechnicalZeros.length;
	if (zeros > HOLD_LIMITS.newTechnicalZeros) holds.push(`${zeros} businesses newly score 0 on Technical (limit ${HOLD_LIMITS.newTechnicalZeros}). Possible crawler fault rather than ${zeros} failing sites.`);

	for (const m of summary.medians) {
		if (m.prior === null || m.current === null) continue;
		const shift = Math.abs(m.current - m.prior);
		if (shift > HOLD_LIMITS.indexMedianShift) holds.push(`${m.title} median moved ${shift} points, from ${m.prior} to ${m.current} (limit ${HOLD_LIMITS.indexMedianShift}).`);
	}

	for (const [key, p] of Object.entries(summary.pillars)) {
		if (Math.abs(p.mean) > HOLD_LIMITS.pillarMeanShift) holds.push(`Average ${key} moved ${p.mean} points across every index (limit ${HOLD_LIMITS.pillarMeanShift}).`);
		const risePct = summary.firms ? ((p.unmeasuredCurrent - p.unmeasuredPrior) / summary.firms) * 100 : 0;
		if (risePct > HOLD_LIMITS.unmeasuredRisePct) holds.push(`${key} could not be measured for ${p.unmeasuredCurrent} businesses, up from ${p.unmeasuredPrior}.`);
	}
	return holds;
}

function humanDate(iso) {
	const [year, month, day] = iso.split('-').map(Number);
	return `${day} ${MONTHS[month - 1]} ${year}`;
}

function humanRange(from, to) {
	if (from === to) return `on ${humanDate(from)}`;
	const [fromYear, fromMonth, fromDay] = from.split('-').map(Number);
	const [toYear, toMonth] = to.split('-').map(Number);
	if (fromYear === toYear && fromMonth === toMonth) return `between ${fromDay} and ${humanDate(to)}`;
	return `between ${humanDate(from)} and ${humanDate(to)}`;
}

const escapeCell = (s) => String(s).replace(/\|/g, '\\|').replace(/</g, '&lt;');
const escapeText = (s) => String(s).replace(/([*_`])/g, '\\$1').replace(/</g, '&lt;');
const signed = (n) => `${n > 0 ? '+' : ''}${n}`;

/* Describes what we saw, never why. A 403 is a refusal of our crawler, and that
   is a fact about access rather than about the firm. */
function describeFailure(error) {
	const status = String(error ?? '').match(/HTTP (\d{3})/)?.[1];
	if (!status) return 'could not be reached';
	if (['401', '403', '418', '429'].includes(status)) return `refused our crawler (HTTP ${status})`;
	return `answered HTTP ${status}`;
}

function zerosSection(zeros) {
	if (!zeros.length) return 'No business newly scores 0 on Technical in this release.';
	const lines = zeros.map((z) => `- ${escapeText(z.name)} (${escapeText(z.title)}): ${describeFailure(z.error)}`);
	return `**${zeros.length} business${zeros.length === 1 ? '' : 'es'} newly score${zeros.length === 1 ? 's' : ''} 0 on Technical because the homepage could not be read.** We score only what we can read, so this is a fact about access on the day, not a judgement of the site. Each is measured again next month.\n\n${lines.join('\n')}`;
}

function pillarsSection(pillars) {
	const lines = PILLARS.map(({ key, label }) => {
		const p = pillars[key];
		return `- **${label ?? key}:** ${p.up} up, ${p.down} down, averaging ${signed(p.mean)} points`;
	});
	return `**By pillar, across businesses measured in both releases:**\n\n${lines.join('\n')}`;
}

function mediansSection(medians, priorLabel, label) {
	const rows = medians.map((m) => `| ${escapeCell(m.title)} | ${m.firms} | ${m.prior ?? '—'} | **${m.current ?? '—'}** |`);
	return `Median Digital Visibility Score by index, ${priorLabel} to ${label}:\n\n<div class="pyc-medians">\n\n| Index | Firms | Before | Now |\n|---|---:|---:|---:|\n${rows.join('\n')}\n\n</div>`;
}

function firstPlacesSection(places, indexCount) {
	if (!places.length) return `**No index has a new first place.**`;
	const lines = places.map((p) => `- **${escapeText(p.title)}:** ${escapeText(p.from)} → **${escapeText(p.to)}**`);
	return `**New first places, ${places.length} of ${indexCount}.**\n\n${lines.join('\n')}`;
}

function cohortSection({ joined, left }) {
	if (!joined.length && !left.length) return null;
	const names = (rows) => rows.map((r) => `${escapeText(r.name)} (${escapeText(r.title)})`).join('; ');
	return [
		joined.length ? `**New to the comparison:** ${names(joined)}.` : null,
		left.length ? `**No longer matched to last month:** ${names(left)}.` : null,
	].filter(Boolean).join('\n\n');
}

export function changelogEntry(summary, { period, publishedOn, collectedFrom, collectedTo, recheckedOn }) {
	const label = releaseLabel(period);
	const indexCount = summary.indexSlugs.length;
	const headline = `**${summary.changed} of ${summary.firms} businesses have a different Digital Visibility Score from ${summary.priorLabel} — ${summary.higher} higher, ${summary.lower} lower — ${summary.rankChanged} changed rank, and ${summary.newFirstPlaces.length} of ${indexCount} indices have a new first place.**`;
	return [
		`### ${humanDate(publishedOn)} (release) — ${label}: every index re-measured`,
		`Every published index was collected again ${humanRange(collectedFrom, collectedTo)}, scored, and published automatically as the ${label} release. Technical and Content & trust were re-read for every business on ${humanDate(recheckedOn)} from an ordinary connection, because some sites refuse or answer differently to the data-centre machine that runs the collection.`,
		`${headline} Nothing in the scoring changed between the two releases: the code that sets the weights, the pillar formulas and the way search results are matched to businesses is unchanged, and the release checks that before publishing. We record the movement; we do not claim to know why any of it happened.`,
		pillarsSection(summary.pillars),
		zerosSection(summary.newTechnicalZeros),
		cohortSection(summary),
		mediansSection(summary.medians, summary.priorLabel, label),
		firstPlacesSection(summary.newFirstPlaces, indexCount),
	].filter(Boolean).join('\n\n');
}

export function insertChangelogEntry(markdown, entry, publishedOn) {
	const year = publishedOn.slice(0, 4);
	const heading = markdown.match(/^## (\d{4})$/m);
	if (!heading) throw new Error('changelog has no year heading to place the entry under');

	const at = heading.index;
	const body = heading[1] === year
		? `${markdown.slice(0, at)}## ${year}\n\n${entry}\n\n${markdown.slice(at + heading[0].length).replace(/^\n+/, '')}`
		: `${markdown.slice(0, at)}## ${year}\n\n${entry}\n\n${markdown.slice(at)}`;
	return body.replace(/^lastUpdated: .*$/m, `lastUpdated: ${publishedOn}T12:00:00Z`);
}

export function hasReleaseEntry(markdown, period) {
	const label = releaseLabel(period).replace(/ /g, '\\s');
	return new RegExp(`^### .*\\(release\\) — ${label}\\b`, 'm').test(markdown);
}
