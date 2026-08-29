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

async function fetchText(url, timeoutMs, { allowPlain = false } = {}) {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			headers: { 'User-Agent': CRAWL_UA, Accept: 'text/html,application/xhtml+xml' },
			redirect: 'follow',
			signal: ctrl.signal,
		});
		const ct = res.headers.get('content-type') || '';
		/* robots.txt is served as text/plain. The html/xml gate silently rejected
		   it, so `rules` stayed empty and every path was treated as allowed —
		   the crawler claimed to obey robots.txt while never reading one. */
		const okType = allowPlain ? /text\/|xml/.test(ct) || ct === '' : /text\/html|xml/.test(ct);
		if (!res.ok || !okType) return { ok: false, status: res.status, html: '' };
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
	/* Match on the PRODUCT TOKEN, not the whole UA string. The full UA contains
	   "research", "local", "agency" and "hub", so `name.includes(a)` bound this
	   crawler to any group named for those words — and `find` took the first
	   such group rather than the most specific. */
	const token = (ua.split('/')[0] || ua).toLowerCase();
	let best = null;
	for (const g of groups) {
		for (const a of g.agents) {
			if (a === '*' || !token.includes(a)) continue;
			if (!best || a.length > best.len) best = { len: a.length, group: g };
		}
	}
	const star = groups.find((g) => g.agents.includes('*'));
	return (best?.group || star || { rules: [] }).rules;
}

export function robotsAllows(rules, pathname) {
	/* Longest matching rule wins; Allow beats Disallow at equal length, which is
	   the behaviour Google documents.

	   Patterns may contain `*` anywhere and may end with `$`. Stripping only a
	   trailing `*` left `Disallow: /*?*` (Shopify's default) as a literal
	   prefix that never matched, silently allowing everything it was meant to
	   block. Specificity is measured on the pattern length, per the spec. */
	let best = null;
	for (const r of rules) {
		if (r.path === '') continue;
		if (!robotsPatternMatches(r.path, pathname)) continue;
		const len = r.path.length;
		if (!best || len > best.len || (len === best.len && r.allow)) {
			best = { len, allow: r.allow };
		}
	}
	return best ? best.allow : true;
}

function robotsPatternMatches(pattern, pathname) {
	const anchored = pattern.endsWith('$');
	const body = anchored ? pattern.slice(0, -1) : pattern;
	if (!body.includes('*')) {
		return anchored ? pathname === body : pathname.startsWith(body);
	}
	const rx = body.split('*').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
	return new RegExp('^' + rx + (anchored ? '$' : '')).test(pathname);
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
		depthLimited: false,
		error: null,
	};

	let origin;
	try { origin = new URL(startUrl).origin; }
	catch { out.error = 'invalid start URL'; return out; }

	const home = registrableDomain(startUrl);
	if (!home) { out.error = 'cannot resolve registrable domain'; return out; }

	// ---- robots ----
	let rules = [];
	const rob = await fetchText(`${origin}/robots.txt`, cfg.perRequestTimeoutMs, { allowPlain: true });
	if (rob.ok) rules = parseRobots(rob.html, CRAWL_UA);
	if (!robotsAllows(rules, '/')) {
		out.robotsDisallowedAll = true;
		out.stoppedBecause = 'robots.txt disallows this crawler';
		return out;
	}

	// ---- crawl ----
	let depthTruncated = false;
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
		if (!robotsAllows(rules, pathname)) {
			/* robots.txt may allow "/" but disallow the start path itself. That
			   emptied the queue with no error and no stoppedBecause — the exact
			   reasonless zero this was meant to eliminate. */
			if (out.pagesCrawled === 0 && url === startUrl) {
				out.stoppedBecause = 'robots.txt disallows the start page';
			}
			continue;
		}

		if (out.pagesCrawled > 0) await sleep(cfg.delayMs);
		const res = await fetchText(url, cfg.perRequestTimeoutMs);
		if (!res.ok) {
			/* The start page failing is the whole crawl failing, and it was being
			   reported as a bare "0 pages" with no reason — indistinguishable
			   from a site that legitimately has nothing to crawl. */
			if (out.pagesCrawled === 0 && url === startUrl) {
				out.error = res.error || `homepage HTTP ${res.status || 'unreachable'}`;
			}
			continue;
		}

		/* Resolve against the post-redirect URL: a relative href on a page that
		   redirected would otherwise resolve against the pre-redirect path,
		   producing wrong depths and fetching the same page under two URLs. */
		const base = res.finalUrl || url;
		out.pagesCrawled++;
		out.maxDepthReached = Math.max(out.maxDepthReached, depth);
		reached.set(pathname.replace(/\/$/, '') || '/', depth);

		for (const m of res.html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
			const u = absolute(m[1], base);
			if (!u) continue;
			/* Same ORIGIN, not merely the same registrable domain. robots.txt is
			   per-origin, so following www -> shop.example.com would apply the
			   wrong site's rules — or none at all. Cross-subdomain links still
			   count as internal for the link tally. */
			if (registrableDomain(u.href) !== home) continue;   // internal only
			const sameOrigin = u.origin === origin;
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

			if (!sameOrigin) continue;
			if (SKIP_EXT.test(u.pathname)) continue;
			const norm = u.href.replace(/\/$/, '');
			if (seen.has(norm)) continue;
			seen.add(norm);
			out.pagesDiscovered++;
			if (depth + 1 <= cfg.maxDepth) queue.push({ url: u.href, depth: depth + 1 });
			else depthTruncated = true;
		}
	}

	out.depthLimited = depthTruncated;
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
			/* Only when the crawl genuinely exhausted the site. A queue drained
			   because maxDepth cut it short still has unvisited pages, and
			   calling those orphans publishes a false number on a firm's page. */
			if (!out.stoppedBecause && !depthTruncated) {
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
