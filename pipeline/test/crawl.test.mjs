/* Unit tests for lib/crawl.mjs: the start page's retry. No network — fetch is
   injected. Run: node --test test/ */

import test from 'node:test';
import assert from 'node:assert/strict';
import { crawlSite } from '../lib/crawl.mjs';

const HOME = 'https://example.test/';
const html = (body) => new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });

/* A fetch whose first `failures` requests for the start page fail the way an
   unreachable host fails (a thrown TypeError, which fetchText reports as
   status 0), then answer. robots.txt is always a 404 — allowed, per spec. */
function flakyFetch({ failures, failWith = () => new TypeError('fetch failed') }) {
	const calls = [];
	let left = failures;
	const impl = async (url) => {
		calls.push(url);
		if (url.endsWith('/robots.txt')) return new Response('', { status: 404 });
		if (left > 0) { left--; const f = failWith(); if (f instanceof Error) throw f; return f; }
		return html('<a href="/about">About</a>');
	};
	return { impl, calls };
}

const fast = { retryDelayMs: 0, delayMs: 0 };

test('a start page that fails once is retried and the crawl proceeds', async () => {
	const { impl, calls } = flakyFetch({ failures: 1 });
	const out = await crawlSite(HOME, { ...fast, fetchImpl: impl });
	assert.equal(out.error, null);
	assert.ok(out.pagesCrawled >= 1);
	assert.equal(calls.filter((u) => u === HOME).length, 2);
});

test('a start page that keeps failing is given up after the configured retries, with the reason kept', async () => {
	const { impl, calls } = flakyFetch({ failures: 99 });
	const out = await crawlSite(HOME, { ...fast, startPageRetries: 2, fetchImpl: impl });
	assert.equal(out.pagesCrawled, 0);
	assert.equal(out.error, 'fetch failed');
	assert.equal(calls.filter((u) => u === HOME).length, 3);
});

test('a 5xx on the start page is retried; a 404 is not', async () => {
	const five = flakyFetch({ failures: 1, failWith: () => new Response('', { status: 503 }) });
	const out5 = await crawlSite(HOME, { ...fast, fetchImpl: five.impl });
	assert.equal(out5.error, null);
	assert.equal(five.calls.filter((u) => u === HOME).length, 2);

	const four = flakyFetch({ failures: 99, failWith: () => new Response('', { status: 404 }) });
	const out4 = await crawlSite(HOME, { ...fast, fetchImpl: four.impl });
	assert.equal(out4.pagesCrawled, 0);
	assert.equal(out4.error, 'homepage HTTP 404');
	assert.equal(four.calls.filter((u) => u === HOME).length, 1);
});

test('inner pages are not retried: one failed deep link does not slow the crawl', async () => {
	const calls = [];
	const impl = async (url) => {
		calls.push(url);
		if (url.endsWith('/robots.txt')) return new Response('', { status: 404 });
		if (url === HOME) return html('<a href="/about">About</a>');
		throw new TypeError('fetch failed');
	};
	const out = await crawlSite(HOME, { ...fast, fetchImpl: impl });
	assert.equal(out.pagesCrawled, 1);
	assert.equal(out.error, null);
	assert.equal(calls.filter((u) => u.endsWith('/about')).length, 1);
});
