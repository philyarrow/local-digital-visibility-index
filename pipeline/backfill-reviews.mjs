#!/usr/bin/env node
/**
 * backfill-reviews.mjs — recompute reviewsLast90d after the timestamp fix.
 *
 * Why this exists
 * ---------------
 * countRecentReviews() normalised DataForSEO's "2024-03-15 10:23:45 +00:00"
 * with .replace(' ', 'T'), which replaces only the FIRST space. The result
 * kept a space before the offset, Date.parse returned NaN, every review was
 * skipped, and the function returned 0 — for all 266 measured businesses.
 *
 * That zero was not inert. score.mjs feeds it into the Local pillar:
 *     if (typeof p.reviewsLast90d === 'number')
 *         parts.push(clamp100(Math.min(100, p.reviewsLast90d * 10)));
 * so every published Local score carried a constant zero component. A firm
 * with 238 lifetime reviews was scored as having had none in ninety days.
 *
 * Raw review payloads are not retained, so the corrected count cannot be
 * recomputed offline — the reviews endpoint has to be asked again. This
 * script re-fetches ONLY reviews and rewrites ONLY reviewsLast90d. It does
 * not touch any other pillar input, so the correction stays attributable to
 * one field and one cause.
 */
import fs from 'node:fs';
import path from 'node:path';
import { reviewsBatch, loadEnv, ledger } from './lib/dataforseo.mjs';
import { loadConfig, resolveIndex } from './lib/basket.mjs';
import { normaliseReviewTimestamp, countRecentReviews, analyseReviews } from './collect.mjs';

const DRY = process.argv.includes('--dry-run');
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'))[0] || null;

loadEnv();
const config = loadConfig();
const indices = (only ? [only] : fs.readdirSync('data'))
	.filter((d) => fs.statSync(path.join('data', d)).isDirectory());

let totalChanged = 0;
for (const slug of indices) {
	const dir = path.join('data', slug);
	const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
	if (!files.length) continue;

	let indexCfg, engine;
	try {
		const r = resolveIndex(slug, config);
		indexCfg = r.index;
		engine = r.engine;
	} catch (e) { console.log(`  ${slug}: ${e.message.split('.')[0]}, skipped`); continue; }
	if (!engine.local?.reviewVelocity) { console.log(`  ${slug}: reviewVelocity off, skipped`); continue; }

	const records = files.map((f) => ({ f, r: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));
	const queries = records
		.filter(({ r }) => r.pillars?.local?.placeId || r.pillars?.local?.gbpFound)
		.map(({ r }) => ({
			key: r.slug || r.name,
			place_id: r.pillars.local.placeId || null,
			keyword: r.name,
			location_name: indexCfg.locationName,
		}))
		.filter((q) => q.place_id);

	console.log(`\n${slug}: ${queries.length} business(es) with a place_id`);
	if (DRY) { console.log('  --dry-run, no call made'); continue; }
	if (!queries.length) continue;

	const byKey = await reviewsBatch(queries, {
		depth: engine.local.reviewDepth,
		log: (m) => console.log('  ' + m),
	});

	let changed = 0;
	for (const { f, r } of records) {
		const loc = r.pillars?.local;
		if (!loc) continue;
		const key = r.slug || r.name;
		if (!byKey.has(key)) continue;
		const before = loc.reviewsLast90d;
		const after = countRecentReviews(byKey.get(key), engine.local.velocityWindowDays || 90, loc.reviewCount || 0);
		if (before === after) continue;
		loc.reviewsLast90d = after;
		Object.assign(loc, analyseReviews(byKey.get(key), engine.local.velocityWindowDays || 90));
		if (after !== null && loc.error === 'review velocity unavailable (reviews task failed)') loc.error = null;
		fs.writeFileSync(path.join(dir, f), JSON.stringify(r, null, 2) + '\n');
		changed++;
	}
	console.log(`  ${changed} record(s) updated`);
	totalChanged += changed;
}
console.log(`\nTotal: ${totalChanged} record(s). Next: re-score and regenerate.`);
if (!DRY) {
	/* ledger is an object with a report() method, not a callable. */
	if (typeof ledger?.report === 'function') console.log('\nCost this run:\n' + ledger.report());
	else if (ledger?.total != null) console.log(`\nCost this run: $${ledger.total}`);
}
