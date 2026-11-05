/* Unit tests for lib/release.mjs. Pure functions, literal inputs. A wrong answer
   here publishes a wrong sentence about a named business with nobody reading it
   first, so the holds and the changelog wording are pinned down exactly.
   Run: node --test test/ */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
	releaseLabel,
	calendarQuarter,
	isPeriod,
	latestPriorSnapshot,
	chooseReading,
	carryForwardPaid,
	summariseRelease,
	findHolds,
	changelogEntry,
	insertChangelogEntry,
	hasReleaseEntry,
} from '../lib/release.mjs';

function biz({ rank = 1, name, url, score, technical = 50, visibility = 50 }) {
	return {
		rank,
		name,
		url,
		digitalVisibilityScore: score,
		pillarScores: { speed: 50, technical, local: 50, visibility, ai: 50, content: 50 },
	};
}

function pairFor(overrides = {}) {
	return {
		slug: 'bath-vets',
		title: 'Bath vets',
		prior: { index: 'bath-vets', quarter: 'Q4-2026', businesses: [
			biz({ rank: 1, name: 'Alpha Vets', url: 'https://alpha.example', score: 70 }),
			biz({ rank: 2, name: 'Beta Vets', url: 'https://beta.example', score: 60 }),
			biz({ rank: 3, name: 'Gamma Vets', url: 'https://gamma.example', score: 50, technical: 10 }),
		] },
		current: { index: 'bath-vets', period: '2026-11', releaseLabel: 'November 2026', businesses: [
			biz({ rank: 1, name: 'Beta Vets', url: 'https://beta.example', score: 72, visibility: 60 }),
			biz({ rank: 2, name: 'Alpha Vets', url: 'https://alpha.example', score: 70 }),
			biz({ rank: 3, name: 'Gamma Vets', url: 'https://gamma.example', score: 40, technical: 0 }),
		] },
		technicalErrors: { 'https://gamma.example': 'homepage HTTP 403' },
		...overrides,
	};
}

const CLEAN_CONTEXT = { expectedSlugs: ['bath-vets'], scoringChanges: [], staleScorecards: [], measuredPeriod: '2026-11', period: '2026-11' };

test('releaseLabel names the month and rejects anything that is not a period', () => {
	assert.equal(releaseLabel('2026-11'), 'November 2026');
	assert.equal(releaseLabel('2027-01'), 'January 2027');
	assert.throws(() => releaseLabel('Q4-2026'), /not a period/);
	assert.throws(() => releaseLabel('2026-13'), /not a period/);
});

test('isPeriod accepts YYYY-MM only', () => {
	assert.equal(isPeriod('2026-11'), true);
	assert.equal(isPeriod('2026-00'), false);
	assert.equal(isPeriod('bristol-dentists'), false);
});

test('calendarQuarter keeps the quarter field truthful for a monthly release', () => {
	assert.equal(calendarQuarter('2026-11'), 'Q4-2026');
	assert.equal(calendarQuarter('2027-01'), 'Q1-2027');
	assert.equal(calendarQuarter('2027-03'), 'Q1-2027');
	assert.equal(calendarQuarter('2027-04'), 'Q2-2027');
});

test('latestPriorSnapshot orders quarters and months together', () => {
	const files = ['q3-2026.json', 'q4-2026.json', '2026-11.json', '2026-12.json', 'q4-2026.csv'];
	assert.equal(latestPriorSnapshot(files, { period: '2026-11' }), 'q4-2026.json');
	assert.equal(latestPriorSnapshot(files, { period: '2027-01' }), '2026-12.json');
	assert.equal(latestPriorSnapshot(files, { quarter: 'Q4-2026' }), 'q3-2026.json');
});

test('latestPriorSnapshot ignores superseded files and returns null when nothing is earlier', () => {
	assert.equal(latestPriorSnapshot(['q3-2026-superseded-2026-10-03.json'], { period: '2026-11' }), null);
	assert.equal(latestPriorSnapshot(['2026-12.json'], { period: '2026-11' }), null);
});

