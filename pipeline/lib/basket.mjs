/* Keyword and AI-prompt basket generation.

   Baskets are derived from config, not hardcoded per index: a sector supplies
   the templates, an index supplies the town and areas. That is what makes
   adding the 24th index a config entry rather than a code change.
*/

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_ROOT = join(HERE, '..', 'config');

function readJson(name) {
	return JSON.parse(readFileSync(join(CONFIG_ROOT, name), 'utf8'));
}

export function loadConfig() {
	return {
		engine: readJson('engine.json'),
		sectors: readJson('sectors.json'),
		indices: readJson('indices.json'),
	};
}

/* Resolve one index slug to { index, sector, engine }, throwing a message that
   says exactly what to add rather than a bare undefined-property crash. */
export function resolveIndex(slug, config = loadConfig()) {
	const index = config.indices[slug];
	if (!index) {
		const known = Object.keys(config.indices).filter((k) => !k.startsWith('_')).join(', ');
		throw new Error(`No entry for "${slug}" in config/indices.json. Known indices: ${known}`);
	}
	const sector = config.sectors[index.sector];
	if (!sector) {
		const known = Object.keys(config.sectors).filter((k) => !k.startsWith('_')).join(', ');
		throw new Error(`Index "${slug}" names sector "${index.sector}", which is not in config/sectors.json. Known sectors: ${known}`);
	}
	return { index, sector, engine: config.engine };
}

function fill(template, vars) {
	return template.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
}

/* Town keywords first, then area keywords cycled across the configured areas,
   deduped and truncated to engine.keywordsPerIndex. Area keywords come second
   because they are the ones worth dropping when the budget tightens. */
export function buildKeywords(slug, config = loadConfig()) {
	const { index, sector, engine } = resolveIndex(slug, config);
	const limit = engine.keywordsPerIndex || 12;
	const out = [];

	for (const t of sector.keywords || []) {
		out.push(fill(t, { town: index.town, sector: sector.label }));
	}
	for (const t of sector.areaKeywords || []) {
		for (const area of index.areas || []) {
			out.push(fill(t, { area, town: index.town, sector: sector.label }));
		}
	}

	const seen = new Set();
	const deduped = [];
	for (const k of out) {
		const key = k.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(k);
	}
	return deduped.slice(0, limit);
}

/* AI prompts. {area} resolves to the first configured area; a prompt whose
   placeholders cannot be filled is dropped rather than sent with a literal
   "{area}" in it. */
export function buildPrompts(slug, config = loadConfig()) {
	const { index, sector, engine } = resolveIndex(slug, config);
	const limit = engine.ai?.promptsPerIndex || 5;
	const vars = {
		town: index.town,
		sector: sector.label,
		area: (index.areas || [])[0],
	};
	const out = [];
	for (const t of sector.prompts || []) {
		const filled = fill(t, vars);
		if (/\{\w+\}/.test(filled)) continue;
		out.push(filled);
	}
	return out.slice(0, limit);
}
