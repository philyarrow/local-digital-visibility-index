/* DataForSEO client for the Local Digital Visibility Index.

   Auth is a single base64 "login:password" in DATAFORSEO_AUTH, used verbatim as
   `Authorization: Basic <value>`. Loaded from the repo-root .env automatically,
   so `node collect.mjs …` works without the --env-file flag.

   Every response carries a `cost` field; this module accumulates it into a
   ledger so a run can report exactly what it spent. Nothing here retries a
   charged call silently — a failed task is reported, not re-posted.
*/

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = 'https://api.dataforseo.com/v3/';

/* ---- env ---------------------------------------------------------------- */

/* Walk up from pipeline/lib looking for a .env, so the pipeline runs the
   same whether or not the caller passed --env-file. */
export function loadEnv() {
	if (process.env.DATAFORSEO_AUTH) return;
	let dir = HERE;
	for (let i = 0; i < 6; i++) {
		const candidate = join(dir, '.env');
		if (existsSync(candidate)) {
			for (const line of readFileSync(candidate, 'utf8').split('\n')) {
				const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
				if (!m) continue;
				const val = m[2].replace(/^["']|["']$/g, '');
				if (!process.env[m[1]]) process.env[m[1]] = val;
			}
			return;
		}
		dir = dirname(dir);
	}
}

/* ---- cost ledger -------------------------------------------------------- */

export const ledger = {
	entries: [],
	total: 0,
	add(label, cost) {
		const c = Number(cost) || 0;
		this.total += c;
		const existing = this.entries.find((e) => e.label === label);
		if (existing) { existing.calls++; existing.cost += c; }
		else this.entries.push({ label, calls: 1, cost: c });
		return c;
	},
	report() {
		const rows = this.entries
			.slice()
			.sort((a, b) => b.cost - a.cost)
			.map((e) => `    ${e.label.padEnd(34)} ${String(e.calls).padStart(4)} call(s)  $${e.cost.toFixed(5)}`);
		return rows.join('\n') + `\n    ${'TOTAL'.padEnd(34)} ${String(this.entries.reduce((s, e) => s + e.calls, 0)).padStart(4)} call(s)  $${this.total.toFixed(5)}`;
	},
};

/* ---- transport ---------------------------------------------------------- */

function authHeader() {
	const auth = process.env.DATAFORSEO_AUTH;
	if (!auth) {
		throw new Error(
			'DATAFORSEO_AUTH is not set. Add it to the repo-root .env as the base64 of "login:password".'
		);
	}
	return `Basic ${auth}`;
}

/* `free: true` skips ledger accumulation. Retrieval endpoints (task_get,
   tasks_ready) echo the task's ORIGINAL cost in their `cost` field but do not
   charge again — verified against the account balance, which does not move
   across a task_get. Counting them would double every queued task in the
   ledger and make a run look twice as expensive as it was. */
async function request(path, { method = 'POST', body = null, timeoutMs = 180000, label, free = false } = {}) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(BASE + path, {
			method,
			headers: {
				Authorization: authHeader(),
				...(body ? { 'Content-Type': 'application/json' } : {}),
			},
			body: body ? JSON.stringify(body) : undefined,
			signal: ctrl.signal,
		});
		const data = await res.json();
		if (!free) ledger.add(label || path, data.cost);
		if (data.status_code !== 20000) {
			throw new Error(`DataForSEO ${path}: ${data.status_code} ${data.status_message}`);
		}
		return data;
	} finally {
		clearTimeout(timer);
	}
}

export function post(path, tasks, opts = {}) {
	return request(path, { method: 'POST', body: tasks, ...opts });
}

export function get(path, opts = {}) {
	return request(path, { method: 'GET', ...opts });
}

/* ---- account ------------------------------------------------------------ */

export async function balance() {
	const d = await get('appendix/user_data', { label: 'appendix/user_data', free: true });
	const money = d.tasks?.[0]?.result?.[0]?.money;
	return { balance: money?.balance ?? null, currency: money?.currency ?? 'USD' };
}

/* ---- spend reconciliation ---------------------------------------------- */

/* DataForSEO timestamps are "YYYY-MM-DD HH:MM:SS +00:00" and the API rejects a
   datetime_to at or after its own clock, so the window closes slightly in the
   past. */