test('chooseReading prefers the recheck when it reached the site', () => {
	const github = { hasSitemap: false };
	const recheck = { hasSitemap: true };
	assert.deepEqual(chooseReading(github, recheck), recheck);
});

test('chooseReading keeps a real reading when the recheck failed', () => {
	const github = { hasSitemap: true };
	assert.deepEqual(chooseReading(github, { error: 'fetch failed' }), github);
});

test('chooseReading records the recheck failure when neither reached the site', () => {
	const recheck = { error: 'homepage HTTP 404' };
	assert.deepEqual(chooseReading({ error: 'fetch failed' }, recheck), recheck);
	assert.deepEqual(chooseReading(undefined, recheck), recheck);
});

test('carryForwardPaid fills only what the month did not buy, and dates it', () => {
	const record = { url: 'https://a.example', enrichment: { crawl: { pagesCrawled: 3 } } };
	const prior = { context: { gbpDetail: { totalPhotos: 9 }, backlinks: { referringDomains: 4 }, crawl: { pagesCrawled: 99 } } };
	const next = carryForwardPaid(record, prior, 'Q4-2026');
	assert.deepEqual(next.enrichment.crawl, { pagesCrawled: 3 });
	assert.deepEqual(next.enrichment.gbpDetail, { totalPhotos: 9, carriedFrom: 'Q4-2026' });
	assert.deepEqual(next.enrichment.backlinks, { referringDomains: 4, carriedFrom: 'Q4-2026' });
	assert.equal(record.enrichment.gbpDetail, undefined, 'must not mutate the input');
});

test('carryForwardPaid leaves a month that bought its own paid data alone', () => {
	const record = { enrichment: { gbpDetail: { totalPhotos: 1 }, backlinks: { referringDomains: 1 } } };
	const prior = { context: { gbpDetail: { totalPhotos: 9 }, backlinks: { referringDomains: 4 } } };
	assert.deepEqual(carryForwardPaid(record, prior, 'Q4-2026'), record);
});

test('carryForwardPaid keeps an existing carriedFrom date rather than restamping it', () => {
	const record = { enrichment: {} };
	const prior = { context: { backlinks: { referringDomains: 4, carriedFrom: 'Q4-2026' } } };
	assert.equal(carryForwardPaid(record, prior, 'November 2026').enrichment.backlinks.carriedFrom, 'Q4-2026');
});

test('carryForwardPaid is a no-op with no prior business', () => {
	const record = { enrichment: {} };
	assert.deepEqual(carryForwardPaid(record, null, 'Q4-2026'), record);
});

test('summariseRelease counts score, rank, first-place and newly zero movement', () => {
	const s = summariseRelease([pairFor()]);
	assert.equal(s.firms, 3);
	assert.equal(s.changed, 2);
	assert.equal(s.higher, 1);
	assert.equal(s.lower, 1);
	assert.equal(s.rankChanged, 2);
	assert.deepEqual(s.newFirstPlaces, [{ title: 'Bath vets', from: 'Alpha Vets', to: 'Beta Vets' }]);
	assert.deepEqual(s.newTechnicalZeros, [{ title: 'Bath vets', name: 'Gamma Vets', error: 'homepage HTTP 403' }]);
	assert.equal(s.priorLabel, 'Q4-2026');
	assert.deepEqual(s.medians, [{ title: 'Bath vets', firms: 3, prior: 60, current: 70 }]);
	assert.equal(s.pillars.visibility.up, 1);
	assert.equal(s.pillars.technical.down, 1);
});

test('summariseRelease does not call an unchanged zero newly zero', () => {
	const pair = pairFor();
	const prior = { ...pair.prior, businesses: pair.prior.businesses.map((b) => (b.name === 'Gamma Vets' ? biz({ ...b, name: b.name, url: b.url, score: b.digitalVisibilityScore, rank: b.rank, technical: 0 }) : b)) };
	assert.deepEqual(summariseRelease([{ ...pair, prior }]).newTechnicalZeros, []);
});

