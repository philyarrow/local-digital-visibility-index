/* Unit tests for lib/identity.mjs. Built-in node:test — no dependency added,
   which is the pipeline's standing rule. Run: node --test test/ */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
	normaliseDomain, placeIdOf, manualKey, indexManualIds,
	resolveBusinessId, resolveCohort, ID_SOURCES,
} from '../lib/identity.mjs';

test('normaliseDomain strips protocol, www, path, query and case', () => {
	const expected = 'bathvetgroup.co.uk';
	for (const input of [
		'https://www.bathvetgroup.co.uk/',
		'http://bathvetgroup.co.uk',
		'https://WWW.BathVetGroup.CO.UK/about-us/practices/rosemary-lodge?utm_source=gmb&utm_medium=organic',
		'https://www.bathvetgroup.co.uk/deep/path/',
	]) {
		assert.equal(normaliseDomain(input), expected, `failed on ${input}`);
	}
});

test('normaliseDomain keeps the registrable domain for multi-part TLDs', () => {
	// The whole point: co.uk is a public suffix, so three labels are registrable.
	assert.equal(normaliseDomain('https://shop.allenandharris.co.uk/'), 'allenandharris.co.uk');
	assert.equal(normaliseDomain('https://www.example.com/'), 'example.com');
	assert.equal(normaliseDomain('https://a.b.example.com/'), 'example.com');
});

test('normaliseDomain does not confuse a lookalike domain for the real one', () => {
	// The substring bug match.mjs was written to prevent, asserted here too
	// because identity now depends on it.
	assert.notEqual(
		normaliseDomain('https://notallenandharris.co.uk/'),
		normaliseDomain('https://allenandharris.co.uk/'),
	);
});

test('normaliseDomain returns null rather than throwing on rubbish', () => {
	for (const input of [null, undefined, '', 'not a url', 'mailto:info@example.com']) {
		assert.equal(normaliseDomain(input), null, `failed on ${JSON.stringify(input)}`);
	}
});

test('placeIdOf reads both the published and the raw record shape', () => {
	assert.equal(placeIdOf({ localMatch: { placeId: 'ChIJabc' } }), 'ChIJabc');
	assert.equal(placeIdOf({ pillars: { local: { placeId: 'ChIJxyz' } } }), 'ChIJxyz');
	assert.equal(placeIdOf({ localMatch: { placeId: null } }), null);
	assert.equal(placeIdOf({}), null);
	assert.equal(placeIdOf(null), null);
	assert.equal(placeIdOf({ localMatch: { placeId: '   ' } }), null, 'whitespace is not an id');
});

test('manualKey mirrors the page-URL slug', () => {
	assert.equal(manualKey('bath-vets', 'Kelston Vets'), 'bath-vets/kelston-vets');
	assert.equal(manualKey('bristol-estate-agents', 'Allen & Harris'), 'bristol-estate-agents/allen-and-harris');
	assert.equal(manualKey(null, 'Kelston Vets'), null);
});

test('place_id wins over domain and manual', () => {
	const manualIds = indexManualIds({ 'pinned-id': { aliases: ['bath-vets/kelston-vets'] } });
	const r = resolveBusinessId(
		{ name: 'Kelston Vets', url: 'https://www.kelstonvets.co.uk/', localMatch: { placeId: 'ChIJreal' } },
		{ indexSlug: 'bath-vets', manualIds },
	);
	assert.equal(r.id, 'ChIJreal');
	assert.equal(r.idSource, 'place_id');
	assert.equal(r.resolved, true);
	// every key still present — this is what makes cross-source matching work
	assert.equal(r.keys.domain, 'kelstonvets.co.uk');
	assert.equal(r.keys.manual, 'pinned-id');
});

test('domain is used when there is no place_id', () => {
	const r = resolveBusinessId({ name: 'Kelston Vets', url: 'https://www.kelstonvets.co.uk/' }, { indexSlug: 'bath-vets' });
	assert.equal(r.id, 'kelstonvets.co.uk');
	assert.equal(r.idSource, 'domain');
	assert.equal(r.keys.place_id, null);
});

test('manual entry resolves by alias and by pinned url', () => {
	const manualIds = indexManualIds({
		'saunders-bristol': {
			aliases: ['bristol-estate-agents/saunders-estate-agents'],
			urls: ['https://www.saundersproperty.co.uk/'],
		},
	});
	const byAlias = resolveBusinessId(
		{ name: 'Saunders Estate Agents', url: null },
		{ indexSlug: 'bristol-estate-agents', manualIds },
	);
	assert.equal(byAlias.id, 'saunders-bristol');
	assert.equal(byAlias.idSource, 'manual');

	// A rename breaks the alias but not the pinned URL — the reason urls exist.
	const afterRename = resolveBusinessId(
		{ name: 'Saunders', url: 'https://www.saundersproperty.co.uk/' },
		{ indexSlug: 'bristol-estate-agents', manualIds },
	);
	assert.equal(afterRename.keys.manual, 'saunders-bristol');
});

test('an unidentifiable business is reported, never guessed from its name', () => {
	const r = resolveBusinessId({ name: 'Some Firm Ltd', url: null }, { indexSlug: 'bath-vets' });
	assert.equal(r.resolved, false);
	assert.equal(r.id, null);
	assert.equal(r.idSource, null);
	assert.match(r.reason, /no place_id/);
	// the name must not have leaked into any key
	for (const source of ID_SOURCES) assert.equal(r.keys[source], null);
});

test('resolveBusinessId never throws on a malformed record', () => {
	for (const input of [null, undefined, {}, { url: 12 }, { name: {} }]) {
		assert.doesNotThrow(() => resolveBusinessId(input, { indexSlug: 'x' }));
	}
});

test('resolveCohort flags a key claimed by two businesses', () => {
	// Two branches of one chain seeded separately: same domain, no place_id.
	const { ambiguous, resolved } = resolveCohort([
		{ name: 'Chain Vets Bath', url: 'https://www.chainvets.co.uk/bath' },
		{ name: 'Chain Vets Bristol', url: 'https://www.chainvets.co.uk/bristol' },
	], { indexSlug: 'bath-vets' });
	assert.equal(resolved.length, 2);
	assert.equal(ambiguous.length, 1);
	assert.equal(ambiguous[0].source, 'domain');
	assert.equal(ambiguous[0].key, 'chainvets.co.uk');
	assert.deepEqual(ambiguous[0].names.sort(), ['Chain Vets Bath', 'Chain Vets Bristol']);
});

test('resolveCohort separates unresolved from resolved without dropping either', () => {
	const { resolved, unresolved } = resolveCohort([
		{ name: 'Has Domain', url: 'https://a.co.uk/' },
		{ name: 'Has Nothing', url: null },
	], { indexSlug: 'x' });
	assert.equal(resolved.length, 1);
	assert.equal(unresolved.length, 1);
	assert.equal(unresolved[0].name, 'Has Nothing');
});
