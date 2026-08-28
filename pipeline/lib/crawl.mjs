/* crawl.mjs — a small, polite, first-party crawler.
 *
 * The Content & trust pillar previously tested three booleans parsed from one
 * homepage: does it link to about, team, credentials. That is a proxy for
 * internal linking, not a measurement of it. This walks the site properly so
 * the index can report click depth, orphaned pages and anchor-text quality —
 * the things an internal-linking audit actually looks at.
 *
 * Politeness is not optional here. This project publishes a league table that
 * judges other people's sites; crawling them rudely while doing it would be
 * indefensible. So:
 *   - robots.txt is fetched first and obeyed, including a site-wide Disallow
 *   - one request at a time per site, with a delay between them
 *   - hard caps on pages and depth, and a total time budget
 *   - a descriptive User-Agent naming the project and a contact URL
 *
 * No external dependencies: fetch + regex, same as the rest of the pipeline.
 */

import { registrableDomain } from './match.mjs';

export const CRAWL_UA =
	'PYCLocalIndexBot/1.0 (+https://hub.pyc.agency/indices/methodology/; local visibility research)';

const DEFAULTS = {
	maxPages: 40,
	maxDepth: 3,
	perRequestTimeoutMs: 15000,
	totalBudgetMs: 90000,
	delayMs: 700,
};

/* Anchors that name nothing. The anchor is the strongest statement a link
   makes about its destination, and these throw it away. */
const GENERIC_ANCHOR =
	/^(click here|here|read more|more|learn more|find out more|see more|details|more info|more information|link|this|continue|view|view more|go|submit)$/;

/* Pages worth knowing the click depth of, by intent rather than by URL shape. */
const KEY_PAGE_PATTERNS = {
	contact: /contact|get-in-touch|enquir/,
	about: /about|our-story|who-we-are/,
	team: /team|our-people|meet-the|staff/,
	services: /service|what-we-do|our-work|practice-area/,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, timeoutMs) {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			headers: { 'User-Agent': CRAWL_UA, Accept: 'text/html,application/xhtml+xml' },
			redirect: 'follow',
			signal: ctrl.signal,
		});
		const ct = res.headers.get('content-type') || '';
		if (!res.ok || !/text\/html|xml/.test(ct)) return { ok: false, status: res.status, html: '' };
		return { ok: true, status: res.status, html: await res.text(), finalUrl: res.url };
	} catch (e) {
		return { ok: false, status: 0, html: '', error: e?.name === 'AbortError' ? 'timeout' : String(e?.message || e) };
	} finally {
		clearTimeout(t);
	}
}

/* Minimal robots.txt: the rules for the most specific matching user-agent,
   falling back to *. Only Disallow/Allow prefixes, which is what matters here.
   A robots.txt we cannot fetch is treated as "allowed" (the standard reading),
   but a robots.txt that disallows everything stops the crawl entirely. */
