#!/usr/bin/env node
/* Publish the month's measurement, unattended.
 *
 * The GitHub workflow collects and pays. This runs afterwards on Phil's Mac, and
 * spends nothing: it restores the raw collection from the workflow's artifacts,
 * re-reads Technical and Content from an ordinary connection, scores, generates, checks,
 * then commits and pushes. Pushing the site repo's main is what deploys.
 *
 * It works ONLY in the publisher's own clones (see publisher/install.sh), because
 * it resets them hard. assertOwnClones refuses to run anywhere else.
 *
 *   node publish-month.mjs                 # what launchd runs daily
 *   node publish-month.mjs --dry-run       # everything except commit and push
 *   node publish-month.mjs --period 2026-11
 *   node publish-month.mjs --clear-hold    # try again, with every check still on
 *   node publish-month.mjs --accept-holds  # a person has read the holds; publish
 *
 * Anything found wrong becomes a hold: nothing is published, the measurement is
 * kept, and an issue on the private site repo emails Phil. A hold is remembered,
 * so a daily run does not repeat the work or the email.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadManualIds } from './lib/identity.mjs';
import {
	SCORING_FILES, carryForwardPaid, changelogEntry, findHolds, hasReleaseEntry,
	insertChangelogEntry, isPeriod, latestPriorSnapshot, releaseLabel, summariseRelease,
} from './lib/release.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PIPELINE_REPO = resolve(HERE, '..');
const PIPELINE_SLUG = 'philyarrow/local-digital-visibility-index';
const SITE_SLUG = 'philyarrow/hub.philyarrow';
const LIVE_CHANGELOG = 'https://hub.pyc.agency/indices/changelog/';
const WORKFLOW = 'interim-measurement.yml';
/* main in normal use. Set only to rehearse a branch with --dry-run. */
const BRANCH = process.env.PUBLISHER_BRANCH ?? 'main';

const RECHECK_CONCURRENCY = 6;
const ALERT_IF_NO_RUN_AFTER_DAY = 5;
const LIVE_POLL_ATTEMPTS = 30;
const LIVE_POLL_MS = 60_000;

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const ACCEPT_HOLDS = argv.includes('--accept-holds');
const CLEAR_HOLD = argv.includes('--clear-hold');
const periodAt = argv.indexOf('--period');
const today = new Date().toISOString().slice(0, 10);
const PERIOD = periodAt === -1 ? today.slice(0, 7) : argv[periodAt + 1];

const PUBLISHER_HOME = process.env.PUBLISHER_HOME;
const SITE_REPO = PUBLISHER_HOME ? join(PUBLISHER_HOME, 'site') : null;
const STATE_DIR = PUBLISHER_HOME ? join(PUBLISHER_HOME, 'state') : null;
const DATA_DIR = join(HERE, 'data');
const SNAPSHOTS = join(PIPELINE_REPO, 'data');

/* Nothing here should be able to spend money, whatever the shell has exported. */
const CHILD_ENV = Object.fromEntries(Object.entries(process.env)
	.filter(([k]) => !['DATAFORSEO_AUTH', 'PAGESPEED_API_KEY', 'COMPANIES_HOUSE_KEY'].includes(k)));

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