test('summariseRelease prefers the release label of a monthly prior', () => {
	const pair = pairFor();
	const prior = { ...pair.prior, quarter: 'Q4-2026', releaseLabel: 'October 2026' };
	assert.equal(summariseRelease([{ ...pair, prior }]).priorLabel, 'October 2026');
});

test('summariseRelease reports firms that joined or left', () => {
	const pair = pairFor();
	const current = { ...pair.current, businesses: [
		...pair.current.businesses.filter((b) => b.name !== 'Gamma Vets'),
		biz({ rank: 3, name: 'Delta Vets', url: 'https://delta.example', score: 30 }),
	] };
	const s = summariseRelease([{ ...pair, current }]);
	assert.deepEqual(s.joined, [{ title: 'Bath vets', name: 'Delta Vets' }]);
	assert.deepEqual(s.left, [{ title: 'Bath vets', name: 'Gamma Vets' }]);
});

test('findHolds is empty for an ordinary month', () => {
	assert.deepEqual(findHolds(summariseRelease([pairFor()]), CLEAN_CONTEXT), []);
});

test('findHolds stops a release missing an index', () => {
	const holds = findHolds(summariseRelease([pairFor()]), { ...CLEAN_CONTEXT, expectedSlugs: ['bath-vets', 'bristol-vets'] });
	assert.match(holds.join(), /bristol-vets/);
});

test('findHolds stops a release when scoring code changed', () => {
	const holds = findHolds(summariseRelease([pairFor()]), { ...CLEAN_CONTEXT, scoringChanges: ['pipeline/score.mjs'] });
	assert.match(holds.join(), /pipeline\/score\.mjs/);
});

test('findHolds stops a release with a stale scorecard', () => {
	const holds = findHolds(summariseRelease([pairFor()]), { ...CLEAN_CONTEXT, staleScorecards: ['bath-vets/old-firm'] });
	assert.match(holds.join(), /bath-vets\/old-firm/);
});

test('findHolds stops a release measured in the wrong month', () => {
	const holds = findHolds(summariseRelease([pairFor()]), { ...CLEAN_CONTEXT, measuredPeriod: '2026-10' });
	assert.match(holds.join(), /2026-10/);
});

test('findHolds stops a burst of newly zero firms', () => {
	const s = { ...summariseRelease([pairFor()]), newTechnicalZeros: Array.from({ length: 16 }, (_, i) => ({ title: 'Bath vets', name: `F${i}`, error: 'fetch failed' })) };
	assert.match(findHolds(s, CLEAN_CONTEXT).join(), /16 businesses newly score 0/);
});

test('findHolds tolerates the limit itself', () => {
	const s = { ...summariseRelease([pairFor()]), newTechnicalZeros: Array.from({ length: 15 }, (_, i) => ({ title: 'Bath vets', name: `F${i}`, error: 'fetch failed' })) };
	assert.deepEqual(findHolds(s, CLEAN_CONTEXT), []);
});

test('findHolds stops an index median jump', () => {
	const s = { ...summariseRelease([pairFor()]), medians: [{ title: 'Bath vets', firms: 3, prior: 60, current: 44 }] };
	assert.match(findHolds(s, CLEAN_CONTEXT).join(), /Bath vets median moved 16/);
});

test('findHolds stops a pillar-wide shift', () => {
	const base = summariseRelease([pairFor()]);
	const s = { ...base, pillars: { ...base.pillars, visibility: { ...base.pillars.visibility, mean: -13 } } };
	assert.match(findHolds(s, CLEAN_CONTEXT).join(), /visibility moved -13/);
});

