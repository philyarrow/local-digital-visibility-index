/* Re-run the Content & trust homepage checks against already-collected records.
 *
 * The credentials check was sector-blind: it matched only property-sector
 * bodies while being applied to every index, so construction, law, accountancy
 * and dental cohorts scored near zero on a signal they may well pass. That is a
 * defect in one signal, not in the measurement as a whole.
 *
 * Re-collecting everything would fix it and simultaneously re-measure five
 * other pillars, so the resulting score movement could not be attributed to the
 * correction rather than to sites genuinely changing. This re-fetches only the
 * homepage and rewrites only pillars.content, which keeps the correction
 * isolated and costs nothing — no paid API is involved.
 *
 *   node backfill-content.mjs            # every published index
 *   node backfill-content.mjs <slug>     # one
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectContent } from './collect.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const only = process.argv[2] || null;

const indices = JSON.parse(await readFile(join(HERE, 'config', 'indices.json'), 'utf8'));
const sectors = JSON.parse(await readFile(join(HERE, 'config', 'sectors.json'), 'utf8'));
/* Published indices by default; name a slug to reach an unpublished one.
   Free to run, so this is about not silently rewriting pillars.content on a
   cohort nobody has reviewed rather than about spend. */
const slugs = Object.keys(indices)
	.filter((k) => !k.startsWith('_'))
	.filter((k) => (only ? k === only : indices[k]?.publish === true));

let totalChanged = 0, totalSeen = 0;

for (const slug of slugs) {
	const dir = join(HERE, 'data', slug);
	let files;
	try {
		files = (await readdir(dir)).filter((f) => !f.startsWith('_') && f.endsWith('.json'));
	} catch {
		console.log(`  ${slug.padEnd(26)} not collected — skipped`);
		continue;
	}
	if (!files.length) { console.log(`  ${slug.padEnd(26)} no records — skipped`); continue; }

	const sectorCfg = sectors[indices[slug].sector] || null;
	let changed = 0;

	for (const f of files) {
		const path = join(dir, f);
		const rec = JSON.parse(await readFile(path, 'utf8'));
		const before = rec.pillars?.content?.hasCredentialsLink ?? null;

		const content = await collectContent(rec.url, sectorCfg);
		/* A fetch that fails now must not erase a check that succeeded before:
		   the point is to correct a signal, not to lose one. */
		if (content.error && before !== null) continue;

		rec.pillars.content = content;
		await writeFile(path, JSON.stringify(rec, null, 2) + '\n');
		if ((content.hasCredentialsLink ?? null) !== before) changed++;
		totalSeen++;
	}
	totalChanged += changed;
	console.log(`  ${slug.padEnd(26)} ${String(files.length).padStart(3)} records, ${changed} credentials flags changed`);
}

console.log(`\n${totalChanged} of ${totalSeen} businesses had their credentials check change.`);
console.log('Next: node score.mjs <slug> && node generate.mjs <slug> …  (or ./regenerate-all.sh)');
