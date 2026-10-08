/* Re-check the homepage behind Technical and Content & trust for records whose
 * first fetch failed transiently.
 *
 * Both pillars are scored from one fetch of the homepage. Until 8 October 2026
 * that fetch was made once: a dropped connection, a timeout or a 5xx on the
 * day scored the firm as if it had no website — Technical to 0, Content
 * excluded. The crawler's start page had been retried since 3 October
 * (lib/crawl.mjs); the pillar fetches had not. collect.mjs now retries them
 * (fetchHomepage in lib/common.mjs).
 *
 * This applies that retry to records already collected, and only to the ones
 * it could change: a 404 or 403 is the site's answer and is left alone. A
 * record that still fails keeps its failure. Nothing paid is touched, and no
 * other pillar is rewritten, so any movement is attributable to this one fix.
 *
 *   node backfill-technical.mjs            # every published index
 *   node backfill-technical.mjs <slug> …   # named indices
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectTechnical, collectContent } from './collect.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));

const indices = JSON.parse(await readFile(join(HERE, 'config', 'indices.json'), 'utf8'));
const sectors = JSON.parse(await readFile(join(HERE, 'config', 'sectors.json'), 'utf8'));
const slugs = Object.keys(indices)
	.filter((k) => !k.startsWith('_'))
	.filter((k) => (only.length ? only.includes(k) : indices[k]?.publish === true));

/* The failure strings collect.mjs writes for a request that got no answer or
   a server error. "homepage HTTP 404" and friends are deliberately absent. */
const TRANSIENT = /^(fetch failed|homepage timeout|homepage HTTP 5\d\d)$/;
const PILLARS = ['technical', 'content'];
const isTransient = (pillar) => TRANSIENT.test(pillar?.error ?? '');

const recovered = [];
let retried = 0;

for (const slug of slugs) {
	const dir = join(HERE, 'data', slug);
	let files;
	try { files = (await readdir(dir)).filter((f) => !f.startsWith('_') && f.endsWith('.json')); }
	catch { console.log(`  ${slug.padEnd(30)} not collected — skipped`); continue; }

	const sectorCfg = sectors[indices[slug].sector] || null;
	let seen = 0, back = 0;

	for (const f of files) {
		const path = join(dir, f);
		const rec = JSON.parse(await readFile(path, 'utf8'));
		if (!PILLARS.some((p) => isTransient(rec.pillars?.[p]))) continue;
		seen++;

		const technical = await collectTechnical(rec.url);
		const content = await collectContent(rec.url, sectorCfg);
		const next = {
			...rec,
			pillars: { ...rec.pillars, technical, content },
			errors: [
				...(rec.errors ?? []).filter((e) => !PILLARS.some((p) => e.startsWith(`${p}: `))),
				...PILLARS.flatMap((p) => ({ technical, content })[p].error ? [`${p}: ${({ technical, content })[p].error}`] : []),
			],
		};
		await writeFile(path, JSON.stringify(next, null, 2) + '\n');

		const nowOk = !technical.error && !content.error;
		if (nowOk) { back++; recovered.push(`${slug}: ${rec.name}`); }
		const was = PILLARS.map((p) => rec.pillars?.[p]?.error).filter(Boolean).join(' / ');
		const now = PILLARS.map((p) => ({ technical, content })[p].error).filter(Boolean).join(' / ') || 'reached';
		console.log(`    ${rec.name.slice(0, 40).padEnd(42)} ${was}  →  ${now}`);
	}
	retried += seen;
	console.log(`  ${slug.padEnd(30)} ${String(seen).padStart(3)} re-checked, ${back} reached\n`);
}

console.log(`${retried} businesses re-checked; ${recovered.length} reached on retry:`);
for (const r of recovered) console.log(`  ${r}`);
console.log('Next: node score.mjs <slug> …  (or ./regenerate-all.sh)');