test('findHolds stops a jump in unmeasured firms', () => {
	const base = summariseRelease([pairFor()]);
	const s = { ...base, pillars: { ...base.pillars, speed: { ...base.pillars.speed, unmeasuredPrior: 0, unmeasuredCurrent: 1 } } };
	assert.match(findHolds(s, CLEAN_CONTEXT).join(), /speed could not be measured/);
});

test('changelogEntry states the headline, medians, zeros and how it was published', () => {
	const entry = changelogEntry(summariseRelease([pairFor()]), {
		period: '2026-11', publishedOn: '2026-11-05', collectedFrom: '2026-11-01', collectedTo: '2026-11-02', recheckedOn: '2026-11-05',
	});
	assert.match(entry, /^### 5 November 2026 \(release\) — November 2026: every index re-measured/);
	assert.match(entry, /collected again between 1 and 2 November 2026/);
	assert.match(entry, /\*\*2 of 3 businesses have a different Digital Visibility Score from Q4-2026 — 1 higher, 1 lower — 2 changed rank, and 1 of 1 indices have a new first place\.\*\*/);
	assert.match(entry, /re-read for every business on 5 November 2026/);
	assert.match(entry, /Gamma Vets \(Bath vets\)/);
	assert.match(entry, /\| Bath vets \| 3 \| 60 \| \*\*70\*\* \|/);
	assert.match(entry, /Bath vets:\*\* Alpha Vets → \*\*Beta Vets\*\*/);
	assert.match(entry, /published automatically/);
});

test('changelogEntry never asserts why scores moved', () => {
	const entry = changelogEntry(summariseRelease([pairFor()]), {
		period: '2026-11', publishedOn: '2026-11-05', collectedFrom: '2026-11-01', collectedTo: '2026-11-02', recheckedOn: '2026-11-05',
	});
	assert.match(entry, /we do not claim to know why/i);
});

test('changelogEntry escapes characters that would break a table row', () => {
	const pair = pairFor({ title: 'A | B vets' });
	const entry = changelogEntry(summariseRelease([pair]), {
		period: '2026-11', publishedOn: '2026-11-05', collectedFrom: '2026-11-01', collectedTo: '2026-11-02', recheckedOn: '2026-11-05',
	});
	assert.match(entry, /\| A \\\| B vets \| 3 \|/);
});

const CHANGELOG = `---
title: "Index changelog"
lastUpdated: 2026-10-08T12:00:00Z
---

Intro.

## 2026

### 8 October 2026 (release) — Q4-2026: every index re-measured

Old entry.
`;

test('insertChangelogEntry puts the newest entry first and updates lastUpdated', () => {
	const out = insertChangelogEntry(CHANGELOG, '### 5 November 2026 (release) — November 2026\n\nNew.', '2026-11-05');
	assert.match(out, /lastUpdated: 2026-11-05T12:00:00Z/);
	assert.ok(out.indexOf('5 November 2026') < out.indexOf('8 October 2026'));
	assert.ok(out.indexOf('## 2026') < out.indexOf('5 November 2026'));
});

test('insertChangelogEntry starts a new year heading in January', () => {
	const out = insertChangelogEntry(CHANGELOG, '### 3 January 2027 (release) — January 2027\n\nNew.', '2027-01-03');
	assert.ok(out.indexOf('## 2027') < out.indexOf('3 January 2027'));
	assert.ok(out.indexOf('3 January 2027') < out.indexOf('## 2026'));
});

test('insertChangelogEntry refuses a changelog it cannot place the entry in', () => {
	assert.throws(() => insertChangelogEntry('no headings', 'x', '2026-11-05'), /year heading/);
});

test('hasReleaseEntry recognises a published month only', () => {
	assert.equal(hasReleaseEntry('### 5 November 2026 (release) — November 2026: x', '2026-11'), true);
	assert.equal(hasReleaseEntry('### 5 November 2026 (methodology) — November 2026: x', '2026-11'), false);
	assert.equal(hasReleaseEntry(CHANGELOG, '2026-11'), false);
});
