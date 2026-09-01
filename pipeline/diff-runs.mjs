#!/usr/bin/env node
/* Diff two runs of one index.
 *
 *   node diff-runs.mjs <index-slug> <runA> <runB> [options]
 *
 * A run is either a quarter (Q3-2026 -> data/<index>/q3-2026.json) or an
 * interim period (2026-08 -> data/<index>/history/2026-08.json). A is the
 * earlier run.
 *
 *   --threshold N   composite points that count as a move (default 5)
 *   --json          machine-readable output for the movers page and email step
 *   --data-root P   read snapshots from P instead of ../data
 *
 * --data-root exists so this can be run against a copy. The published snapshots
 * are the receipts behind scores on named businesses; a tool that reads them
 * should be runnable somewhere they cannot be touched.
 *
 * This file is the I/O half of the brief's diffRuns(indexSlug, quarterA,
 * quarterB). The pure half is lib/diff.mjs. Nothing here computes a delta.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { diffRuns, moversAndFallers } from './lib/diff.mjs';
import { loadManualIds } from './lib/identity.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

const QUARTER = /^Q[1-4]-\d{4}$/i;
const PERIOD = /^\d{4}-\d{2}$/;

export function runPath(dataRoot, indexSlug, ref) {
	if (QUARTER.test(ref)) return join(dataRoot, indexSlug, `${ref.toLowerCase()}.json`);
	if (PERIOD.test(ref)) return join(dataRoot, indexSlug, 'history', `${ref}.json`);
	throw new Error(`'${ref}' is not a quarter (Q3-2026) or an interim period (2026-08)`);
}

async function loadRun(dataRoot, indexSlug, ref) {
	const path = runPath(dataRoot, indexSlug, ref);
	try {
		return JSON.parse(await readFile(path, 'utf8'));
	} catch (e) {
		if (e?.code === 'ENOENT') throw new Error(`no run for ${indexSlug} ${ref} (looked for ${path})`);
		throw new Error(`could not read ${path}: ${e.message}`);
	}
}

const sign = (n) => (n === null ? '  —  ' : `${n > 0 ? '+' : ''}${n}`);

function report(diff, movers, { threshold }) {
	const L = [];
	L.push(`${diff.indexSlug}  ${diff.quarterA} -> ${diff.quarterB}`);

	if (!diff.comparable) {
		L.push('');
		L.push('REFUSED');
		L.push(`  ${diff.refusedBecause}`);
		return L.join('\n');
	}

	const byKey = {};
	for (const m of diff.matched) byKey[m.matchedOn] = (byKey[m.matchedOn] || 0) + 1;
	const keyNote = Object.entries(byKey).map(([k, n]) => `${n} by ${k}`).join(', ') || 'none';

	L.push(`methodology version ${diff.methodologyVersionA} on both sides`);
	L.push(`cohort ${diff.cohort.sizeA} -> ${diff.cohort.sizeB}`
		+ `   median ${diff.cohort.medianA} -> ${diff.cohort.medianB} (${sign(diff.cohort.medianDelta)})`);
	L.push(`matched ${diff.matched.length} (${keyNote})   entries ${diff.entries.length}   exits ${diff.exits.length}`);

	const renamed = diff.matched.filter((m) => m.nameChanged);
	if (renamed.length) {
		L.push('');
		L.push(`Renamed, still matched (${renamed.length}) — these would be false entry/exit pairs on a name key:`);
		for (const m of renamed) L.push(`  ${m.previousName}  ->  ${m.name}   [${m.matchedOn}]`);
	}

	if (movers.movers.length || movers.fallers.length) {
		L.push('');
		L.push(`Moved by ${threshold}+ composite points:`);
		for (const m of [...movers.movers, ...movers.fallers]) {
			const why = m.movedBy ? `${m.movedBy} ${sign(m.pillars[m.movedBy].delta)}` : 'no single pillar';
			L.push(`  ${sign(m.composite.delta).padStart(6)}  ${String(m.composite.a).padStart(3)} -> ${String(m.composite.b).padEnd(3)}  ${m.name}   (${why})`);
		}
	}

	if (diff.entries.length) {
		L.push('');
		L.push(`Entries (${diff.entries.length}):`);
		for (const e of diff.entries) L.push(`  ${e.name}  ${e.composite ?? '—'}`);
	}
	if (diff.exits.length) {
		L.push('');
		L.push(`Exits (${diff.exits.length}):`);
		for (const e of diff.exits) L.push(`  ${e.name}  ${e.composite ?? '—'}`);
	}

	/* Never silent. An unresolved business is one whose history is about to be
	   lost, and an ambiguous key is two firms one bad match away from swapping
	   histories. Both are printed even when everything else went well. */
	for (const side of ['a', 'b']) {
		const label = side === 'a' ? diff.quarterA : diff.quarterB;
		if (diff.unresolved[side].length) {
			L.push('');
			L.push(`! ${diff.unresolved[side].length} unidentifiable in ${label} — no place_id, no domain, no manual entry:`);
			for (const u of diff.unresolved[side]) L.push(`    ${u.name}  (${u.reason})`);
		}
		if (diff.ambiguous[side].length) {
			L.push('');
			L.push(`! ${diff.ambiguous[side].length} ambiguous key(s) in ${label} — left unmatched rather than guessed:`);
			for (const a of diff.ambiguous[side]) L.push(`    ${a.source} ${a.key}: ${a.names.join(' | ')}`);
		}
	}

	return L.join('\n');
}

async function main(argv) {
	const positional = [];
	let threshold = 5;
	let asJson = false;
	let dataRoot = join(HERE, '..', 'data');

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--json') asJson = true;
		else if (a === '--threshold') threshold = Number(argv[++i]);
		else if (a === '--data-root') dataRoot = argv[++i];
		else if (a.startsWith('--')) throw new Error(`unknown option: ${a}`);
		else positional.push(a);
	}

	const [indexSlug, refA, refB] = positional;
	if (!indexSlug || !refA || !refB) {
		throw new Error('usage: node diff-runs.mjs <index-slug> <runA> <runB> [--threshold N] [--json] [--data-root PATH]');
	}
	if (!Number.isFinite(threshold) || threshold < 0) throw new Error('--threshold must be a non-negative number');

	const [runA, runB, manualIds] = await Promise.all([
		loadRun(dataRoot, indexSlug, refA),
		loadRun(dataRoot, indexSlug, refB),
		loadManualIds(),
	]);

	const diff = diffRuns(runA, runB, { manualIds });
	const movers = moversAndFallers(diff, { threshold });

	if (asJson) console.log(JSON.stringify({ diff, movers }, null, 2));
	else console.log(report(diff, movers, { threshold }));

	/* A refusal is a non-zero exit so a pipeline step cannot mistake it for an
	   empty diff and carry on to send nobody an email while reporting success. */
	if (!diff.comparable) process.exitCode = 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main(process.argv.slice(2)).catch((e) => {
		console.error(`diff-runs: ${e.message}`);
		process.exit(1);
	});
}
