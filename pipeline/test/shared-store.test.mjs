/* Unit tests for the paid-signal checkpoint in collect.mjs.
 *
 * The checkpoint exists so an interrupted collect costs time rather than
 * money: two Bristol runs killed by the host at 113 and 37 of 116 businesses
 * cost $0.43 each re-buying signals that had already been delivered.
 *
 * The dangerous half is not the saving, it is the loading. Reloading paid
 * signals against a changed basket, seed or radius would score a cohort on
 * data describing a different question, silently — worse than paying twice.
 * So most of what follows tests that the fingerprint REFUSES.
 *
 * Run: node --test test/
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprintFor, loadSharedStore, saveSharedStore } from '../collect.mjs';

const base = () => ({
	indexSlug: 'bristol-double-glazing',
	keywords: ['double glazing Bristol', 'upvc windows Bristol'],
	prompts: ['Who are the best double glazing companies in Bristol?'],
	businesses: [
		{ name: 'Caddy Windows', url: 'https://www.caddywindows.co.uk/' },
		{ name: 'Polar Bear Windows Ltd', url: 'https://www.polarbearwindows.co.uk/' },
	],
	indexCfg: { coordinate: '51.4545,-2.5879,15', locationName: 'Bristol,England,United Kingdom' },
	sector: { dfsCategories: ['double_glazing_supplier', 'glazier'] },
	engine: {
		serp: { mode: 'queue', depth: 100 },
		ai: { engine: 'perplexity', model: 'sonar' },
		local: { listingsLimit: 100, reviewDepth: 20 },
	},
});

const shared = () => ({
	serpByKeyword: new Map([['double glazing Bristol', [{ domain: 'caddywindows.co.uk', position: 3 }]]]),
	aiAnswers: [{ prompt: 'Who?', text: 'Caddy Windows' }],
	listingMatches: new Map([['Caddy Windows Bristol', { matchedBy: 'domain', items: [{ place_id: 'abc' }] }]]),
	gbpByQuery: new Map([['Polar Bear Windows Ltd Bristol', { place_id: 'def' }]]),
	reviewsByQuery: new Map([['Caddy Windows Bristol', [{ timestamp: '2026-09-01 10:00:00 +00:00' }]]]),
	targetedErrors: new Map([['Some Firm Bristol', 'ambiguous: matched several unrelated businesses']]),
});

async function tmpStore() {
	return join(await mkdtemp(join(tmpdir(), 'shared-store-')), '_shared.json');
}

test('round-trips every paid signal, Maps included', async () => {
	const path = await tmpStore();
	const fp = fingerprintFor(base());
	await saveSharedStore(path, fp, shared());

	const back = await loadSharedStore(path, fp);
	assert.ok(back, 'a matching fingerprint must load');
	assert.equal(back.serpByKeyword.get('double glazing Bristol')[0].position, 3);
	assert.equal(back.listingMatches.get('Caddy Windows Bristol').items[0].place_id, 'abc');
	assert.equal(back.gbpByQuery.get('Polar Bear Windows Ltd Bristol').place_id, 'def');
	assert.equal(back.reviewsByQuery.get('Caddy Windows Bristol').length, 1);
	assert.match(back.targetedErrors.get('Some Firm Bristol'), /ambiguous/);
	assert.equal(back.aiAnswers[0].text, 'Caddy Windows');
	assert.ok(Number.isFinite(Date.parse(back.collectedAt)), 'collectedAt drives the per-business resume');
});

test('a missing store is not an error — it just means buy it', async () => {
	assert.equal(await loadSharedStore(await tmpStore(), 'whatever'), null);
});

test('an unreadable store is not an error either', async () => {
	const path = await tmpStore();
	await writeFile(path, 'not json{');
	assert.equal(await loadSharedStore(path, 'whatever'), null);
});

/* Each of these changes what was bought. Reusing the checkpoint across any of
   them would publish a cohort measured against the wrong question. */
for (const [what, mutate] of [
	['an added keyword', (c) => c.keywords.push('window fitters Bristol')],
	['a removed keyword', (c) => c.keywords.pop()],
	['a changed AI prompt', (c) => { c.prompts[0] = 'Different prompt'; }],
	['a changed radius', (c) => { c.indexCfg.coordinate = '51.4545,-2.5879,12'; }],
	['a changed location', (c) => { c.indexCfg.locationName = 'Bath,England,United Kingdom'; }],
	['a changed category list', (c) => c.sector.dfsCategories.push('window_supplier')],
	['a business added to the seed', (c) => c.businesses.push({ name: 'Yate Windows', url: 'https://yatewindows.co.uk/' })],
	['a business removed from the seed', (c) => c.businesses.pop()],
	['a corrected seed URL', (c) => { c.businesses[0].url = 'https://caddywindows.co.uk/'; }],
	['a different index slug', (c) => { c.indexSlug = 'bath-double-glazing'; }],
	['a changed SERP depth', (c) => { c.engine.serp.depth = 20; }],
	['a changed AI engine', (c) => { c.engine.ai.engine = 'chat_gpt'; }],
	['a changed review depth', (c) => { c.engine.local.reviewDepth = 50; }],
]) {
	test(`refuses the checkpoint after ${what}`, async () => {
		const path = await tmpStore();
		await saveSharedStore(path, fingerprintFor(base()), shared());
		const changed = base();
		mutate(changed);
		assert.equal(await loadSharedStore(path, fingerprintFor(changed)), null,
			`${what} must invalidate the checkpoint`);
	});
}

test('reordering the seed does NOT invalidate — order is not something we bought', async () => {
	const path = await tmpStore();
	await saveSharedStore(path, fingerprintFor(base()), shared());
	const reordered = base();
	reordered.businesses.reverse();
	assert.ok(await loadSharedStore(path, fingerprintFor(reordered)));
});

test('the store says what it is, so a human finding it knows it is disposable', async () => {
	const path = await tmpStore();
	await saveSharedStore(path, fingerprintFor(base()), shared());
	const raw = JSON.parse(await readFile(path, 'utf8'));
	assert.match(raw.note, /Safe to delete/);
	assert.ok(raw.fingerprint && raw.collectedAt);
});
