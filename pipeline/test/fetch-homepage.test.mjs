import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchHomepage, isTransientFailure } from '../lib/common.mjs';

/* A fetch that answers from a script: each entry is a Response, or an Error
   to throw. Records how many times it was asked. */
function scripted(steps) {
	const calls = [];
	const fetchImpl = async (url) => {
		calls.push(url);
		const step = steps[Math.min(calls.length, steps.length) - 1];
		if (step instanceof Error) throw step;
		return step;
	};
	return { fetchImpl, calls };
}
const html = (status) => new Response('<html></html>', { status, headers: { 'content-type': 'text/html' } });
const noSleep = async () => {};
const opts = (extra) => ({ fetchImpl: extra.fetchImpl, sleep: noSleep });

test('a dropped connection is asked again, and the answer that comes back is used', async () => {
	// Arrange
	const s = scripted([new TypeError('fetch failed'), html(200)]);
	// Act
	const res = await fetchHomepage('https://example.test/', {}, 1000, opts(s));
	// Assert
	assert.equal(res.status, 200);
	assert.equal(s.calls.length, 2);
});

test('a 5xx is retried, and the final 5xx is returned rather than thrown', async () => {
	const s = scripted([html(503), html(503), html(503)]);
	const res = await fetchHomepage('https://example.test/', {}, 1000, { ...opts(s), retries: 2 });
	assert.equal(res.status, 503);
	assert.equal(s.calls.length, 3);
});

test('gives up after the configured retries and throws the last error', async () => {
	const s = scripted([new TypeError('fetch failed')]);
	await assert.rejects(() => fetchHomepage('https://example.test/', {}, 1000, { ...opts(s), retries: 2 }), /fetch failed/);
	assert.equal(s.calls.length, 3);
});

test('a 4xx is the site\'s answer: not retried', async () => {
	const s = scripted([html(404), html(200)]);
	const res = await fetchHomepage('https://example.test/', {}, 1000, opts(s));
	assert.equal(res.status, 404);
	assert.equal(s.calls.length, 1);
});

test('the pause grows with each attempt', async () => {
	const s = scripted([new TypeError('fetch failed'), new TypeError('fetch failed'), html(200)]);
	const pauses = [];
	await fetchHomepage('https://example.test/', {}, 1000, { fetchImpl: s.fetchImpl, retryDelayMs: 10, sleep: async (ms) => { pauses.push(ms); } });
	assert.deepEqual(pauses, [10, 20]);
});

test('isTransientFailure: thrown or 5xx, never 4xx or 2xx', () => {
	assert.equal(isTransientFailure(null, new Error('x')), true);
	assert.equal(isTransientFailure({ status: 500 }, null), true);
	assert.equal(isTransientFailure({ status: 403 }, null), false);
	assert.equal(isTransientFailure({ status: 200 }, null), false);
});
