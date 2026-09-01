/* Unit tests for lib/diff.mjs. Pure function, no I/O — every run below is a
   literal. Run: node --test test/ */

import test from 'node:test';
import assert from 'node:assert/strict';
import { diffRuns, moversAndFallers, methodologyVersionOf } from '../lib/diff.mjs';
import { indexManualIds } from '../lib/identity.mjs';

/* A minimal but structurally honest snapshot. */
function run({ quarter, version, businesses }) {
	return { index: 'bath-vets', quarter, methodologyVersion: version, businesses };
}
function biz({ rank = 1, name, url, placeId = null, score, pillars = {} }) {
	return {
		rank,
		name,
		url,
		digitalVisibilityScore: score,
		pillarScores: { speed: null, technical: null, local: null, visibility: null, ai: null, content: null, ...pillars },
		...(placeId ? { localMatch: { placeId, matchedBy: 'domain' } } : {}),
	};
}

test('methodologyVersionOf reads only an integer version', () => {
	assert.equal(methodologyVersionOf({ methodologyVersion: 1 }), 1);
	assert.equal(methodologyVersionOf({ methodologyVersion: 0 }), 0);
	assert.equal(methodologyVersionOf({ methodologyVersion: '1' }), null);
	assert.equal(methodologyVersionOf({ methodology: 'https://…/methodology/' }), null,
		'the methodology URL is identical on every run and must never stand in for a version');
	assert.equal(methodologyVersionOf({}), null);
});

test('refuses to compare different methodology versions, and says why', () => {
	const a = run({ quarter: 'Q2-2026', version: 0, businesses: [biz({ name: 'A', url: 'https://a.co.uk/', score: 50 })] });
	const b = run({ quarter: 'Q3-2026', version: 1, businesses: [biz({ name: 'A', url: 'https://a.co.uk/', score: 90 })] });
	const d = diffRuns(a, b);
	assert.equal(d.comparable, false);
	assert.match(d.refusedBecause, /version 0 \(Q2-2026\) cannot be compared with version 1 \(Q3-2026\)/);
	assert.match(d.refusedBecause, /measures the ruler, not the business/);
	assert.deepEqual(d.matched, [], 'a refused diff reports no movement at all');
	assert.deepEqual(d.entries, []);
	assert.deepEqual(d.exits, []);
});

test('refuses when either side declares no version', () => {
	const withV = run({ quarter: 'Q3-2026', version: 1, businesses: [] });
	const without = { index: 'bath-vets', quarter: 'Q2-2026', businesses: [] };
	assert.match(diffRuns(without, withV).refusedBecause, /Q2-2026 does not declare/);
	assert.match(diffRuns(withV, without).refusedBecause, /Q2-2026 does not declare/);
	assert.match(diffRuns(without, without).refusedBecause, /Neither run declares/);
});

/* The test this whole design exists for. */
test('matches across id sources when one run predates place_id capture', () => {
	// August: no localMatch at all, exactly like data/*/history/2026-08.json
	const aug = run({ quarter: '2026-08', version: 1, businesses: [
		biz({ name: 'Kelston Vets', url: 'https://www.kelstonvets.co.uk/', score: 55 }),
	] });
	// September: place_id present
	const sep = run({ quarter: '2026-09', version: 1, businesses: [
		biz({ name: 'Kelston Vets', url: 'https://www.kelstonvets.co.uk/', placeId: 'ChIJkelston', score: 61 }),
	] });

	const d = diffRuns(aug, sep);
	assert.equal(d.matched.length, 1, 'a place_id appearing must not sever the history');
	assert.equal(d.entries.length, 0);
	assert.equal(d.exits.length, 0);
	assert.equal(d.matched[0].matchedOn, 'domain', 'matched on the strongest key the two runs SHARE');
	assert.equal(d.matched[0].idSource, 'place_id', 'but the identity still reports its own best source');
	assert.equal(d.matched[0].composite.delta, 6);
});