export function parseRobots(txt, ua) {
	const groups = [];
	let current = null;
	for (const raw of String(txt || '').split('\n')) {
		const line = raw.replace(/#.*$/, '').trim();
		if (!line) continue;
		const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
		if (!m) continue;
		const field = m[1].toLowerCase();
		const value = m[2].trim();
		if (field === 'user-agent') {
			if (!current || current.rules.length) { current = { agents: [], rules: [] }; groups.push(current); }
			current.agents.push(value.toLowerCase());
		} else if (current && (field === 'disallow' || field === 'allow')) {
			current.rules.push({ allow: field === 'allow', path: value });
		}
	}
	const name = ua.toLowerCase();
	const exact = groups.find((g) => g.agents.some((a) => a !== '*' && name.includes(a)));
	const star = groups.find((g) => g.agents.includes('*'));
	return (exact || star || { rules: [] }).rules;
}

export function robotsAllows(rules, pathname) {
	/* Longest matching rule wins; Allow beats Disallow at equal length, which is
	   the behaviour Google documents. */
	let best = null;
	for (const r of rules) {
		if (r.path === '') continue;
		const p = r.path.replace(/\*+$/, '');
		if (!pathname.startsWith(p)) continue;
		if (!best || p.length > best.len || (p.length === best.len && r.allow)) {
			best = { len: p.length, allow: r.allow };
		}
	}
	return best ? best.allow : true;
}

function absolute(href, base) {
	try {
		const u = new URL(href, base);
		u.hash = '';
		if (!/^https?:$/.test(u.protocol)) return null;
		return u;
	} catch { return null; }
}

/* Strip the obvious non-page URLs before spending a request on them. */
const SKIP_EXT = /\.(pdf|jpe?g|png|gif|webp|svg|ico|css|js|zip|docx?|xlsx?|mp4|mp3|woff2?)$/i;

export async function crawlSite(startUrl, opts = {}) {
	const cfg = { ...DEFAULTS, ...opts };
	const started = Date.now();
	const out = {
		source: 'First-party crawl (robots-respecting)',
		startUrl,
		pagesCrawled: 0,
		pagesDiscovered: 0,
		internalLinks: 0,
		avgInternalLinksPerPage: null,
		maxDepthReached: 0,
		genericAnchors: 0,
		genericAnchorRatio: null,
		keyPageDepth: { contact: null, about: null, team: null, services: null },
		orphanCandidates: null,
		sitemapUrls: null,
		robotsDisallowedAll: false,
		stoppedBecause: null,
		error: null,
	};

	let origin;
	try { origin = new URL(startUrl).origin; }
	catch { out.error = 'invalid start URL'; return out; }

	const home = registrableDomain(startUrl);
	if (!home) { out.error = 'cannot resolve registrable domain'; return out; }

	// ---- robots ----
	let rules = [];
	const rob = await fetchText(`${origin}/robots.txt`, cfg.perRequestTimeoutMs);
	if (rob.ok) rules = parseRobots(rob.html, CRAWL_UA);
	if (!robotsAllows(rules, '/')) {
		out.robotsDisallowedAll = true;
		out.stoppedBecause = 'robots.txt disallows this crawler';
		return out;
	}

	// ---- crawl ----
	const seen = new Set();
	const queue = [{ url: startUrl, depth: 0 }];
	seen.add(startUrl.replace(/\/$/, ''));
	const reached = new Map(); // normalised path -> depth

	while (queue.length) {
		if (out.pagesCrawled >= cfg.maxPages) { out.stoppedBecause = 'page cap'; break; }
		if (Date.now() - started > cfg.totalBudgetMs) { out.stoppedBecause = 'time budget'; break; }

		const { url, depth } = queue.shift();
		let pathname;
		try { pathname = new URL(url).pathname; } catch { continue; }
		if (!robotsAllows(rules, pathname)) continue;

		if (out.pagesCrawled > 0) await sleep(cfg.delayMs);
		const res = await fetchText(url, cfg.perRequestTimeoutMs);
		if (!res.ok) continue;

		out.pagesCrawled++;
		out.maxDepthReached = Math.max(out.maxDepthReached, depth);
		reached.set(pathname.replace(/\/$/, '') || '/', depth);

		for (const m of res.html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
			const u = absolute(m[1], url);
			if (!u) continue;
			if (registrableDomain(u.href) !== home) continue;   // internal only
			out.internalLinks++;

			const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
			if (text && GENERIC_ANCHOR.test(text)) out.genericAnchors++;

			/* Click depth is known the moment the link is seen — the page is
			   depth+1 clicks from the homepage whether or not we spend a request
			   fetching it. Measuring only crawled pages made this null whenever
			   the page cap hit first, which on a listings-heavy site is always. */
			for (const [key, re] of Object.entries(KEY_PAGE_PATTERNS)) {
				if (re.test(u.pathname) && (out.keyPageDepth[key] === null || depth + 1 < out.keyPageDepth[key])) {
					out.keyPageDepth[key] = depth + 1;
				}
			}

			if (SKIP_EXT.test(u.pathname)) continue;
			const norm = u.href.replace(/\/$/, '');
			if (seen.has(norm)) continue;
			seen.add(norm);
			out.pagesDiscovered++;
			if (depth + 1 <= cfg.maxDepth) queue.push({ url: u.href, depth: depth + 1 });
		}
	}

	if (out.pagesCrawled) {
		out.avgInternalLinksPerPage = Number((out.internalLinks / out.pagesCrawled).toFixed(1));
		out.genericAnchorRatio = out.internalLinks
			? Number((out.genericAnchors / out.internalLinks).toFixed(3))
			: null;
	}

	// ---- orphans: in the sitemap but never reached by following links ----
	const sm = await fetchText(`${origin}/sitemap.xml`, cfg.perRequestTimeoutMs);
	if (sm.ok) {
		const locs = [...sm.html.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
		const pages = locs.filter((l) => !/\.xml$/i.test(l) && registrableDomain(l) === home);
		if (pages.length) {
			out.sitemapUrls = pages.length;
			/* Only meaningful when the crawl finished naturally — a crawl stopped
			   by the page cap has unvisited pages by construction, and calling
			   those orphans would be false. */
			if (!out.stoppedBecause) {
				let missing = 0;
				for (const l of pages) {
					let p;
					try { p = new URL(l).pathname.replace(/\/$/, '') || '/'; } catch { continue; }
					if (!reached.has(p)) missing++;
				}
				out.orphanCandidates = missing;
			}
		}
	}

	return out;
}
