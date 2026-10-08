/* Shared helpers for the Local Digital Visibility Index pipeline.
   Node ESM, built-ins only. */

import { basename } from 'node:path';

/* ---- slugs ---- */

export function slugify(s) {
	return (s || '')
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/&/g, ' and ')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 80) || 'untitled';
}

/* derive the index slug from a seed csv path: seeds/bristol-estate-agents.csv -> bristol-estate-agents */
export function indexSlugFromSeed(seedPath) {
	return basename(seedPath, '.csv');
}

/* ---- minimal CSV (handles quoted fields + embedded commas/quotes) ---- */

export function parseCsv(text) {
	const rows = [];
	let row = [];
	let field = '';
	let inQuotes = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (inQuotes) {
			if (c === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				field += c;
			}
		} else if (c === '"') {
			inQuotes = true;
		} else if (c === ',') {
			row.push(field);
			field = '';
		} else if (c === '\n' || c === '\r') {
			if (c === '\r' && text[i + 1] === '\n') i++;
			row.push(field);
			rows.push(row);
			row = [];
			field = '';
		} else {
			field += c;
		}
	}
	if (field.length > 0 || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	return rows.filter((r) => r.length && r.some((v) => v.trim() !== ''));
}

/* parse a seed csv into [{ name, url, gbp_query }] using the header row */
export function parseSeed(text) {
	const rows = parseCsv(text);
	if (!rows.length) return [];
	const header = rows[0].map((h) => h.trim().toLowerCase());
	const idx = (k) => header.indexOf(k);
	const iName = idx('name');
	const iUrl = idx('url');
	const iGbp = idx('gbp_query');
	return rows.slice(1).map((r) => ({
		name: (r[iName] || '').trim(),
		url: (r[iUrl] || '').trim(),
		gbp_query: (r[iGbp] || '').trim(),
	})).filter((b) => b.name && b.url);
}

/* serialise an array of flat objects to CSV (RFC-4180-ish) */
export function toCsv(rows, columns) {
	const esc = (v) => {
		const s = v === null || v === undefined ? '' : String(v);
		return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
	};
	const head = columns.join(',');
	const body = rows.map((r) => columns.map((c) => esc(r[c])).join(',')).join('\n');
	return `${head}\n${body}\n`;
}

/* ---- fetch with timeout, never throws on timeout shape ---- */

export async function fetchWithTimeout(url, opts = {}, timeoutMs = 15000, fetchImpl = null) {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		return await (fetchImpl || fetch)(url, { ...opts, signal: ctrl.signal, redirect: 'follow' });
	} finally {
		clearTimeout(t);
	}
}

/* ---- the homepage fetch behind a scored pillar: one more chance ---- */

export const HOMEPAGE_RETRIES = 2;
export const HOMEPAGE_RETRY_DELAY_MS = 2000;

/* Transient means the request never got an answer (DNS, reset, timeout — the
   fetch throws) or the server answered 5xx. A 4xx is the site's answer and
   asking again does not change it. Same rule as the crawler's start page in
   lib/crawl.mjs. */
export const isTransientFailure = (res, err) => Boolean(err) || (res?.status ?? 0) >= 500;

/* Technical and Content & trust are both scored from one fetch of the
   homepage. The crawler (lib/crawl.mjs) retried its start page from 3 October
   2026; these two fetches did not, so a single dropped connection could still
   score a firm as if it had no website — Technical to 0, Content excluded.
   Retries the same way: on a transient failure only, with a growing pause.
   The last answer stands: the final response is returned, the final error
   thrown, so callers read the result exactly as they read fetchWithTimeout. */
export async function fetchHomepage(url, opts = {}, timeoutMs = 15000, {
	retries = HOMEPAGE_RETRIES,
	retryDelayMs = HOMEPAGE_RETRY_DELAY_MS,
	fetchImpl = null,
	sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
	let last = { res: null, err: null };
	for (let attempt = 0; attempt <= retries; attempt++) {
		if (attempt > 0) await sleep(retryDelayMs * attempt);
		try {
			const res = await fetchWithTimeout(url, opts, timeoutMs, fetchImpl);
			last = { res, err: null };
		} catch (err) {
			last = { res: null, err };
		}
		if (!isTransientFailure(last.res, last.err)) break;
	}
	if (last.err) throw last.err;
	return last.res;
}

/* clamp a number into [0,100] */
export function clamp100(n) {
	if (n === null || n === undefined || Number.isNaN(n)) return null;
	return Math.max(0, Math.min(100, n));
}

/* median of a numeric array, ignoring null/undefined/NaN */
export function median(values) {
	const nums = values.filter((v) => typeof v === 'number' && !Number.isNaN(v)).sort((a, b) => a - b);
	if (!nums.length) return null;
	const mid = Math.floor(nums.length / 2);
	return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

/* the six pillars + canonical weights from the published methodology */
export const PILLARS = [
	{ key: 'speed', label: 'Speed & CWV', weight: 20 },
	{ key: 'technical', label: 'Technical', weight: 20 },
	{ key: 'local', label: 'Local presence', weight: 20 },
	{ key: 'visibility', label: 'Visibility', weight: 15 },
	{ key: 'ai', label: 'AI search presence', weight: 15 },
	{ key: 'content', label: 'Content & trust', weight: 10 },
];