/* The brief's acceptance criterion, stated directly. */
test('a name change does not produce a false entry/exit pair', () => {
	const before = run({ quarter: '2026-08', version: 1, businesses: [
		biz({ name: 'Saunders Estate Agents', url: 'https://www.saunders.co.uk/', placeId: 'ChIJsaunders', score: 70 }),
	] });
	const after = run({ quarter: '2026-09', version: 1, businesses: [
		biz({ name: 'Saunders', url: 'https://www.saunders.co.uk/', placeId: 'ChIJsaunders', score: 72 }),
	] });

	const d = diffRuns(before, after);
	assert.equal(d.matched.length, 1);
	assert.equal(d.entries.length, 0, 'a rename is not an arrival');
	assert.equal(d.exits.length, 0, 'a rename is not a departure');
	assert.equal(d.matched[0].nameChanged, true);
	assert.equal(d.matched[0].previousName, 'Saunders Estate Agents');
	assert.equal(d.matched[0].name, 'Saunders');
});

test('a rename survives a simultaneous domain move, via place_id', () => {
	const before = run({ quarter: '2026-08', version: 1, businesses: [
		biz({ name: 'Old Name', url: 'https://www.oldname.co.uk/', placeId: 'ChIJsame', score: 40 }),
	] });
	const after = run({ quarter: '2026-09', version: 1, businesses: [
		biz({ name: 'New Name', url: 'https://www.newname.co.uk/', placeId: 'ChIJsame', score: 45 }),
	] });
	const d = diffRuns(before, after);
	assert.equal(d.matched.length, 1);
	assert.equal(d.matched[0].matchedOn, 'place_id');
	assert.equal(d.entries.length + d.exits.length, 0);
});

test('genuine entries and exits are still reported', () => {
	const before = run({ quarter: '2026-08', version: 1, businesses: [
		biz({ name: 'Stayer', url: 'https://stayer.co.uk/', score: 50 }),
		biz({ name: 'Leaver', url: 'https://leaver.co.uk/', score: 30 }),
	] });
	const after = run({ quarter: '2026-09', version: 1, businesses: [
		biz({ name: 'Stayer', url: 'https://stayer.co.uk/', score: 55 }),
		biz({ name: 'Arriver', url: 'https://arriver.co.uk/', score: 60 }),
	] });
	const d = diffRuns(before, after);
	assert.equal(d.matched.length, 1);
	assert.deepEqual(d.entries.map((e) => e.name), ['Arriver']);
	assert.deepEqual(d.exits.map((e) => e.name), ['Leaver']);
});

test('an ambiguous shared key is left unmatched rather than guessed', () => {
	// Two branches on one domain, no place_id to separate them. Matching either
	// one arbitrarily would swap two firms' histories.
	const before = run({ quarter: '2026-08', version: 1, businesses: [
		biz({ name: 'Chain Bath', url: 'https://chain.co.uk/bath', score: 50 }),
		biz({ name: 'Chain Bristol', url: 'https://chain.co.uk/bristol', score: 60 }),
	] });
	const after = run({ quarter: '2026-09', version: 1, businesses: [
		biz({ name: 'Chain Bath', url: 'https://chain.co.uk/bath', score: 52 }),
		biz({ name: 'Chain Bristol', url: 'https://chain.co.uk/bristol', score: 62 }),
	] });
	const d = diffRuns(before, after);
	assert.equal(d.matched.length, 0, 'no guess');
	assert.equal(d.ambiguous.a.length, 1);
	assert.equal(d.ambiguous.a[0].key, 'chain.co.uk');
	assert.equal(d.entries.length, 2, 'and the ambiguity is visible as entries/exits, not hidden');
	assert.equal(d.exits.length, 2);
});

test('place_id is settled before domain is consulted', () => {
	// B1 shares A1's place_id but B2's domain. Precedence must give A1->B1.
	const before = run({ quarter: '2026-08', version: 1, businesses: [
		biz({ name: 'First', url: 'https://shared.co.uk/', placeId: 'ChIJfirst', score: 50 }),
	] });
	const after = run({ quarter: '2026-09', version: 1, businesses: [
		biz({ name: 'First moved site', url: 'https://moved.co.uk/', placeId: 'ChIJfirst', score: 51 }),
		biz({ name: 'Other on old domain', url: 'https://shared.co.uk/', placeId: 'ChIJother', score: 20 }),
	] });
	const d = diffRuns(before, after);
	assert.equal(d.matched.length, 1);
	assert.equal(d.matched[0].matchedOn, 'place_id');
	assert.equal(d.matched[0].name, 'First moved site');
	assert.deepEqual(d.entries.map((e) => e.name), ['Other on old domain']);
});