function sh(cmd, args, { cwd = HERE, allowFail = false, capture = true } = {}) {
	const res = spawnSync(cmd, args, { cwd, env: CHILD_ENV, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', maxBuffer: 1 << 28 });
	if (res.status !== 0 && !allowFail) {
		throw new Error(`${cmd} ${args.join(' ')} failed (exit ${res.status}): ${String(res.stderr ?? '').slice(-800)}`);
	}
	return allowFail ? { ok: res.status === 0, out: String(res.stdout ?? '').trim() } : String(res.stdout ?? '').trim();
}

function assertOwnClones() {
	if (!PUBLISHER_HOME) throw new Error('PUBLISHER_HOME is not set. This resets git clones hard, so it only runs in the ones publisher/install.sh made.');
	const own = realpathSync(PUBLISHER_HOME) + sep;
	if (!realpathSync(PIPELINE_REPO).startsWith(own)) throw new Error(`Refusing to run from ${PIPELINE_REPO}: not inside ${own}`);
	if (!existsSync(join(SITE_REPO, '.git'))) throw new Error(`No site clone at ${SITE_REPO}. Run publisher/install.sh.`);
}

const markerPath = (kind) => join(STATE_DIR, `${PERIOD}.${kind}`);
const hasMarker = (kind) => existsSync(markerPath(kind));

function setMarker(kind, text) {
	if (DRY_RUN) return;
	mkdirSync(STATE_DIR, { recursive: true });
	writeFileSync(markerPath(kind), text);
}

function alert(title, body, { close = false } = {}) {
	if (DRY_RUN) {
		log(`DRY RUN, would raise: ${title}\n${body}`);
		return;
	}
	const url = sh('gh', ['issue', 'create', '-R', SITE_SLUG, '--title', title, '--body', body]);
	if (close) sh('gh', ['issue', 'close', url, '-R', SITE_SLUG], { allowFail: true });
	log(`Raised ${url}`);
}

function hold(reasons) {
	const list = reasons.map((r) => `- ${r}`).join('\n');
	/* Alert first: a marker without an alert would block every later run in silence. */
	alert(`Index release held: ${releaseLabel(PERIOD)}`, `Nothing was published, and the site still shows the previous release. The measurement is kept.\n\n${list}\n\nRun from \`${PUBLISHER_HOME}/pipeline/pipeline\`, with \`PUBLISHER_HOME=${PUBLISHER_HOME}\`:\n\n- \`node publish-month.mjs --period ${PERIOD} --clear-hold\` once the cause is fixed. Every check runs again.\n- \`node publish-month.mjs --period ${PERIOD} --accept-holds\` to publish anyway. The changelog states any scoring change.`);
	setMarker('held', list);
}

function freshClones() {
	for (const repo of [PIPELINE_REPO, SITE_REPO]) {
		sh('git', ['fetch', '--quiet', '--tags', '--force', 'origin'], { cwd: repo });
		sh('git', ['checkout', '--quiet', '-f', BRANCH], { cwd: repo });
		sh('git', ['reset', '--quiet', '--hard', `origin/${BRANCH}`], { cwd: repo });
		sh('git', ['clean', '-fdq', '-e', 'node_modules', '-e', 'pipeline/data'], { cwd: repo });
	}
}

function publishedSlugs() {
	const cfg = JSON.parse(readFileSync(join(HERE, 'config', 'indices.json'), 'utf8'));
	return Object.keys(cfg).filter((k) => !k.startsWith('_') && cfg[k]?.publish === true);
}

const changelogPath = () => join(SITE_REPO, 'new', 'src', 'content', 'docs', 'indices', 'changelog.md');

function alreadyPublished() {
	return hasReleaseEntry(readFileSync(changelogPath(), 'utf8'), PERIOD);
}

function findRun() {
	const runs = JSON.parse(sh('gh', ['run', 'list', '-R', PIPELINE_SLUG, '--workflow', WORKFLOW, '--limit', '20',
		'--json', 'databaseId,status,conclusion,createdAt,event']));
	return runs.find((r) => r.createdAt.startsWith(PERIOD) && r.event === 'schedule') ?? runs.find((r) => r.createdAt.startsWith(PERIOD)) ?? null;
}

function restoreRawData(runId, slugs) {
	const incoming = join(HERE, '.incoming');
	rmSync(incoming, { recursive: true, force: true });
	rmSync(DATA_DIR, { recursive: true, force: true });
	mkdirSync(incoming, { recursive: true });
	mkdirSync(DATA_DIR, { recursive: true });
	sh('gh', ['run', 'download', String(runId), '-R', PIPELINE_SLUG, '-D', incoming]);

	const missing = [];
	for (const slug of slugs) {
		const from = join(incoming, `raw-${slug}-${runId}`);
		if (existsSync(from)) renameSync(from, join(DATA_DIR, slug));
		else missing.push(slug);
	}
	rmSync(incoming, { recursive: true, force: true });
	return missing;
}

const normaliseUrl = (u) => String(u ?? '').replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();

function priorSnapshot(slug) {
	const dir = join(SNAPSHOTS, slug);
	const file = existsSync(dir) ? latestPriorSnapshot(readdirSync(dir), { period: PERIOD }) : null;
	return file ? JSON.parse(readFileSync(join(dir, file), 'utf8')) : null;
}

const businessRecords = (slug) => readdirSync(join(DATA_DIR, slug))
	.filter((f) => f.endsWith('.json') && !f.startsWith('_'))
	.map((f) => ({ path: join(DATA_DIR, slug, f), record: JSON.parse(readFileSync(join(DATA_DIR, slug, f), 'utf8')) }));

function carryPaidEnrichment(slugs) {
	let carried = 0;
	for (const slug of slugs) {
		const prior = priorSnapshot(slug);
		if (!prior) continue;
		const label = prior.releaseLabel ?? prior.quarter;
		const byUrl = new Map(prior.businesses.map((b) => [normaliseUrl(b.url), b]));
		for (const { path, record } of businessRecords(slug)) {
			const next = carryForwardPaid(record, byUrl.get(normaliseUrl(record.url)), label);
			if (next === record) continue;
			writeFileSync(path, JSON.stringify(next, null, 2) + '\n');
			carried += 1;
		}
	}
	log(`Carried paid enrichment forward for ${carried} businesses`);
}

const receiptTagExists = () => sh('git', ['ls-remote', '--tags', 'origin', `refs/tags/${PERIOD}`], { cwd: PIPELINE_REPO }) !== '';

function scoringChangesSinceLastRelease() {
	const tags = sh('git', ['tag', '--list'], { cwd: PIPELINE_REPO }).split('\n').filter(Boolean);
	const last = latestPriorSnapshot(tags.map((t) => `${t}.json`), { period: PERIOD })?.replace(/\.json$/, '');
	if (!last) return ['no earlier release tag to compare against'];
	const changed = sh('git', ['diff', '--name-only', last, 'HEAD', '--', ...SCORING_FILES], { cwd: PIPELINE_REPO });
	return changed ? changed.split('\n') : [];
}

function staleScorecards(slugs) {
	const docs = join(SITE_REPO, 'new', 'src', 'content', 'docs', 'indices');
	return slugs.flatMap((slug) => {
		const ranked = JSON.parse(readFileSync(join(DATA_DIR, slug, '_ranked.json'), 'utf8'));
		const current = new Set(ranked.businesses.map((b) => b.slug));
		if (!existsSync(join(docs, slug))) return [];
		return readdirSync(join(docs, slug))
			.filter((f) => f.endsWith('.md') && f !== 'index.md')
			.map((f) => f.replace(/\.md$/, ''))
			.filter((s) => !current.has(s))
			.map((s) => `${slug}/${s}`);
	});
}

function technicalErrors(slug) {
	return Object.fromEntries(businessRecords(slug)
		.filter(({ record }) => record.pillars?.technical?.error)
		.map(({ record }) => [record.url, record.pillars.technical.error]));
}

function loadPairs(slugs) {
	const snapshot = (slug) => JSON.parse(readFileSync(join(SNAPSHOTS, slug, `${PERIOD}.json`), 'utf8'));
	return slugs
		.filter((slug) => existsSync(join(SNAPSHOTS, slug, `${PERIOD}.json`)) && priorSnapshot(slug))
		.map((slug) => {
			const current = snapshot(slug);
			const words = slug.replace(/-/g, ' ');
			const title = words[0].toUpperCase() + words.slice(1);
			return { slug, title, prior: priorSnapshot(slug), current, technicalErrors: technicalErrors(slug) };
		});
}

function measurementDates(pairs) {
	const dates = pairs.flatMap((p) => businessDates(p.slug));
	const sorted = [...new Set(dates)].sort();
	return { collectedFrom: sorted[0], collectedTo: sorted.at(-1) };
}

function businessDates(slug) {
	return businessRecords(slug).map(({ record }) => record.collectedAt?.slice(0, 10)).filter(Boolean);
}

function generateAll() {
	sh('./regenerate-all.sh', [SITE_REPO, '--release', PERIOD], { capture: false });
}

function checkSite() {
	const bridges = sh('node', ['generate.mjs', '--check-bridges', '--site-root', SITE_REPO], { allowFail: true });
	if (!bridges.ok) return [`Bridge links no longer resolve: ${bridges.out.slice(-400)}`];
	const siteNew = join(SITE_REPO, 'new');
	sh('npm', ['ci', '--no-audit', '--no-fund'], { cwd: siteNew });
	const build = sh('npm', ['run', 'build'], { cwd: siteNew, allowFail: true });
	return build.ok ? [] : [`The site does not build: ${build.out.slice(-400)}`];
}

function commitReceipt() {
	sh('git', ['add', 'data'], { cwd: PIPELINE_REPO });
	const staged = sh('git', ['diff', '--cached', '--name-only'], { cwd: PIPELINE_REPO }).split('\n').filter(Boolean);
	const expected = new RegExp(`^data/[^/]+/${PERIOD}\\.(json|csv)$`);
	const strays = staged.filter((f) => !expected.test(f));
	if (strays.length) throw new Error(`A release may only add its own snapshots. Also changed: ${strays.slice(0, 5).join(', ')}`);
	if (staged.length) {
		sh('git', ['commit', '--quiet', '-m', `Release ${PERIOD}: published snapshot`, '-m',
			`The figures on the site for ${releaseLabel(PERIOD)}, including Technical and Content & trust as re-read on ${today}. Automated.`], { cwd: PIPELINE_REPO });
	}
	/* Forced locally only: main() has checked the tag is not on the remote, and a
	   local one can be left behind by a push that failed. */
	sh('git', ['tag', '-f', PERIOD], { cwd: PIPELINE_REPO });
	sh('git', ['push', '--quiet', 'origin', 'main', `refs/tags/${PERIOD}`], { cwd: PIPELINE_REPO });
}

function commitSite(summary) {
	sh('git', ['add', 'new/src/content/docs/indices', 'new/public/data', 'new/public/og'], { cwd: SITE_REPO });
	sh('git', ['commit', '--quiet', '-m', `${releaseLabel(PERIOD)}: every index re-measured`, '-m',
		`${summary.changed} of ${summary.firms} scores changed since ${summary.priorLabel}. Automated release; the receipt is tag ${PERIOD} in the pipeline repo.`], { cwd: SITE_REPO });
	/* Someone may have pushed to the site during the half hour this takes. */
	sh('git', ['pull', '--quiet', '--rebase', 'origin', 'main'], { cwd: SITE_REPO });
	sh('git', ['push', '--quiet', 'origin', 'main'], { cwd: SITE_REPO });
}

async function waitUntilLive() {
	const label = releaseLabel(PERIOD);
	for (let attempt = 0; attempt < LIVE_POLL_ATTEMPTS; attempt += 1) {
		await new Promise((r) => setTimeout(r, LIVE_POLL_MS));
		const res = await fetch(`${LIVE_CHANGELOG}?release=${PERIOD}`).catch(() => null);
		if (res?.ok && (await res.text()).includes(`${label}: `)) return true;
	}
	return false;
}

/* Returns false once a hold has been raised. Prepares everything and publishes nothing. */
function prepare(run, slugs, manualIds) {
	const missing = restoreRawData(run.databaseId, slugs);
	if (missing.length) {
		hold([`The collection left no raw data for: ${missing.join(', ')}`]);
		return null;
	}
	carryPaidEnrichment(slugs);
	log('Re-reading Technical and Content for every business');
	sh('node', ['backfill-technical.mjs', '--all', '--concurrency', String(RECHECK_CONCURRENCY)], { capture: false });
	generateAll();

	const pairs = loadPairs(slugs);
	const summary = summariseRelease(pairs, { manualIds });
	const dates = measurementDates(pairs);
	const scoringChanges = scoringChangesSinceLastRelease();
	const holds = findHolds(summary, {
		expectedSlugs: slugs,
		period: PERIOD,
		measuredPeriod: dates.collectedTo?.slice(0, 7) ?? 'nothing',
		scoringChanges,
		staleScorecards: staleScorecards(slugs),
	});
	return { summary, dates, holds, scoringChanges, expectedCount: slugs.length };
}

function writeChangelog({ summary, dates, scoringChanges, expectedCount }) {
	const entry = changelogEntry(summary, { period: PERIOD, publishedOn: today, recheckedOn: today, scoringChanges, expectedCount, ...dates });
	writeFileSync(changelogPath(), insertChangelogEntry(readFileSync(changelogPath(), 'utf8'), entry, today));
	return entry;
}

function noRunYet() {
	const day = Number(today.slice(8, 10));
	if (day > ALERT_IF_NO_RUN_AFTER_DAY && !hasMarker('no-run')) {
		alert(`Index release: no measurement for ${releaseLabel(PERIOD)}`, `The monthly workflow has not produced a run this month. GitHub disables scheduled workflows on inactive repositories, so check the Actions tab of ${PIPELINE_SLUG} first.`);
		setMarker('no-run', today);
	}
	log('No measurement run for this month yet');
}

async function main() {
	if (!isPeriod(PERIOD)) throw new Error(`--period must look like 2026-11, got '${PERIOD}'`);
	assertOwnClones();
	freshClones();
	if (alreadyPublished()) return log(`${PERIOD} is already published`);
	if (CLEAR_HOLD) rmSync(markerPath('held'), { force: true });
	if (hasMarker('held') && !ACCEPT_HOLDS) return log(`${PERIOD} is held. See the issue, or run with --clear-hold or --accept-holds`);
	/* A public receipt with no matching page means an earlier run stopped halfway.
	   A re-read now would give different numbers, so a person decides. */
	if (receiptTagExists()) return hold([`Tag ${PERIOD} is already on the pipeline repo, but the site has no ${releaseLabel(PERIOD)} release. An earlier run stopped between the two pushes. Check the tag, delete it if the receipt is wrong, then run with --clear-hold.`]);

	const run = findRun();
	if (!run) return noRunYet();
	if (run.status !== 'completed') return log(`Run ${run.databaseId} is still ${run.status}`);
	if (run.conclusion !== 'success' && !ACCEPT_HOLDS) return hold([`The measurement run ${run.databaseId} finished as ${run.conclusion}`]);

	const slugs = publishedSlugs();
	const prepared = prepare(run, slugs, await loadManualIds());
	if (!prepared) return undefined;
	log(`Summary: ${JSON.stringify({ ...prepared.summary, medians: undefined, pillars: prepared.summary.pillars })}`);
	writeChangelog(prepared);

	const holds = [...prepared.holds, ...checkSite()];
	if (holds.length && !ACCEPT_HOLDS) return hold(holds);
	if (holds.length) log(`Publishing past holds a person accepted:\n${holds.join('\n')}`);

	if (DRY_RUN) return log(`DRY RUN complete. Nothing committed. Site clone left at ${SITE_REPO} for inspection.`);

	commitReceipt();
	commitSite(prepared.summary);
	rmSync(markerPath('held'), { force: true });
	log('Pushed. Waiting for the deploy');

	const live = await waitUntilLive();
	if (!live) return alert(`Index release pushed but not live: ${releaseLabel(PERIOD)}`, `Pushed to ${SITE_SLUG}, but ${LIVE_CHANGELOG} did not show it within ${LIVE_POLL_ATTEMPTS} minutes. Check Workers Builds in Cloudflare.`);

	const s = prepared.summary;
	return alert(`Index published: ${releaseLabel(PERIOD)}`, `${s.changed} of ${s.firms} scores changed since ${s.priorLabel}: ${s.higher} higher, ${s.lower} lower. ${s.newFirstPlaces.length} new first places. ${s.newTechnicalZeros.length} firms newly at 0 on Technical.\n\n${LIVE_CHANGELOG}`, { close: true });
}

main().catch((e) => {
	console.error(e);
	/* A crash is not a verdict on the data, so it is not a hold: the next daily
	   run tries again. One alert per day at most, as launchd runs daily. */
	try { if (PUBLISHER_HOME) alert(`Index release failed: ${PERIOD}`, `The publisher crashed, so nothing further was published. It tries again tomorrow.\n\n\`\`\`\n${String(e.message ?? e).slice(0, 1500)}\n\`\`\``); } catch (alertError) { console.error(alertError); }
	process.exit(1);
});
