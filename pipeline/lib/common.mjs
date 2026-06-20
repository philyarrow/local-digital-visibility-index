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

export async function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		return await fetch(url, { ...opts, signal: ctrl.signal, redirect: 'follow' });
	} finally {
		clearTimeout(t);
	}
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
