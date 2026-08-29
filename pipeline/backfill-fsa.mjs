/* One-off backfill: add FSA hygiene ratings to an already-collected index.
 *
 * The FSA API is free and unauthenticated, so this needs no re-collection and
 * spends nothing. Future collections pick it up from collect.mjs directly.
 *
 *   node backfill-fsa.mjs gloucester-restaurants
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectFsa } from './lib/enrich.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const slug = process.argv[2];
if (!slug) { console.error('Usage: node backfill-fsa.mjs <index-slug>'); process.exit(1); }

const cfg = JSON.parse(await readFile(join(HERE, 'config', 'indices.json'), 'utf8'))[slug];
if (!cfg) { console.error(`Unknown index "${slug}"`); process.exit(1); }

const dir = join(HERE, 'data', slug);
const files = (await readdir(dir)).filter((f) => !f.startsWith('_') && f.endsWith('.json'));

let matched = 0;
for (const f of files) {
	const path = join(dir, f);
	const rec = JSON.parse(await readFile(path, 'utf8'));
	const fsa = await collectFsa(rec.name, { town: cfg.town, coordinate: cfg.coordinate });
	rec.enrichment = rec.enrichment || {};
	rec.enrichment.fsa = fsa;
	await writeFile(path, JSON.stringify(rec, null, 2) + '\n');
	if (fsa.matched) matched++;
	console.log(`  ${rec.name.slice(0, 34).padEnd(36)}${fsa.matched ? `rating ${fsa.ratingValue} (${fsa.locatedBy})` : '—'}`);
}
console.log(`\n${matched} of ${files.length} matched to the FSA register.`);
