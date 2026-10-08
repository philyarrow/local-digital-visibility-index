import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cohortNouns, indexTitle } from '../lib/cohort.mjs';

test('index title is derived from the slug as before', () => {
	assert.equal(indexTitle('bristol-estate-agents'), 'Bristol Estate Agent');
	assert.equal(indexTitle('gloucestershire-double-glazing'), 'Gloucestershire Double Glazing');
});

test('with config, the cohort is the sector noun in the place', () => {
	const nouns = cohortNouns('gloucestershire-double-glazing', { town: 'Gloucestershire' }, { label: 'double glazing companies', singular: 'double glazing company' });
	assert.deepEqual(nouns, { plural: 'double glazing companies in Gloucestershire', singular: 'double glazing company in Gloucestershire' });
});

test('without config, the title is used with "firms" rather than a bare s', () => {
	assert.deepEqual(cohortNouns('cheltenham-construction'), { plural: 'cheltenham construction firms', singular: 'cheltenham construction firm' });
	assert.deepEqual(cohortNouns('cheltenham-construction', { town: 'Cheltenham' }, { label: 'construction firms' }), { plural: 'cheltenham construction firms', singular: 'cheltenham construction firm' });
});