function dfsTime(date) {
	return new Date(date).toISOString().replace('T', ' ').slice(0, 19) + ' +00:00';
}

/* What was actually charged in a time window, per task, from DataForSEO's own
   billing record.

   This exists because a balance delta is NOT a measure of one run's spend: any
   concurrent run, or a task posted by an earlier crashed run, lands inside the
   same window. That mistake made a $0.084 run look like $1.53. id_list
   attributes cost per task and is immune to concurrency.

   Caveat, reported honestly rather than hidden: only `serp` and `business_data`
   expose id_list. AI (`ai_optimization`) has no equivalent, so its spend is
   taken from the in-process ledger and flagged as unverified. */
export async function spendSince(startedAt, { log = () => {} } = {}) {
	const from = dfsTime(startedAt);
	// Close the window just short of now — the API refuses a future datetime_to.
	const to = dfsTime(Date.now() - 60000);

	const out = { from, to, byApi: {}, attributed: 0, verifiable: true };

	for (const api of ['serp', 'business_data']) {
		try {
			const d = await post(`${api}/id_list`, [{
				datetime_from: from,
				datetime_to: to,
				limit: 1000,
				sort: 'desc',
			}], { label: `${api}/id_list`, free: true });

			const rows = d.tasks?.[0]?.result || [];
			const cost = rows.reduce((s, r) => s + (Number(r.cost) || 0), 0);
			out.byApi[api] = { tasks: rows.length, cost: Number(cost.toFixed(5)) };
			out.attributed += cost;
		} catch (e) {
			log(`    ! could not reconcile ${api} spend: ${e.message}`);
			out.byApi[api] = { tasks: null, cost: null, error: e.message };
			out.verifiable = false;
		}
	}

	out.attributed = Number(out.attributed.toFixed(5));
	return out;
}

/* ---- queued SERP -------------------------------------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* A queued task that is not ready yet answers task_get with a 4xxxx code —
   40601 "Task Handed", 40602 "Task In Queue". These are NOT failures, and
   treating them as such silently discards work already paid for. The message
   check is a belt-and-braces fallback in case DataForSEO adds another
   in-flight code. */
const PENDING_CODES = new Set([40601, 40602]);

function isPending(task) {
	if (!task) return false;
	if (PENDING_CODES.has(task.status_code)) return true;
	return /in queue|task handed|in progress/i.test(task.status_message || '');
}

/* Post a batch of SERP tasks on the standard queue.

   Returns Map<taskId, keyword>. Kept separate from harvesting so a caller can
   persist the ids: a posted task is already CHARGED, and its result stays
   retrievable for days. Losing the ids to a crash or a timeout means paying
   twice for the same data. */
export async function serpPost(tasks, { log = () => {} } = {}) {
	const posted = await post('serp/google/organic/task_post', tasks, {
		label: 'serp/organic/task_post',
	});

	const ids = new Map();
	for (const t of posted.tasks || []) {
		const keyword = t.data?.keyword;
		if (t.status_code !== 20100 && t.status_code !== 20000) {
			log(`    ! SERP task rejected for "${keyword}": ${t.status_message}`);
			continue;
		}
		ids.set(t.id, keyword);
	}
	return ids;
}

/* Harvest already-posted SERP tasks. task_get is free, so polling costs
   nothing; the only budget risk is giving up too early on work already bought.

   The standard queue is documented as "within 45 minutes" and was observed
   taking ~20 minutes for a 12-task batch, so the default ceiling is 45 minutes
   rather than something optimistic.

   idToKeyword: Map<taskId, keyword>
   returns: Map<keyword, resultObject|null> */
