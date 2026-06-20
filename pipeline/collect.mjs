/* collect.mjs — Local Digital Visibility Index collector.

   Reads a seed CSV (name,url,gbp_query), gathers the six-pillar RAW signals
   for each business, and writes one JSON per business to
   scripts/index/data/<index-slug>/<business-slug>.json

   Usage:
     node collect.mjs seeds/bristol-estate-agents.csv
     PAGESPEED_API_KEY=xxxx node collect.mjs seeds/bristol-estate-agents.csv

   What is REAL here:
     - Speed & Core Web Vitals  -> Google PageSpeed Insights API (live)
     - Technical foundation     -> live HTTP fetch + parse of homepage / robots / sitemap
     - Content & trust          -> live homepage parse for about/team/credentials links
   What is STUBBED (needs data sources not available in this environment):
     - Local presence           -> Google Places / GBP API
     - Visibility               -> a SERP data source (rank tracker / SERP API)
     - AI search presence       -> programmatic querying of AI engines
   Stubs return null/placeholder values with a documented shape so the
   pipeline runs end-to-end and the scorer can renormalise around them.

   Resilience: every business is wrapped in try/catch; every network call has a
   timeout; one bad site never aborts the run.
*/

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	parseSeed,
	slugify,
	indexSlugFromSeed,
	fetchWithTimeout,
} from './lib/common.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = join(HERE, 'data');
const PSI_ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
const UA = 'PYC-Digital-Visibility-Index/1.0 (+https://hub.pyc.agency/indices/methodology/)';

/* -------------------------------------------------------------------------- */
/* Pillar 1 — Speed & Core Web Vitals (REAL: PageSpeed Insights API)          */
/* -------------------------------------------------------------------------- */

/* Returns: { source, mobilePerformanceScore (0-100|null), lcpMs, inpMs, cls,
   crux: {...}|null, error|null } */
async function collectSpeed(url) {
	const out = {
		source: 'PageSpeed Insights API v5',
		mobilePerformanceScore: null,
		lcpMs: null,
		inpMs: null,
		cls: null,
		crux: null,
		error: null,
	};
	try {
		const params = new URLSearchParams({ url, strategy: 'mobile' });
		params.append('category', 'PERFORMANCE');
		if (process.env.PAGESPEED_API_KEY) params.set('key', process.env.PAGESPEED_API_KEY);
		const res = await fetchWithTimeout(`${PSI_ENDPOINT}?${params}`, { headers: { 'User-Agent': UA } }, 60000);
		if (!res.ok) {
			out.error = `PSI HTTP ${res.status}`;
			return out;
		}
		const data = await res.json();

		// Lighthouse lab performance score (0-1 -> 0-100)
		const perf = data?.lighthouseResult?.categories?.performance?.score;
		if (typeof perf === 'number') out.mobilePerformanceScore = Math.round(perf * 100);

		// Lab metrics (fallback when no field/CrUX data exists)
		const audits = data?.lighthouseResult?.audits || {};
		const labLcp = audits['largest-contentful-paint']?.numericValue;
		const labCls = audits['cumulative-layout-shift']?.numericValue;
		if (typeof labLcp === 'number') out.lcpMs = Math.round(labLcp);
		if (typeof labCls === 'number') out.cls = Number(labCls.toFixed(3));

		// CrUX field data (real-world) — preferred for LCP/INP/CLS when present
		const metrics = data?.loadingExperience?.metrics;
		if (metrics) {
			out.crux = {};
			const lcp = metrics.LARGEST_CONTENTFUL_PAINT_MS;
			const inp = metrics.INTERACTION_TO_NEXT_PAINT;
			const cls = metrics.CUMULATIVE_LAYOUT_SHIFT_SCORE;
			if (lcp) { out.lcpMs = lcp.percentile; out.crux.lcpCategory = lcp.category; }
			if (inp) { out.inpMs = inp.percentile; out.crux.inpCategory = inp.category; }
			if (cls) { out.cls = cls.percentile / 100; out.crux.clsCategory = cls.category; }
			out.crux.overall = data.loadingExperience.overall_category || null;
		}
		return out;
	} catch (e) {
		out.error = e?.name === 'AbortError' ? 'PSI timeout' : String(e?.message || e);
		return out;
	}
}

/* -------------------------------------------------------------------------- */
/* Pillar 2 — Technical foundation (REAL: HTTP fetch + parse)                  */
/* -------------------------------------------------------------------------- */