test('a manual entry rescues a business with neither place_id nor domain', () => {
	const manualIds = indexManualIds({ 'pinned': { aliases: ['bath-vets/no-website-vets'] } });
	const before = run({ quarter: '2026-08', version: 1, businesses: [biz({ name: 'No Website Vets', url: null, score: 30 })] });
	const after = run({ quarter: '2026-09', version: 1, businesses: [biz({ name: 'No Website Vets', url: null, score: 35 })] });
	const d = diffRuns(before, after, { manualIds });
	assert.equal(d.matched.length, 1);
	assert.equal(d.matched[0].matchedOn, 'manual');
	assert.equal(d.matched[0].composite.delta, 5);
});

test('unresolved businesses are listed, not silently dropped', () => {
	const before = run({ quarter: '2026-08', version: 1, businesses: [biz({ name: 'Ghost', url: null, score: 10 })] });
	const after = run({ quarter: '2026-09', version: 1, businesses: [biz({ name: 'Ghost', url: null, score: 12 })] });
	const d = diffRuns(before, after);
	assert.equal(d.matched.length, 0);
	assert.equal(d.unresolved.a.length, 1);
	assert.equal(d.unresolved.b.length, 1);
	assert.equal(d.unresolved.b[0].name, 'Ghost');
});

test('pillar deltas, the pillar that caused the move, and coverage changes', () => {
	const before = run({ quarter: '2026-08', version: 1, businesses: [
		biz({ name: 'A', url: 'https://a.co.uk/', score: 50, pillars: { technical: 40, local: 80, speed: null } }),
	] });
	const after = run({ quarter: '2026-09', version: 1, businesses: [
		biz({ name: 'A', url: 'https://a.co.uk/', score: 62, pillars: { technical: 75, local: 78, speed: 66 } }),
	] });
	const d = diffRuns(before, after);
	const m = d.matched[0];
	assert.equal(m.pillars.technical.delta, 35);
	assert.equal(m.pillars.local.delta, -2);
	assert.equal(m.pillars.speed.delta, null, 'null -> measured has no delta to compute');
	assert.equal(m.movedBy, 'technical');
	assert.deepEqual(m.coverageChanged, ['speed'],
		'a pillar arriving is a coverage change, not the business improving');
});

test('cohort median shift is reported for composite and per pillar', () => {
	const before = run({ quarter: '2026-08', version: 1, businesses: [
		biz({ name: 'A', url: 'https://a.co.uk/', score: 40, pillars: { technical: 30 } }),
		biz({ name: 'B', url: 'https://b.co.uk/', score: 60, pillars: { technical: 50 } }),
	] });
	const after = run({ quarter: '2026-09', version: 1, businesses: [
		biz({ name: 'A', url: 'https://a.co.uk/', score: 50, pillars: { technical: 40 } }),
		biz({ name: 'B', url: 'https://b.co.uk/', score: 70, pillars: { technical: 60 } }),
	] });
	const d = diffRuns(before, after);
	assert.equal(d.cohort.medianA, 50);
	assert.equal(d.cohort.medianB, 60);
	assert.equal(d.cohort.medianDelta, 10);
	assert.equal(d.cohort.pillarMedianShift.technical.delta, 10);
	assert.equal(d.cohort.sizeA, 2);
	assert.equal(d.cohort.sizeB, 2);
});

test('moversAndFallers respects the threshold and refuses an incomparable diff', () => {
	const before = run({ quarter: '2026-08', version: 1, businesses: [
		biz({ name: 'Big riser', url: 'https://r.co.uk/', score: 40 }),
		biz({ name: 'Big faller', url: 'https://f.co.uk/', score: 80 }),
		biz({ name: 'Barely moved', url: 'https://s.co.uk/', score: 50 }),
	] });
	const after = run({ quarter: '2026-09', version: 1, businesses: [
		biz({ name: 'Big riser', url: 'https://r.co.uk/', score: 52 }),
		biz({ name: 'Big faller', url: 'https://f.co.uk/', score: 70 }),
		biz({ name: 'Barely moved', url: 'https://s.co.uk/', score: 53 }),
	] });
	const { movers, fallers } = moversAndFallers(diffRuns(before, after), { threshold: 5 });
	assert.deepEqual(movers.map((m) => m.name), ['Big riser']);
	assert.deepEqual(fallers.map((m) => m.name), ['Big faller']);

	const refused = diffRuns(run({ quarter: 'Q2-2026', version: 0, businesses: [] }), after);
	assert.equal(moversAndFallers(refused).comparable, false,
		'an incomparable diff must not yield movers to email people about');
});