export async function serpHarvest(idToKeyword, { pollMs = 20000, maxWaitMs = 2700000, log = () => {} } = {}) {
	const out = new Map();
	if (!idToKeyword.size) return out;

	log(`    harvesting ${idToKeyword.size} SERP task(s) (free; queue can take up to 45 min)…`);

	const started = Date.now();
	const pending = new Map(idToKeyword);

	let firstPass = true;
	while (pending.size && Date.now() - started < maxWaitMs) {
		// Try immediately on resume — the tasks may already be ready.
		if (!firstPass) await sleep(pollMs);
		firstPass = false;
		for (const [id, keyword] of [...pending]) {
			try {
				const d = await get(`serp/google/organic/task_get/advanced/${id}`, {
					label: 'serp/organic/task_get', free: true,
				});
				const task = d.tasks?.[0];
				if (task?.status_code === 20000 && task.result?.[0]) {
					out.set(keyword, task.result[0]);
					pending.delete(id);
				} else if (isPending(task)) {
					// still in the queue — poll again
				} else if (task && task.status_code >= 40000) {
					log(`    ! SERP task ${id} failed: ${task.status_code} ${task.status_message}`);
					out.set(keyword, null);
					pending.delete(id);
				}
			} catch (e) {
				log(`    ! SERP poll error for "${keyword}": ${e.message}`);
			}
		}
		if (pending.size) log(`    …${pending.size} still in queue (${Math.round((Date.now() - started) / 1000)}s)`);
	}

	for (const [id, keyword] of pending) {
		log(`    ! SERP task for "${keyword}" not ready after ${Math.round(maxWaitMs / 60000)} min`);
		log(`      (id ${id} is paid for and still retrievable — re-run to harvest it)`);
		out.set(keyword, null);
	}
	return out;
}

/* Post + harvest in one call, for callers that don't need to persist ids. */
export async function serpQueuedBatch(tasks, opts = {}) {
	if (!tasks.length) return new Map();
	const ids = await serpPost(tasks, opts);
	return serpHarvest(ids, opts);
}

/* ---- AI presence -------------------------------------------------------- */

/* One prompt against one engine. Perplexity `sonar` is the workhorse: it named
   real local firms in testing at ~1/17th the price of ChatGPT. */
export async function llmResponse(engine, prompt, { model, webSearch = true } = {}) {
	const payload = { user_prompt: prompt, model_name: model };
	// Perplexity's sonar models search the web inherently and reject the flag.
	if (engine !== 'perplexity') payload.web_search = webSearch;

	const d = await post(`ai_optimization/${engine}/llm_responses/live`, [payload], {
		label: `ai/${engine}/llm_responses`,
	});
	const task = d.tasks?.[0];
	if (task?.status_code !== 20000) {
		throw new Error(`llm_responses ${engine}: ${task?.status_message || 'unknown error'}`);
	}
	return task.result?.[0] || null;
}

/* Flatten an llm_responses result into plain text for name matching. */
export function llmText(result) {
	if (!result) return '';
	const parts = [];
	for (const item of result.items || []) {
		for (const section of item.sections || []) {
			if (section.text) parts.push(section.text);
			for (const link of section.links || []) {
				if (link.title) parts.push(link.title);
				if (link.url) parts.push(link.url);
				if (link.domain) parts.push(link.domain);
			}
			for (const a of section.annotations || []) {
				if (a.title) parts.push(a.title);
				if (a.url) parts.push(a.url);
			}
		}
	}
	return parts.join('\n');
}

/* ---- Google Business Profile ------------------------------------------- */

/* One live sweep of every listing in a category set within a radius. This is
   the primary source for Local presence: it is a single call per index, it
   returns a firm's branches (so multi-branch chains can be aggregated), and it
   resolves chains that my_business_info cannot.

   Priced per result RETURNED, not per call — ~$0.00048 each, so limit is a real
   cost lever (~$0.048 at 100). Categories must be a list; a single Google
   category is too sparse to find a seed reliably.

   coordinate: "lat,lng,radiusKm" */
export async function businessListings(categories, coordinate, { limit = 100 } = {}) {
	const d = await post('business_data/business_listings/search/live', [{
		categories,
		location_coordinate: coordinate,
		limit,
	}], { label: 'business_data/business_listings/search' });

	const result = d.tasks?.[0]?.result?.[0];
	return {
		items: result?.items || [],
		totalCount: result?.total_count ?? null,
		returned: result?.items?.length ?? 0,
	};
}