/* Returns flags about HTTPS, schema, sitemap, robots, viewport, indexability */
async function collectTechnical(url) {
	const out = {
		source: 'Live HTTP fetch + parse',
		https: null,
		finalUrl: null,
		hasJsonLd: null,
		jsonLdTypes: [],
		hasLocalBusinessSchema: null,
		hasViewportMeta: null,
		indexable: null,
		hasSitemap: null,
		sitemapUrl: null,
		hasRobotsTxt: null,
		robotsAllowsIndexing: null,
		error: null,
	};
	let html = '';
	try {
		const res = await fetchWithTimeout(url, { headers: { 'User-Agent': UA } }, 20000);
		out.finalUrl = res.url || url;
		out.https = (out.finalUrl || '').startsWith('https://');
		// X-Robots-Tag header can also carry noindex
		const xRobots = (res.headers.get('x-robots-tag') || '').toLowerCase();
		const headerNoindex = xRobots.includes('noindex');
		if (res.ok) html = await res.text();
		else out.error = `homepage HTTP ${res.status}`;

		if (html) {
			// JSON-LD structured data
			const ldBlocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
			out.hasJsonLd = ldBlocks.length > 0;
			for (const m of ldBlocks) {
				try {
					const json = JSON.parse(m[1].trim());
					collectTypes(json, out.jsonLdTypes);
				} catch {
					// tolerate malformed JSON-LD; still counts as "present"
				}
			}
			out.jsonLdTypes = [...new Set(out.jsonLdTypes)];
			out.hasLocalBusinessSchema = out.jsonLdTypes.some((t) =>
				/LocalBusiness|RealEstateAgent|Organization/i.test(t));

			// viewport meta (mobile-friendliness proxy)
			out.hasViewportMeta = /<meta[^>]+name=["']viewport["']/i.test(html);

			// indexability: meta robots noindex OR header noindex
			const metaRobots = html.match(/<meta[^>]+name=["']robots["'][^>]*>/i);
			const metaNoindex = metaRobots ? /noindex/i.test(metaRobots[0]) : false;
			out.indexable = !(metaNoindex || headerNoindex);
		}
	} catch (e) {
		out.error = e?.name === 'AbortError' ? 'homepage timeout' : String(e?.message || e);
	}

	// robots.txt + sitemap (best-effort, independent of homepage parse)
	const origin = safeOrigin(out.finalUrl || url);
	if (origin) {
		try {
			const r = await fetchWithTimeout(`${origin}/robots.txt`, { headers: { 'User-Agent': UA } }, 12000);
			if (r.ok) {
				const body = await r.text();
				out.hasRobotsTxt = true;
				out.robotsAllowsIndexing = !/^\s*disallow:\s*\/\s*$/im.test(body);
				const sm = body.match(/^\s*sitemap:\s*(\S+)/im);
				if (sm) out.sitemapUrl = sm[1].trim();
			} else {
				out.hasRobotsTxt = false;
			}
		} catch {
			out.hasRobotsTxt = false;
		}

		// sitemap: prefer the one declared in robots.txt, else /sitemap.xml
		const sitemapCandidate = out.sitemapUrl || `${origin}/sitemap.xml`;
		try {
			const s = await fetchWithTimeout(sitemapCandidate, { method: 'GET', headers: { 'User-Agent': UA } }, 12000);
			out.hasSitemap = s.ok;
			if (s.ok && !out.sitemapUrl) out.sitemapUrl = sitemapCandidate;
		} catch {
			out.hasSitemap = false;
		}
	}

	return out;
}

function collectTypes(node, acc) {
	if (!node) return;
	if (Array.isArray(node)) { node.forEach((n) => collectTypes(n, acc)); return; }
	if (typeof node === 'object') {
		if (node['@type']) {
			const t = node['@type'];
			if (Array.isArray(t)) acc.push(...t);
			else acc.push(t);
		}
		if (Array.isArray(node['@graph'])) collectTypes(node['@graph'], acc);
	}
}

function safeOrigin(u) {
	try { return new URL(u).origin; } catch { return null; }
}

/* -------------------------------------------------------------------------- */
/* Pillar 6 — Content & trust (REAL where cheap; indexed-count STUBBED)        */
/* -------------------------------------------------------------------------- */

async function collectContent(url) {
	const out = {
		source: 'Live homepage parse (links) + STUB indexed-count',
		hasAboutLink: null,
		hasTeamLink: null,
		hasCredentialsLink: null, // e.g. ARLA / Propertymark / NAEA / RICS / Ombudsman
		// STUB: a true indexed-page count needs GSC or a crawl; not available here.
		indexedPageCount: null,
		contentFreshnessDays: null, // STUB: needs blog/post dates parse or sitemap lastmod analysis
		error: null,
	};
	try {
		const res = await fetchWithTimeout(url, { headers: { 'User-Agent': UA } }, 20000);
		if (!res.ok) { out.error = `homepage HTTP ${res.status}`; return out; }
		const html = (await res.text()).toLowerCase();

		const anchorText = [...html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => m[1]);
		const hrefs = [...html.matchAll(/href=["']([^"']+)["']/gi)].map((m) => m[1]);
		const haystack = anchorText.join(' ') + ' ' + hrefs.join(' ');

		out.hasAboutLink = /\babout\b|about-us|our-story|who-we-are/.test(haystack);
		out.hasTeamLink = /\bteam\b|our-team|meet-the-team|our-people|staff/.test(haystack);
		out.hasCredentialsLink =
			/propertymark|naea|arla|rics|ombudsman|tpos|the-property-ombudsman|client-money-protection|cmp/.test(haystack);
	} catch (e) {
		out.error = e?.name === 'AbortError' ? 'homepage timeout' : String(e?.message || e);
	}
	return out;
}

/* -------------------------------------------------------------------------- */
/* Pillar 3 — Local presence (STUB: Google Places / GBP API)                  */
/* -------------------------------------------------------------------------- */

/* INTERFACE
   input : gbp_query string (e.g. "CJ Hole Estate Agents Bristol")
   output: {
     source, found:boolean|null, reviewCount:number|null, avgRating:number|null,
     reviewsLast90d:number|null, profileCompleteness:number|null (0-1),
     napConsistent:boolean|null, placeId:string|null, error|null
   }
   TODO: Implement with Google Places API:
     1. Places Text Search (gbp_query) -> place_id
     2. Place Details (place_id, fields: rating,user_ratings_total,reviews,...)
     3. Review velocity: count reviews with time within 90d (Places only returns
        up to 5 reviews; full velocity needs the Business Profile API or a
        review-aggregation source).
     4. NAP consistency: compare name/address/phone vs the seed + the homepage.
   Requires GOOGLE_PLACES_API_KEY (billable). Returns nulls until implemented. */
async function collectLocal(gbpQuery) {
	return {
		source: 'STUB — Google Places / Business Profile API (not yet wired)',
		stub: true,
		query: gbpQuery || null,
		found: null,
		reviewCount: null,
		avgRating: null,
		reviewsLast90d: null,
		profileCompleteness: null,
		napConsistent: null,
		placeId: null,
		error: null,
	};
}

/* -------------------------------------------------------------------------- */
/* Pillar 4 — Visibility (STUB: SERP data source)                             */
/* -------------------------------------------------------------------------- */

/* INTERFACE
   input : { name, keywordBasket: string[] }  (basket lives in methodology)
   output: {
     source, keywordBasket:string[], rankedKeywords:number|null,
     avgPosition:number|null, localPackAppearances:number|null,
     basketSize:number|null, error|null
   }
   TODO: Implement against a SERP API (e.g. a rank-tracker / SERP provider) with
   geo-located Bristol queries. For each keyword in the basket, record the
   business's organic position and whether it appears in the local 3-pack.
   Requires a SERP_API_KEY. Returns nulls until implemented. */
async function collectVisibility(name) {
	const keywordBasket = [
		'estate agents Bristol',
		'estate agents Clifton',
		'estate agents Redland',
		'sell my house Bristol',
		'letting agents Bristol',
		'best estate agent Bristol',
	];
	return {
		source: 'STUB — SERP data source (not yet wired)',
		stub: true,
		business: name || null,
		keywordBasket,
		basketSize: keywordBasket.length,
		rankedKeywords: null,
		avgPosition: null,
		localPackAppearances: null,
		error: null,
	};
}

/* -------------------------------------------------------------------------- */
/* Pillar 5 — AI search presence (STUB: AI-engine querying)                   */
/* -------------------------------------------------------------------------- */

/* INTERFACE
   input : { name, queryBasket: string[] }
   output: {
     source, queryBasket:string[], basketSize:number|null,
     enginesChecked:string[], citationsByEngine:{[engine]:number}|null,
     citedQueryCount:number|null, error|null
   }
   TODO: For each core local query, query AI Overviews / ChatGPT search /
   Perplexity / Gemini and detect whether `name` is named or cited. Score =
   % of (engine x query) cells where the business appears. Needs per-engine
   API access or an AI-SERP source. Returns nulls until implemented. */
async function collectAiPresence(name) {
	const queryBasket = [
		'estate agents Bristol',
		'best estate agent Clifton Bristol',
		'who are the top estate agents in Bristol',
		'recommended estate agent Redland Bristol',
	];
	return {
		source: 'STUB — AI-engine querying (not yet wired)',
		stub: true,
		business: name || null,
		queryBasket,
		basketSize: queryBasket.length,
		enginesChecked: ['AI Overviews', 'ChatGPT search', 'Perplexity', 'Gemini'],
		citationsByEngine: null,
		citedQueryCount: null,
		error: null,
	};
}

/* -------------------------------------------------------------------------- */
/* Per-business orchestration                                                  */
/* -------------------------------------------------------------------------- */

async function collectBusiness(biz, indexSlug) {
	const slug = slugify(biz.name);
	const record = {
		schemaVersion: 1,
		index: indexSlug,
		slug,
		name: biz.name,
		url: biz.url,
		gbpQuery: biz.gbp_query || null,
		collectedAt: new Date().toISOString(),
		pillars: {},
		errors: [],
	};

	const steps = [
		['speed', () => collectSpeed(biz.url)],
		['technical', () => collectTechnical(biz.url)],
		['local', () => collectLocal(biz.gbp_query)],
		['visibility', () => collectVisibility(biz.name)],
		['ai', () => collectAiPresence(biz.name)],
		['content', () => collectContent(biz.url)],
	];

	for (const [key, fn] of steps) {
		try {
			record.pillars[key] = await fn();
			if (record.pillars[key]?.error) record.errors.push(`${key}: ${record.pillars[key].error}`);
		} catch (e) {
			record.pillars[key] = { error: String(e?.message || e) };
			record.errors.push(`${key}: ${e?.message || e}`);
		}
	}

	return record;
}

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

async function main() {
	const seedArg = process.argv[2];
	if (!seedArg) {
		console.error('Usage: node collect.mjs <seed.csv>');
		console.error('Example: node collect.mjs seeds/bristol-estate-agents.csv');
		process.exit(1);
	}
	const seedPath = isAbsolute(seedArg) ? seedArg : resolve(process.cwd(), seedArg);
	const indexSlug = indexSlugFromSeed(seedPath);
	const outDir = join(DATA_ROOT, indexSlug);

	let businesses;
	try {
		businesses = parseSeed(await readFile(seedPath, 'utf8'));
	} catch (e) {
		console.error(`Cannot read seed file ${seedPath}: ${e.message}`);
		process.exit(1);
	}
	if (!businesses.length) {
		console.error('Seed file parsed to zero businesses. Check the header row (name,url,gbp_query).');
		process.exit(1);
	}

	await mkdir(outDir, { recursive: true });
	console.log(`Index: ${indexSlug}`);
	console.log(`Businesses: ${businesses.length}`);
	console.log(`PageSpeed API key: ${process.env.PAGESPEED_API_KEY ? 'set' : 'NOT set (keyless low-rate mode)'}`);
	console.log(`Output: ${outDir}\n`);

	let ok = 0;
	for (const biz of businesses) {
		try {
			const record = await collectBusiness(biz, indexSlug);
			const file = join(outDir, `${record.slug}.json`);
			await writeFile(file, JSON.stringify(record, null, 2) + '\n');
			const errs = record.errors.length ? ` (${record.errors.length} signal error(s))` : '';
			console.log(`  ✓ ${biz.name} -> ${record.slug}.json${errs}`);
			ok++;
		} catch (e) {
			// last-resort guard: one business never aborts the run
			console.error(`  ✗ ${biz.name} — FAILED: ${e?.message || e}`);
		}
	}

	console.log(`\nDone. Wrote ${ok}/${businesses.length} business records to ${outDir}`);
	console.log('Next: node score.mjs ' + indexSlug);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
