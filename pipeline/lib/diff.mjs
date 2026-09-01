/* Quarter-on-quarter diffing of two index runs.
 *
 * diffRuns is PURE: it takes two loaded snapshot objects and returns a plain
 * result. No file reads, no clock, no network — so it can be unit tested
 * exhaustively, which matters because its output drives emails to named real
 * businesses about their own scores.
 *
 * The brief names the signature diffRuns(indexSlug, quarterA, quarterB). Those
 * three arguments cannot be resolved to snapshots without I/O, and the same
 * paragraph requires the function be pure with no I/O. The two are reconciled
 * the usual way: this file holds the pure core taking loaded runs, and
 * diff.mjs's CLI (bin/diff-runs.mjs) does the loading and passes them in. The
 * slug-and-quarters form is the command; the pure form is the function.
 *
 * THE VERSION GUARD
 *
 * A delta between two runs scored by different rules is not a measurement of
 * anything — the business did not move, the ruler did. So a mismatch REFUSES
 * rather than warning, and says which versions and why. A missing version on
 * either side is also a refusal: absence is not evidence of sameness, and the
 * one pair in this repo where it matters (Q2-2026 against Q3-2026) is exactly
 * the pair that must not be compared. Q2 recorded five fields per business and
 * no local, visibility or AI pillar at all.
 */

import { PILLARS, median } from './common.mjs';
import { ID_SOURCES, resolveCohort } from './identity.mjs';

const PILLAR_KEYS = PILLARS.map((p) => p.key);

/* The methodology version of a run, or null when it does not declare one.
   Read from the header the migration stamps. `methodology` (a URL, present on
   every file since the first run) is deliberately NOT a fallback: it is
   identical across every snapshot including Q2, so treating it as a version
   would make every pair look comparable. */
export function methodologyVersionOf(run) {
	const v = run?.methodologyVersion;
	return Number.isInteger(v) ? v : null;
}

function compositeOf(business) {
	const v = business?.digitalVisibilityScore;
	return typeof v === 'number' && !Number.isNaN(v) ? v : null;
}

function deltaOf(a, b) {
	if (typeof a !== 'number' || typeof b !== 'number') return null;
	return Number((b - a).toFixed(2));
}

function pillarMedians(businesses) {
	const out = {};
	for (const key of PILLAR_KEYS) {
		out[key] = median(businesses.map((b) => b?.pillarScores?.[key]).filter((v) => typeof v === 'number'));
	}
	return out;
}

/* Match two resolved cohorts one-to-one, strongest shared key first.
 *
 * Greedy by precedence rather than all-at-once: every pair that agrees on
 * place_id is settled before domain is consulted at all, so a place_id match
 * can never be pre-empted by a coincidental domain match. Each business is
 * consumed on its first match, which is what keeps the mapping one-to-one — a
 * chain and its branch cannot both claim the same counterpart.
 *
 * A key claimed by more than one business on either side is SKIPPED for that
 * source rather than guessed at. Matching it arbitrarily would swap two firms'
 * histories, and a false delta is worse than a reported entry/exit a human can
 * see and correct. */
function matchCohorts(rowsA, rowsB) {
	const takenA = new Set();
	const takenB = new Set();
	const pairs = [];

	for (const source of ID_SOURCES) {
		const bucketA = new Map();
		const bucketB = new Map();
		rowsA.forEach((row, i) => {
			const k = row.identity.keys[source];
			if (!k || takenA.has(i)) return;
			if (!bucketA.has(k)) bucketA.set(k, []);
			bucketA.get(k).push(i);
		});
		rowsB.forEach((row, i) => {
			const k = row.identity.keys[source];
			if (!k || takenB.has(i)) return;
			if (!bucketB.has(k)) bucketB.set(k, []);
			bucketB.get(k).push(i);
		});

		for (const [key, idsA] of bucketA) {
			const idsB = bucketB.get(key);
			if (!idsB) continue;
			if (idsA.length !== 1 || idsB.length !== 1) continue; // ambiguous — leave it visible
			const [ia] = idsA;
			const [ib] = idsB;
			if (takenA.has(ia) || takenB.has(ib)) continue;
			takenA.add(ia);
			takenB.add(ib);
			pairs.push({ a: rowsA[ia], b: rowsB[ib], matchedOn: source, key });
		}
	}

	return {
		pairs,
		unmatchedA: rowsA.filter((_, i) => !takenA.has(i)),
		unmatchedB: rowsB.filter((_, i) => !takenB.has(i)),
	};
}

/* Diff two loaded runs.
 *
 *   runA, runB   parsed snapshot objects; A is the earlier run
 *   manualIds    tables from identity.loadManualIds(), optional
 *
 * Always returns a result object. When the runs are not comparable, `comparable`
 * is false, `refusedBecause` says why in a sentence fit to show a human, and the
 * movement fields are empty rather than misleadingly zero. */