/* my_business_info is queue-only. Post a batch, poll for each. */
export async function myBusinessInfoBatch(queries, { pollMs = 10000, maxWaitMs = 300000, log = () => {} } = {}) {
	if (!queries.length) return new Map();

	const posted = await post(
		'business_data/google/my_business_info/task_post',
		queries.map((q) => ({
			keyword: q.keyword,
			location_name: q.location_name,
			language_code: 'en',
		})),
		{ label: 'business_data/my_business_info/task_post' }
	);

	const pending = new Map();
	(posted.tasks || []).forEach((t, i) => {
		const key = queries[i]?.key ?? queries[i]?.keyword;
		if (t.status_code !== 20100 && t.status_code !== 20000) {
			log(`    ! GBP task rejected for "${key}": ${t.status_message}`);
			return;
		}
		pending.set(t.id, key);
	});

	const out = new Map();
	const started = Date.now();
	while (pending.size && Date.now() - started < maxWaitMs) {
		await sleep(pollMs);
		for (const [id, keyword] of [...pending]) {
			try {
				const d = await get(`business_data/google/my_business_info/task_get/${id}`, {
					label: 'business_data/my_business_info/task_get', free: true,
				});
				const task = d.tasks?.[0];
				if (task?.status_code === 20000 && task.result?.[0]) {
					out.set(keyword, task.result[0].items?.[0] || null);
					pending.delete(id);
				} else if (isPending(task)) {
					// still in the queue — poll again
				} else if (task && task.status_code >= 40000) {
					log(`    ! GBP task for "${keyword}" failed: ${task.status_code} ${task.status_message}`);
					out.set(keyword, null);
					pending.delete(id);
				}
			} catch {
				// transient; poll again
			}
		}
	}
	for (const [, keyword] of pending) {
		log(`    ! GBP task for "${keyword}" timed out`);
		out.set(keyword, null);
	}
	return out;
}

/* Reviews, newest-first — the only way to get the 90-day velocity the
   methodology asks for. my_business_info alone gives a headline count only. */
export async function reviewsBatch(queries, { depth = 20, pollMs = 15000, maxWaitMs = 420000, log = () => {} } = {}) {
	if (!queries.length) return new Map();

	/* Prefer place_id when a listing matched — a keyword search re-runs the same
	   ambiguous lookup that fails for multi-branch chains, whereas place_id
	   addresses one profile exactly.

	   location_name is ALWAYS required, even alongside place_id: omitting it
	   returns 40501 "Invalid Field: 'location_name'" (their wording for a
	   missing required field), which silently zeroes review velocity for every
	   business. Verified against the live endpoint. */
	const posted = await post(
		'business_data/google/reviews/task_post',
		queries.map((q) => {
			const task = {
				location_name: q.location_name,
				language_code: 'en',
				depth,
				sort_by: 'newest',
			};
			if (q.place_id) task.place_id = q.place_id;
			else task.keyword = q.keyword;
			return task;
		}),
		{ label: 'business_data/reviews/task_post' }
	);

	/* Results are keyed by the caller's own key, not by data.keyword — a
	   place_id task carries no keyword, so echoing the request field would drop
	   every chain we successfully resolved. DataForSEO returns tasks in the
	   order posted, so index maps back to the query. */
	const pending = new Map();
	(posted.tasks || []).forEach((t, i) => {
		const key = queries[i]?.key ?? queries[i]?.keyword;
		if (t.status_code !== 20100 && t.status_code !== 20000) {
			log(`    ! reviews task rejected for "${key}": ${t.status_message}`);
			return;
		}
		pending.set(t.id, key);
	});

	const out = new Map();
	const started = Date.now();
	while (pending.size && Date.now() - started < maxWaitMs) {
		await sleep(pollMs);
		for (const [id, keyword] of [...pending]) {
			try {
				const d = await get(`business_data/google/reviews/task_get/${id}`, {
					label: 'business_data/reviews/task_get', free: true,
				});
				const task = d.tasks?.[0];
				if (task?.status_code === 20000 && task.result?.[0]) {
					out.set(keyword, task.result[0]);
					pending.delete(id);
				} else if (isPending(task)) {
					// still in the queue — poll again
				} else if (task && task.status_code >= 40000) {
					log(`    ! reviews task for "${keyword}" failed: ${task.status_code} ${task.status_message}`);
					out.set(keyword, null);
					pending.delete(id);
				}
			} catch {
				// transient; poll again
			}
		}
	}
	for (const [, keyword] of pending) {
		log(`    ! reviews task for "${keyword}" timed out`);
		out.set(keyword, null);
	}
	return out;
}
