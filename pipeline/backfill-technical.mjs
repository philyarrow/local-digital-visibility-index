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
 * --all re-reads every business rather than only the failures, and is how a
 * monthly release gets both pillars from one connection. Collection runs on a
 * GitHub machine, and from there some sites refuse the request (403), drop it,
 * or answer 200 with a page that is not the site, which reads as a site with no
 * sitemap, viewport or schema. In November 2026 that wrongly zeroed 17 firms and
 * lowered about half of the rest of the fallers. A failed re-read never replaces
 * a good reading.
 *
 *   node backfill-technical.mjs            # every published index
 *   node backfill-technical.mjs <slug> …   # named indices
 *   node backfill-technical.mjs --all [--concurrency 6]
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectTechnical, collectContent } from './collect.mjs';
import { chooseReading } from './lib/release.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const ALL = argv.includes('--all');
const concurrencyAt = argv.indexOf('--concurrency');
const CONCURRENCY = concurrencyAt === -1 ? 1 : Number(argv[concurrencyAt + 1]);
if (!Number.isInteger(CONCURRENCY) || CONCURRENCY < 1) throw new Error('--concurrency needs a positive whole number');
const only = argv.filter((a, i) => !a.startsWith('--') && i !== concurrencyAt + 1);

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
const needsRecheck = (rec) => ALL || PILLARS.some((p) => isTransient(rec.pillars?.[p]));

async function recheck(path, rec, sectorCfg) {
	const technical = chooseReading(rec.pillars?.technical, await collectTechnical(rec.url));
	const content = chooseReading(rec.pillars?.content, await collectContent(rec.url, sectorCfg));
	const next = {
		...rec,
		pillars: { ...rec.pillars, technical, content },
		errors: [
			...(rec.errors ?? []).filter((e) => !PILLARS.some((p) => e.startsWith(`${p}: `))),
			...PILLARS.flatMap((p) => ({ technical, content })[p].error ? [`${p}: ${({ technical, content })[p].error}`] : []),
		],
	};
	await writeFile(path, JSON.stringify(next, null, 2) + '\n');
	return {
		name: rec.name,
		was: PILLARS.map((p) => rec.pillars?.[p]?.error).filter(Boolean).join(' / '),
		now: PILLARS.map((p) => ({ technical, content })[p].error).filter(Boolean).join(' / ') || 'reached',
	};
}

/* Different sites each time, so concurrency costs no single site anything. */
async function inPool(items, worker) {
	const queue = [...items.entries()];
	const results = [];
	await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
		for (let next = queue.shift(); next; next = queue.shift()) {
			results[next[0]] = await worker(next[1]);
		}
	}));
	return results;
}

const recovered = [];
let retried = 0;

for (const slug of slugs) {
	const dir = join(HERE, 'data', slug);
	let files;
	try { files = (await readdir(dir)).filter((f) => !f.startsWith('_') && f.endsWith('.json')); }
	catch { console.log(`  ${slug.padEnd(30)} not collected — skipped`); continue; }

	const sectorCfg = sectors[indices[slug].sector] || null;
	const records = await Promise.all(files.map(async (f) => ({ path: join(dir, f), rec: JSON.parse(await readFile(join(dir, f), 'utf8')) })));
	const due = records.filter(({ rec }) => needsRecheck(rec));
	const results = await inPool(due, ({ path, rec }) => recheck(path, rec, sectorCfg));

	const back = results.filter((r) => r.was && r.now === 'reached');
	recovered.push(...back.map((r) => `${slug}: ${r.name}`));
	retried += due.length;
	for (const r of results.filter((x) => x.was || x.now !== 'reached')) {
		console.log(`    ${r.name.slice(0, 40).padEnd(42)} ${r.was || 'read'}  →  ${r.now}`);
	}
	console.log(`  ${slug.padEnd(30)} ${String(due.length).padStart(3)} re-checked, ${back.length} recovered\n`);
}

console.log(`${retried} businesses re-checked; ${recovered.length} reached on retry:`);
for (const r of recovered) console.log(`  ${r}`);
console.log('Next: node score.mjs <slug> …  (or ./regenerate-all.sh)');