export function diffRuns(runA, runB, { manualIds = null } = {}) {
	const indexSlug = runB?.index ?? runA?.index ?? null;
	const versionA = methodologyVersionOf(runA);
	const versionB = methodologyVersionOf(runB);

	const base = {
		indexSlug,
		/* `period` before `quarter`: an interim measurement carries BOTH — the
		   quarter it falls inside and the month it measures — so preferring
		   `quarter` labelled an August-to-September diff "Q3-2026 -> Q3-2026".
		   Quarterly snapshots have no `period`, so they are unaffected. */
		quarterA: runA?.period ?? runA?.quarter ?? null,
		quarterB: runB?.period ?? runB?.quarter ?? null,
		methodologyVersionA: versionA,
		methodologyVersionB: versionB,
		comparable: true,
		refusedBecause: null,
		matched: [],
		entries: [],
		exits: [],
		cohort: null,
		unresolved: { a: [], b: [] },
		ambiguous: { a: [], b: [] },
	};

	if (versionA === null || versionB === null) {
		const which = versionA === null && versionB === null ? 'Neither run declares'
			: versionA === null ? `${base.quarterA} does not declare`
			: `${base.quarterB} does not declare`;
		return {
			...base,
			comparable: false,
			refusedBecause: `${which} a methodologyVersion. Two runs cannot be compared unless both state the rules they were scored by; an absent version is not evidence that the rules were the same.`,
		};
	}

	if (versionA !== versionB) {
		return {
			...base,
			comparable: false,
			refusedBecause: `Methodology version ${versionA} (${base.quarterA}) cannot be compared with version ${versionB} (${base.quarterB}). The scoring rules changed between these runs, so any difference measures the ruler, not the business.`,
		};
	}

	const cohortA = resolveCohort(runA?.businesses || [], { indexSlug, manualIds });
	const cohortB = resolveCohort(runB?.businesses || [], { indexSlug, manualIds });
	const { pairs, unmatchedA, unmatchedB } = matchCohorts(cohortA.resolved, cohortB.resolved);

	const matched = pairs.map(({ a, b, matchedOn, key }) => {
		const compA = compositeOf(a.business);
		const compB = compositeOf(b.business);
		const pillars = {};
		for (const pk of PILLAR_KEYS) {
			const pa = a.business?.pillarScores?.[pk] ?? null;
			const pb = b.business?.pillarScores?.[pk] ?? null;
			pillars[pk] = { a: pa, b: pb, delta: deltaOf(pa, pb) };
		}
		/* The pillar that explains the move: the largest absolute change among
		   those measured on BOTH sides. A pillar that went from excluded to
		   measured has no delta to attribute — its arrival is a coverage
		   change, not the business improving — so it is reported separately
		   rather than credited with the whole swing. */
		let movedBy = null;
		for (const pk of PILLAR_KEYS) {
			const d = pillars[pk].delta;
			if (d === null || d === 0) continue;
			if (!movedBy || Math.abs(d) > Math.abs(pillars[movedBy].delta)) movedBy = pk;
		}
		const coverageChanged = PILLAR_KEYS.filter((pk) => {
			const { a: pa, b: pb } = pillars[pk];
			return (pa === null) !== (pb === null);
		});

		return {
			id: b.identity.id,
			idSource: b.identity.idSource,
			matchedOn,
			matchKey: key,
			name: b.business?.name ?? null,
			previousName: a.business?.name ?? null,
			nameChanged: (a.business?.name ?? null) !== (b.business?.name ?? null),
			url: b.business?.url ?? null,
			composite: { a: compA, b: compB, delta: deltaOf(compA, compB) },
			rank: { a: a.business?.rank ?? null, b: b.business?.rank ?? null, delta: deltaOf(a.business?.rank ?? null, b.business?.rank ?? null) },
			pillars,
			movedBy,
			coverageChanged,
		};
	});

	const describe = (row) => ({
		id: row.identity.id,
		idSource: row.identity.idSource,
		name: row.business?.name ?? null,
		url: row.business?.url ?? null,
		composite: compositeOf(row.business),
		rank: row.business?.rank ?? null,
	});

	const compositesA = (runA.businesses || []).map(compositeOf).filter((v) => v !== null);
	const compositesB = (runB.businesses || []).map(compositeOf).filter((v) => v !== null);
	const medA = median(compositesA);
	const medB = median(compositesB);
	const pmA = pillarMedians(runA.businesses || []);
	const pmB = pillarMedians(runB.businesses || []);
	const pillarMedianShift = {};
	for (const pk of PILLAR_KEYS) {
		pillarMedianShift[pk] = { a: pmA[pk], b: pmB[pk], delta: deltaOf(pmA[pk], pmB[pk]) };
	}

	return {
		...base,
		matched: matched.sort((x, y) => (y.composite.delta ?? 0) - (x.composite.delta ?? 0)),
		entries: unmatchedB.map(describe),
		exits: unmatchedA.map(describe),
		cohort: {
			sizeA: (runA.businesses || []).length,
			sizeB: (runB.businesses || []).length,
			medianA: medA,
			medianB: medB,
			medianDelta: deltaOf(medA, medB),
			pillarMedianShift,
		},
		unresolved: { a: cohortA.unresolved, b: cohortB.unresolved },
		ambiguous: { a: cohortA.ambiguous, b: cohortB.ambiguous },
	};
}

/* Movers and fallers, for the Phase 3 pages and the score-change email.
   Threshold is a magnitude in composite points; the brief's default is 5. */
export function moversAndFallers(diff, { threshold = 5 } = {}) {
	if (!diff.comparable) return { movers: [], fallers: [], threshold, comparable: false };
	const moved = diff.matched.filter((m) => m.composite.delta !== null && Math.abs(m.composite.delta) >= threshold);
	return {
		comparable: true,
		threshold,
		movers: moved.filter((m) => m.composite.delta > 0).sort((a, b) => b.composite.delta - a.composite.delta),
		fallers: moved.filter((m) => m.composite.delta < 0).sort((a, b) => a.composite.delta - b.composite.delta),
	};
}
