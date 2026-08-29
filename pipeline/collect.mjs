/* collect.mjs — Local Digital Visibility Index collector.

   Reads a seed CSV (name,url,gbp_query), gathers the six-pillar RAW signals
   for each business, and writes one JSON per business to
   pipeline/data/<index-slug>/<business-slug>.json

   Usage:
     node collect.mjs seeds/bristol-estate-agents.csv
     node collect.mjs seeds/bristol-estate-agents.csv --dry-run

   All six pillars are live:
     - Speed & Core Web Vitals  -> Google PageSpeed Insights API (free)
     - Technical foundation     -> live HTTP fetch + parse (free)
     - Content & trust          -> live homepage parse (free)
     - Local presence           -> DataForSEO business_listings sweep (per index)
                                   + my_business_info fallback + reviews
     - Visibility               -> DataForSEO SERP, standard queue
     - AI search presence       -> DataForSEO llm_responses (Perplexity sonar)

   COST SHAPE — this is why the collector is ordered the way it is.
   Visibility and AI presence are bought ONCE PER INDEX and read for every
   business in it: one geo-located SERP response holds every firm's position,
   and one AI answer names whichever firms it names. Those costs divide across
   the seed. Local presence is mostly shared too: one business_listings sweep
   covers the whole index and aggregates each firm's branches, with a
   per-business profile lookup only for what the sweep misses. Collecting the
   shared signals per-business instead would multiply the index's cost by the
   number of businesses in it for identical data.

   Settings live in config/engine.json; keyword and prompt baskets are derived
   from config/sectors.json + config/indices.json.

   Alongside the per-business records, each run writes _landscape.json: every
   organic domain and paid advertiser seen across the index's SERPs, page-one
   share split between seed and non-seed, and the untracked domains that rank
   well enough to belong in the seed. All of it is extracted from responses
   already bought, so it adds nothing to the bill.

   Resilience: every business is wrapped in try/catch; every network call has a
   timeout; one bad site never aborts the run. A keyword whose SERP task fails
   is excluded from that index's basket size rather than counted as a miss, so
   an API failure never silently depresses everyone's coverage score.
*/

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
	parseSeed,
	slugify,
	indexSlugFromSeed,
	fetchWithTimeout,
} from './lib/common.mjs';
import {
	loadEnv,
	ledger,
	balance,
	serpPost,
	serpHarvest,
	llmResponse,
	llmText,
	myBusinessInfoBatch,
	reviewsBatch,
	businessListings,
	businessListingsByTitle,
	searchIntent,
	localPackGrid,
	buildGrid,
	spendSince,
} from './lib/dataforseo.mjs';
import { loadConfig, resolveIndex, buildKeywords, buildPrompts } from './lib/basket.mjs';
import { findOrganicPosition, inLocalPack, matchReason, domainsMatch, buildLandscape, matchTargeted, searchNeedle } from './lib/match.mjs';
import { crawlSite } from './lib/crawl.mjs';
import { collectCrux, collectCompaniesHouse, collectFsa } from './lib/enrich.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = join(HERE, 'data');
const PSI_ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
const UA = 'PYC-Digital-Visibility-Index/1.0 (+https://hub.pyc.agency/indices/methodology/)';

/* -------------------------------------------------------------------------- */
/* Pillar 1 — Speed & Core Web Vitals (PageSpeed Insights API)                */
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
/* Pillar 2 — Technical foundation (HTTP fetch + parse)                        */
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
/* Pillar 6 — Content & trust (indexed-count still stubbed)                    */
/* -------------------------------------------------------------------------- */

/* Exported so a correction can re-run this one check without re-collecting
   everything. Re-measuring all six pillars to fix one signal would mix the fix
   with genuine drift and make the change unattributable. */
export async function collectContent(url, sectorCfg) {
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
		/* Sector-specific, because a single property-sector regex was being
		   applied to every index. It matched Propertymark/NAEA/ARLA/RICS and
		   nothing else, so construction, law, accountancy and dental cohorts
		   scored 0% on credentials — a detector artefact published as a finding
		   about those firms, and one that skewed the whole three-link analysis
		   towards estate agents. Generic terms are included so a firm that says
		   "accredited" without naming a body is still detected. */
		const credTerms = [...(sectorCfg?.credentialTerms || []), ...GENERIC_CREDENTIAL_TERMS];
		out.hasCredentialsLink = credTerms.some((t) => haystack.includes(t));
	} catch (e) {
		out.error = e?.name === 'AbortError' ? 'homepage timeout' : String(e?.message || e);
	}
	return out;
}

/* -------------------------------------------------------------------------- */
/* Pillar 3 — Local presence (DataForSEO my_business_info + reviews)          */
/* -------------------------------------------------------------------------- */

/* Fields that together make a Google Business Profile "complete". Weighted
   equally; the fraction present becomes profileCompleteness (0-1). */
/* Words a site uses when it is signalling regulation without naming a body. */
const GENERIC_CREDENTIAL_TERMS = ['accredited', 'accreditation', 'registered-with', 'regulated-by', 'our-credentials', 'memberships', 'professional-body'];

const GBP_COMPLETENESS_FIELDS = [
	'title', 'address', 'phone', 'url', 'work_time',
	'category', 'description', 'main_image', 'latitude',
];

function profileCompleteness(item) {
	if (!item) return null;
	let present = 0;
	for (const f of GBP_COMPLETENESS_FIELDS) {
		const v = item[f];
		if (v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)) present++;
	}
	return Number((present / GBP_COMPLETENESS_FIELDS.length).toFixed(3));
}

/* Reviews newer than the configured window. DataForSEO returns `timestamp` as
   an ISO-ish string; anything unparseable is skipped rather than counted. */
function countRecentReviews(reviewsResult, windowDays) {
	if (!reviewsResult) return null;
	const items = reviewsResult.items || [];
	if (!items.length) return 0;
	const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
	let n = 0;
	for (const r of items) {
		const raw = r.timestamp || r.time_ago_iso || null;
		if (!raw) continue;
		const t = Date.parse(String(raw).replace(' ', 'T'));
		if (Number.isNaN(t)) continue;
		if (t >= cutoff) n++;
	}
	return n;
}

/* NAP consistency, checkable slice: does the website Google has on the profile
   resolve to the same registrable domain as the seed URL? A mismatch is a real
   consistency failure (stale profile, wrong site, franchise page). */
function napConsistency(item, business) {
	if (!item || !item.url) return null;
	return domainsMatch(item.url, business.url);
}

/* Find every listing belonging to one seed business. Domain is authoritative;
   name matching is the fallback for firms whose listing carries no website.
   Returns ALL matches, because a chain's branches are separate listings. */
export function matchListings(listings, business) {
	const byDomain = listings.filter((i) => i.domain && domainsMatch(i.domain, business.url));
	if (byDomain.length) return { items: byDomain, matchedBy: 'domain' };
	const byName = listings.filter((i) => i.title && matchReason(i.title, business));
	return byName.length ? { items: byName, matchedBy: 'name' } : { items: [], matchedBy: null };
}

/* Aggregate a firm's branches into one local-presence record.

   Ratings are weighted by review count, not averaged flat — a 4.9 with 3
   reviews must not outweigh a 4.2 with 500. Review counts are summed, which
   does advantage multi-branch chains; that is a real difference in local
   presence, and branchCount + placeIds are recorded so the effect is visible
   and auditable rather than hidden in a single number. */
function aggregateBranches(items) {
	const rated = items.filter((i) => typeof i.rating?.votes_count === 'number' && i.rating.votes_count > 0);
	const reviewCount = rated.reduce((s, i) => s + i.rating.votes_count, 0);
	const weighted = rated.reduce((s, i) => s + (i.rating.value || 0) * i.rating.votes_count, 0);

	return {
		reviewCount: items.length ? reviewCount : null,
		avgRating: reviewCount ? Number((weighted / reviewCount).toFixed(2)) : null,
		// Best profile in the group: a chain is judged on its strongest presence.
		profileCompleteness: items.length
			? Math.max(...items.map((i) => profileCompleteness(i) ?? 0))
			: null,
		branchCount: items.length,
		placeIds: items.map((i) => i.place_id || i.cid).filter(Boolean),
		/* business_listings returns latitude/longitude in a response already paid
		   for. Storing it now means a later version can plot a firm's offices
		   against its local-pack coverage without another collection. */
		coordinates: items
			.filter((i) => typeof i.latitude === 'number' && typeof i.longitude === 'number')
			.map((i) => ({ lat: i.latitude, lng: i.longitude })),
		claimed: items.some((i) => i.is_claimed === true) || null,
	};
}

function buildLocal(business, matched, gbpItem, reviewsResult, cfg, lookupError = null) {
	const usingListings = matched && matched.items.length > 0;
	const out = {
		source: usingListings
			? 'DataForSEO business_data/business_listings/search'
			: 'DataForSEO business_data/google/my_business_info (fallback)',
		matchedBy: usingListings ? matched.matchedBy : (gbpItem ? 'query' : null),
		query: business.gbpQuery || null,
		found: Boolean(usingListings || gbpItem),
		reviewCount: null,
		avgRating: null,
		reviewsLast90d: null,
		profileCompleteness: null,
		napConsistent: null,
		placeId: null,
		branchCount: null,
		claimed: null,
		error: null,
	};

	if (usingListings) {
		const agg = aggregateBranches(matched.items);
		out.reviewCount = agg.reviewCount;
		out.avgRating = agg.avgRating;
		out.profileCompleteness = agg.profileCompleteness;
		out.branchCount = agg.branchCount;
		out.claimed = agg.claimed;
		out.placeId = agg.placeIds[0] || null;
		out.napConsistent = napConsistency(matched.items[0], business);
	} else if (gbpItem) {
		out.placeId = gbpItem.place_id || gbpItem.cid || null;
		out.avgRating = typeof gbpItem.rating?.value === 'number' ? gbpItem.rating.value : null;
		out.reviewCount = typeof gbpItem.rating?.votes_count === 'number' ? gbpItem.rating.votes_count : null;
		out.profileCompleteness = profileCompleteness(gbpItem);
		out.napConsistent = napConsistency(gbpItem, business);
		out.branchCount = 1;
	} else {
		/* Distinguish "we looked and it isn't there" from "the lookup failed" —
		   publishing the second as the first is a false absence. */
		out.error = lookupError
			? `Google Business Profile not determined — ${lookupError}`
			: 'no Google Business Profile found by listings sweep, direct lookup, or targeted title search';
		out.lookupFailed = Boolean(lookupError);
		return out;
	}

	if (cfg.local.reviewVelocity) {
		out.reviewsLast90d = countRecentReviews(reviewsResult, cfg.local.velocityWindowDays || 90);
		if (out.reviewsLast90d === null) out.error = 'review velocity unavailable (reviews task failed)';
	}

	return out;
}

/* -------------------------------------------------------------------------- */
/* Pillar 4 — Visibility (DataForSEO SERP, read from the shared index pull)   */
/* -------------------------------------------------------------------------- */

/* basketSize counts only the keywords whose SERP task actually returned. A
   failed keyword is excluded from the denominator rather than scored as a miss
   — otherwise one API failure quietly depresses every business in the index. */
function buildVisibility(business, keywords, serpByKeyword, cfg) {
	const out = {
		source: `DataForSEO SERP google/organic (${cfg.serp.mode}, depth ${cfg.serp.depth})`,
		keywordBasket: keywords,
		basketSize: null,
		rankedKeywords: null,
		avgPosition: null,
		localPackAppearances: null,
		positions: {},
		error: null,
	};

	let measured = 0;
	let ranked = 0;
	let packs = 0;
	const positions = [];

	for (const kw of keywords) {
		const result = serpByKeyword.get(kw);
		if (!result) continue;
		measured++;
		const hit = findOrganicPosition(result, business);
		if (hit && typeof hit.position === 'number') {
			ranked++;
			positions.push(hit.position);
			out.positions[kw] = hit.position;
		}
		if (inLocalPack(result, business)) packs++;
	}

	if (!measured) {
		out.error = 'no SERP results available for this index';
		return out;
	}

	out.basketSize = measured;
	out.rankedKeywords = ranked;
	out.localPackAppearances = packs;
	out.avgPosition = positions.length
		? Number((positions.reduce((a, b) => a + b, 0) / positions.length).toFixed(1))
		: null;

	return out;
}

/* -------------------------------------------------------------------------- */
/* Pillar 5 — AI search presence (DataForSEO llm_responses, shared per index) */
/* -------------------------------------------------------------------------- */

function buildAiPresence(business, aiAnswers, cfg) {
	const engine = cfg.ai.engine;
	const out = {
		source: `DataForSEO ai_optimization/${engine}/llm_responses (${cfg.ai.model})`,
		queryBasket: aiAnswers.map((a) => a.prompt),
		basketSize: null,
		enginesChecked: [engine],
		citationsByEngine: null,
		citedQueryCount: null,
		citedQueries: [],
		error: null,
	};

	const usable = aiAnswers.filter((a) => a.text);
	if (!usable.length) {
		out.error = 'no AI answers available for this index';
		return out;
	}

	let cited = 0;
	for (const a of usable) {
		const via = matchReason(a.text, business);
		if (via) {
			cited++;
			// Record how it matched: a domain citation is stronger evidence than a
			// bare name mention, and a published score should be auditable.
			out.citedQueries.push({ prompt: a.prompt, matchedBy: via });
		}
	}

	out.basketSize = usable.length;
	out.citedQueryCount = cited;
	out.citationsByEngine = { [engine]: cited };
	return out;
}

/* -------------------------------------------------------------------------- */
/* Per-business orchestration                                                  */
/* -------------------------------------------------------------------------- */

async function collectBusiness(biz, indexSlug, shared, cfg) {
	const slug = slugify(biz.name);
	const business = { name: biz.name, url: biz.url, gbpQuery: biz.gbp_query || null };

	const record = {
		schemaVersion: 2,
		index: indexSlug,
		slug,
		name: biz.name,
		url: biz.url,
		gbpQuery: business.gbpQuery,
		collectedAt: new Date().toISOString(),
		pillars: {},
		errors: [],
	};

	/* Free, per-business network calls.

	   crawl, crux and companies are enrichment, not pillars: they carry no
	   weight in the Digital Visibility Score and cannot move a ranking. That is
	   deliberate — a published score must not change because a third party
	   enabled an API key. They exist to make the score harder to argue with
	   (CrUX is field data against our lab speed number), to let the index
	   segment fairly (company age and size answer "you are comparing a
	   three-person firm to a fifty-person one"), and to turn three boolean
	   homepage checks into a real internal-linking measurement.

	   Each degrades to nulls without its key or on any error, and a null is
	   excluded rather than scored as zero — the rule the whole pipeline
	   follows. */
	const steps = [
		['speed', () => collectSpeed(biz.url)],
		['technical', () => collectTechnical(biz.url)],
		['content', () => collectContent(biz.url, shared.sector)],
	];

	const enrichers = [
		['crawl', () => crawlSite(biz.url, { maxPages: 25, maxDepth: 2, totalBudgetMs: 60000 })],
		['crux', () => collectCrux(biz.url)],
		['companies', () => collectCompaniesHouse(biz.name, { town: shared.town })],
	];

	/* Food hygiene ratings, only where the sector is actually inspected. The
	   FSA is free and open, which is why restaurants lead the sectors with an
	   official rating to cross-reference — the professional regulators all
	   disallow the endpoints their data would have to come from. */
	if (shared.sector?.fsaRated) {
		enrichers.push(['fsa', () => collectFsa(biz.name, { town: shared.town, coordinate: shared.coordinate })]);
	}

	for (const [key, fn] of steps) {
		try {
			record.pillars[key] = await fn();
			if (record.pillars[key]?.error) record.errors.push(`${key}: ${record.pillars[key].error}`);
		} catch (e) {
			record.pillars[key] = { error: String(e?.message || e) };
			record.errors.push(`${key}: ${e?.message || e}`);
		}
	}

	record.enrichment = {};
	record.enrichmentErrors = [];
	for (const [key, fn] of enrichers) {
		try {
			record.enrichment[key] = await fn();
		} catch (e) {
			/* Enrichment never fails a business. A crawler timeout or a missing
			   API key must not cost us a scored record. */
			record.enrichment[key] = { error: String(e?.message || e) };
		}
		/* Kept out of record.errors, which is reported as "N signal error(s)" and
		   describes the quality of the MEASUREMENT. A crawl timeout on a
		   business whose six pillars collected cleanly is not a data-quality
		   problem with that business's score. */
		const err = record.enrichment[key]?.error;
		if (err && err !== 'no API key') record.enrichmentErrors.push(`${key}: ${err}`);
	}

	// Derived from data already bought — no further API cost.
	const gbpKey = shared.gbpKeyFor(biz);
	record.pillars.local = buildLocal(
		business,
		shared.listingMatches.get(gbpKey) || null,
		shared.gbpByQuery.get(gbpKey) || null,
		shared.reviewsByQuery.get(gbpKey) || null,
		cfg,
		shared.targetedErrors?.get(gbpKey) || null
	);
	record.pillars.visibility = buildVisibility(business, shared.keywords, shared.serpByKeyword, cfg);
	record.pillars.ai = buildAiPresence(business, shared.aiAnswers, cfg);

	for (const key of ['local', 'visibility', 'ai']) {
		if (record.pillars[key]?.error) record.errors.push(`${key}: ${record.pillars[key].error}`);
	}

	return record;
}

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

/* The absolute account balance is business financial information, and this
   repo is public — Actions logs on a public repository are readable by anyone.
   Suppressed under CI, where it has no operational value anyway: the run still
   reports forecast, ledger and reconciled spend, which is what the open-data
   transparency story needs. Locally it prints as before. */
const PUBLIC_LOG = !!process.env.CI;
const redactBalance = (v) =>
	PUBLIC_LOG ? '(hidden in CI)' : `$${v?.toFixed(4) ?? '?'}`;

async function main() {
	loadEnv();

	const args = process.argv.slice(2);
	const dryRun = args.includes('--dry-run');
	const seedArg = args.find((a) => !a.startsWith('--'));

	if (!seedArg) {
		console.error('Usage: node collect.mjs <seed.csv> [--dry-run]');
		console.error('Example: node collect.mjs seeds/bristol-estate-agents.csv');
		process.exit(1);
	}

	const seedPath = isAbsolute(seedArg) ? seedArg : resolve(process.cwd(), seedArg);
	const indexSlug = indexSlugFromSeed(seedPath);
	const outDir = join(DATA_ROOT, indexSlug);

	const config = loadConfig();
	let indexCfg, sector, engine;
	try {
		({ index: indexCfg, sector, engine } = resolveIndex(indexSlug, config));
	} catch (e) {
		console.error(e.message);
		process.exit(1);
	}

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

	const keywords = buildKeywords(indexSlug, config);
	const prompts = buildPrompts(indexSlug, config);

	// Cost forecast from the measured unit prices, before spending anything.
	const SERP_UNIT = { 10: 0.0006, 20: 0.00105, 100: 0.00465 };
	const AI_UNIT = { perplexity: 0.005912, gemini: 0.067472, chat_gpt: 0.10205 };
	const LISTING_UNIT = 0.00048; // priced per result returned
	const forecast =
		keywords.length * (SERP_UNIT[engine.serp.depth] ?? 0.00465) +
		prompts.length * (AI_UNIT[engine.ai.engine] ?? 0.00591) +
		(indexCfg.coordinate ? (engine.local.listingsLimit || 100) * LISTING_UNIT : 0) +
		businesses.length * (engine.local.profileFallback ? 0.0015 : 0) +
		// targeted title lookups only run for the residual, and only when the
		// sweep is configured; assume a third of businesses fall through
		(indexCfg.coordinate && sector.dfsCategories?.length ? Math.ceil(businesses.length / 3) * 0.0127 : 0) +
		(engine.intent?.enabled ? 0.0134 : 0) +
		(engine.geoGrid?.enabled && indexCfg.coordinate && sector.geoKeyword
			? Math.pow(engine.geoGrid.size || 3, 2) * 0.0035 : 0) +
		businesses.length * (engine.local.reviewVelocity ? 0.0015 : 0);

	console.log(`Index:      ${indexSlug}`);
	console.log(`Sector:     ${sector.label} — ${indexCfg.town} (${indexCfg.locationName})`);
	console.log(`Businesses: ${businesses.length}`);
	console.log(`Keywords:   ${keywords.length} (shared across the index)`);
	console.log(`AI prompts: ${prompts.length} × ${engine.ai.engine}/${engine.ai.model} (shared)`);
	console.log(`PageSpeed:  ${process.env.PAGESPEED_API_KEY ? 'keyed' : 'keyless low-rate mode'}`);
	console.log(`Forecast:   $${forecast.toFixed(4)} (£${(forecast / (engine.budget?.fxGbpUsd || 1.36)).toFixed(4)})`);
	console.log(`Output:     ${outDir}\n`);

	if (dryRun) {
		console.log('Keyword basket:');
		keywords.forEach((k, i) => console.log(`  ${String(i + 1).padStart(2)}. ${k}`));
		console.log('\nAI prompts:');
		prompts.forEach((p, i) => console.log(`  ${String(i + 1).padStart(2)}. ${p}`));
		console.log('\n--dry-run: nothing was fetched and nothing was charged.');
		return;
	}

	const runStartedAt = Date.now();
	const before = await balance();
	console.log(`Balance:    ${redactBalance(before.balance)}\n`);

	/* ---- Phase 1: shared per-index signals (bought once) ---- */

	const modeLabel = engine.serp.mode === 'queue' ? 'standard queue' : 'live';
	console.log(`[serp] SERP — ${keywords.length} keyword(s), ${modeLabel}, depth ${engine.serp.depth}`);

	await mkdir(outDir, { recursive: true });

	/* A posted SERP task is already charged and stays retrievable for days, so
	   the ids are persisted before harvesting. If a previous run posted this
	   exact basket and died before collecting, resume it rather than paying
	   again. */
	const taskStorePath = join(outDir, '_serp-tasks.json');
	const idToKeyword = new Map();

	try {
		const store = JSON.parse(await readFile(taskStorePath, 'utf8'));
		if (store.harvested === false && store.tasks) {
			// Reuse only the tasks whose keyword is still in the current basket —
			// an edited basket must not resurrect keywords that were dropped.
			const wanted = new Set(keywords);
			for (const [id, kw] of Object.entries(store.tasks)) {
				if (wanted.has(kw)) idToKeyword.set(id, kw);
			}
			if (idToKeyword.size) {
				const age = Math.round((Date.now() - Date.parse(store.postedAt)) / 60000);
				console.log(`    resuming ${idToKeyword.size} task(s) posted ${age} min ago — not re-posting, not re-charging`);
			}
		}
	} catch {
		// no store, or unreadable — everything gets posted below
	}

	// Post whatever the store did not already cover. On a clean run that is the
	// whole basket; on a resume it is only the gap.
	const covered = new Set(idToKeyword.values());
	const toPost = keywords.filter((k) => !covered.has(k));

	if (toPost.length) {
		const fresh = await serpPost(
			toPost.map((keyword) => ({
				keyword,
				location_name: indexCfg.locationName,
				language_code: engine.serp.languageCode,
				device: engine.serp.device,
				depth: engine.serp.depth,
			})),
			{ log: (m) => console.log(m) }
		);
		for (const [id, kw] of fresh) idToKeyword.set(id, kw);
		console.log(`    posted ${fresh.size} new task(s)${covered.size ? ` (topping up the resumed ${covered.size})` : ''}`);
	}

	const writeStore = (harvested) => writeFile(taskStorePath, JSON.stringify({
		postedAt: new Date().toISOString(),
		keywords,
		harvested,
		tasks: Object.fromEntries(idToKeyword),
	}, null, 2) + '\n');

	// Persist ids BEFORE harvesting: they are charged the moment they are posted.
	await writeStore(false);

	const serpByKeyword = await serpHarvest(idToKeyword, { log: (m) => console.log(m) });

	// Only mark harvested once every task has actually been collected; a partial
	// harvest must stay resumable.
	const allHarvested = keywords.every((k) => serpByKeyword.get(k));
	if (allHarvested) await writeStore(true);
	console.log(`    ${[...serpByKeyword.values()].filter(Boolean).length}/${keywords.length} keyword(s) returned\n`);

	/* ---- The wider landscape, extracted from SERPs already paid for ----

	   Every organic result and every ad in these responses is data we have
	   bought. Keeping only the seed's own positions throws away the competitive
	   set, the directory share, and — most usefully — evidence that the seed
	   itself is incomplete. This costs nothing per run. */
	let landscape = null;
	try {
		landscape = buildLandscape(serpByKeyword, businesses.map((b) => b.url));
	} catch (e) {
		console.log(`    ! landscape extraction failed: ${e.message} (SERP data is unaffected)`);
	}
	if (landscape) {
		await writeFile(
			join(outDir, '_landscape.json'),
			JSON.stringify({ index: indexSlug, collectedAt: new Date().toISOString(), ...landscape }, null, 2) + '\n'
		);

		const ls = landscape.summary;
		if (!landscape.measuredKeywords) {
			console.log('    no SERPs harvested — landscape not computed');
		} else {
			console.log(`    page-1 share: seed holds ${ls.heldBySeed}/${ls.slotsAvailable} top-10 slots (${ls.seedSharePct}%), ${ls.distinctDomains} distinct domains seen`);
			if (landscape.seedGaps.length) {
				console.log(`    ! ${landscape.seedGaps.length} untracked domain(s) rank top-10 repeatedly or place top-5 — candidates the seed is missing:`);
				landscape.seedGaps.slice(0, 6).forEach((d) =>
					console.log(`        ${d.domain} (${d.top10Slots} top-10 slot(s), best #${d.bestPosition ?? 'n/a'})`));
			}
			if (ls.paidSlotsSeen) {
				const extra = ls.paidSlotsUnresolvedDomain ? `, ${ls.paidSlotsUnresolvedDomain} with an unparseable domain` : '';
				console.log(`    ${ls.paidSlotsSeen} paid slot(s) seen from ${landscape.paidAdvertisers.length} advertiser(s)${extra}: `
					+ landscape.paidAdvertisers.slice(0, 5).map((a) => a.domain).join(', '));
			} else {
				console.log('    no paid slots served in this sample (ad inventory varies by auction — a sample, not a census)');
			}
		}
		console.log('');
	}

	console.log(`[ai]   AI presence — ${prompts.length} prompt(s) via ${engine.ai.engine}/${engine.ai.model}`);
	const aiAnswers = [];
	for (const prompt of prompts) {
		try {
			const result = await llmResponse(engine.ai.engine, prompt, { model: engine.ai.model });
			const text = llmText(result);
			aiAnswers.push({ prompt, text });
			console.log(`    ✓ ${prompt.slice(0, 62)}${prompt.length > 62 ? '…' : ''} (${text.length} chars)`);
		} catch (e) {
			aiAnswers.push({ prompt, text: '' });
			console.log(`    ! ${prompt.slice(0, 62)} — ${e.message}`);
		}
	}
	console.log('');

	/* ---- Phase 2: per-business Google Business Profile, batched ---- */

	console.log(`[local] Local presence — ${businesses.length} business(es)`);

	const gbpKeyFor = (biz) => biz.gbp_query || `${biz.name} ${indexCfg.town}`;

	/* 3a. One listings sweep for the whole index. Primary source: it aggregates
	   a firm's branches and resolves the multi-branch chains that a per-business
	   profile lookup cannot. */
	const listingMatches = new Map();
	if (indexCfg.coordinate && sector.dfsCategories?.length) {
		const sweep = await businessListings(sector.dfsCategories, indexCfg.coordinate, {
			limit: engine.local.listingsLimit || 100,
		});
		console.log(`    sweep: ${sweep.returned} listing(s) of ${sweep.totalCount} in ${indexCfg.coordinate.split(',')[2]}km`);
		for (const biz of businesses) {
			const m = matchListings(sweep.items, { name: biz.name, url: biz.url });
			if (m.items.length) listingMatches.set(gbpKeyFor(biz), m);
		}
		console.log(`    matched ${listingMatches.size}/${businesses.length} via listings sweep`);
	} else {
		console.log('    ! no coordinate or dfsCategories configured — skipping sweep');
	}

	/* 3b. Fall back to a direct profile lookup for whatever the sweep missed.
	   The two sources fail on different firms, so the union beats either. */
	let gbpByQuery = new Map();
	const unmatched = businesses.filter((b) => !listingMatches.has(gbpKeyFor(b)));
	if (engine.local.profileFallback && unmatched.length) {
		console.log(`    fallback: direct lookup for ${unmatched.length} unmatched`);
		gbpByQuery = await myBusinessInfoBatch(
			unmatched.map((biz) => ({
				key: gbpKeyFor(biz),
				keyword: gbpKeyFor(biz),
				location_name: indexCfg.locationName,
			})),
			{ log: (m) => console.log(m) }
		);
		console.log(`    fallback resolved ${[...gbpByQuery.values()].filter(Boolean).length}/${unmatched.length}`);
	}

	/* 3c. Targeted title lookup for whatever the sweep and the direct lookup
	   both missed. The sweep truncates (100 of 535 available for Bristol), so a
	   firm can be absent from it purely by truncation. This tier is the most
	   expensive per business (~$0.0127 flat) which is why it runs last, on the
	   smallest residual. */
	const targetedErrors = new Map();
	const stillMissing = businesses.filter((b) => {
		const k = gbpKeyFor(b);
		return !listingMatches.has(k) && !gbpByQuery.get(k);
	});

	if (stillMissing.length && indexCfg.coordinate && sector.dfsCategories?.length) {
		console.log(`    targeted: title lookup for ${stillMissing.length} still unmatched`);
		for (const biz of stillMissing) {
			const needle = searchNeedle(biz.name);
			if (!needle) {
				console.log(`        ${biz.name}: no distinctive name to search on — skipped`);
				continue;
			}
			try {
				const { items, totalCount } = await businessListingsByTitle(needle, indexCfg.coordinate);
				if (totalCount !== null && totalCount > items.length) {
					console.log(`        · ${biz.name}: ${items.length} of ${totalCount} candidates retrieved for "${needle}"`);
				}
				const m = matchTargeted(items, { name: biz.name, url: biz.url }, sector.dfsCategories);
				if (m.items.length) {
					listingMatches.set(gbpKeyFor(biz), m);
					const note = m.matchedBy === 'name-category'
						? ` (matched on name + category — its profile lists ${m.items[0].domain || 'no website'}, not ${biz.url})`
						: '';
					console.log(`        ✓ ${biz.name} — ${m.items.length} listing(s)${note}`);
				} else if (m.ambiguous) {
					targetedErrors.set(gbpKeyFor(biz), `ambiguous: "${needle}" matched several unrelated businesses (${m.ambiguous.join(', ')})`);
					console.log(`        ? ${biz.name} — ambiguous, "${needle}" matched ${m.ambiguous.length} unrelated domains; not attributed`);
				} else {
					console.log(`        ✗ ${biz.name} — no listing found for "${needle}"`);
				}
			} catch (e) {
				/* A lookup that ERRORED is not a firm with no profile. Recorded so
				   the published record cannot assert an absence we never tested. */
				targetedErrors.set(gbpKeyFor(biz), `targeted lookup failed: ${e.message}`);
				console.log(`        ! ${biz.name} — targeted lookup failed: ${e.message}`);
			}
		}
	}

	const foundCount = businesses.filter((b) => {
		const k = gbpKeyFor(b);
		return listingMatches.has(k) || gbpByQuery.get(k);
	}).length;
	console.log(`    LOCAL PRESENCE FOUND: ${foundCount}/${businesses.length}`);

	/* 3d. Reviews, keyed by place_id wherever one was resolved. */
	let reviewsByQuery = new Map();
	if (engine.local.reviewVelocity) {
		const reviewQueries = businesses.map((biz) => {
			const key = gbpKeyFor(biz);
			const m = listingMatches.get(key);
			const placeId = m?.items?.[0]?.place_id
				|| gbpByQuery.get(key)?.place_id
				|| null;
			return { key, place_id: placeId, keyword: key, location_name: indexCfg.locationName };
		});
		reviewsByQuery = await reviewsBatch(reviewQueries, {
			depth: engine.local.reviewDepth,
			log: (m) => console.log(m),
		});
		const viaPlaceId = reviewQueries.filter((q) => q.place_id).length;
		console.log(`    ${[...reviewsByQuery.values()].filter(Boolean).length}/${businesses.length} review set(s) (${viaPlaceId} via place_id)`);
	}
	console.log('');

	/* ---- Phase 4: index-level context (intent + geo grid) ----

	   Both are per-index, not per-business, and both are cheap. They answer
	   questions the pillar scores cannot: what the basket is actually asking,
	   and where in the city a firm can be found at all. */

	if (engine.intent?.enabled) {
		console.log(`[intent] Search intent — ${keywords.length} keyword(s)`);
		try {
			const items = await searchIntent(keywords);
			const mix = {};
			items.forEach((i) => { if (i.intent) mix[i.intent] = (mix[i.intent] || 0) + 1; });
			await writeFile(join(outDir, '_intent.json'),
				JSON.stringify({ index: indexSlug, collectedAt: new Date().toISOString(), mix, keywords: items }, null, 2) + '\n');
			const summary = Object.entries(mix).sort((a, b) => b[1] - a[1])
				.map(([k, n]) => `${k} ${n}`).join(', ');
			console.log(`    ${items.length} classified: ${summary || 'none'}`);
			if (Object.keys(mix).length === 1 && items.length > 1) {
				console.log(`    ! the whole basket is "${Object.keys(mix)[0]}" intent — the Visibility pillar measures one slice of the funnel`);
			}
		} catch (e) {
			console.log(`    ! intent classification failed: ${e.message}`);
		}
		console.log('');
	}

	if (engine.geoGrid?.enabled && indexCfg.coordinate && sector.geoKeyword) {
		const [lat, lng] = indexCfg.coordinate.split(',').map(Number);
		const n = engine.geoGrid.size || 3;
		/* One default, used for the grid, the log and the record alike. Applying
		   it only at buildGrid() left the sidecar with an undefined radiusKm,
		   which JSON.stringify drops and the page then rendered as "NaNkm". */
		const radiusKm = engine.geoGrid.radiusKm || 6;
		const pts = buildGrid(lat, lng, radiusKm, n);
		console.log(`[geo] Local-pack grid — "${sector.geoKeyword}" from ${pts.length} points (${n}x${n}, ${radiusKm}km radius)`);
		try {
			const grid = await localPackGrid(sector.geoKeyword, pts, {
				depth: engine.geoGrid.depth || 20,
				radius: engine.geoGrid.radiusM || 1000,
				languageCode: engine.serp.languageCode,
				device: engine.serp.device,
				log: (m) => console.log(m),
			});
			await writeFile(join(outDir, '_geogrid.json'),
				JSON.stringify({
					index: indexSlug, collectedAt: new Date().toISOString(),
					keyword: sector.geoKeyword, size: n, radiusKm,
					centre: { lat, lng }, points: grid,
				}, null, 2) + '\n');
			const ok = grid.filter((g) => g.pack).length;
			const distinct = new Set(grid.flatMap((g) => (g.pack || []).map((p) => p.title))).size;
			console.log(`    ${ok}/${pts.length} points returned a 3-pack, ${distinct} distinct businesses across the grid`);
		} catch (e) {
			console.log(`    ! geo grid failed: ${e.message}`);
		}
		console.log('');
	}

	const shared = { sector, keywords, serpByKeyword, aiAnswers, listingMatches, gbpByQuery, reviewsByQuery, gbpKeyFor, targetedErrors, town: indexCfg.town ?? null, coordinate: indexCfg.coordinate ?? null };

	/* ---- Phase 3: per-business assembly ---- */

	let ok = 0;
	for (const biz of businesses) {
		try {
			const record = await collectBusiness(biz, indexSlug, shared, engine);
			const file = join(outDir, `${record.slug}.json`);
			await writeFile(file, JSON.stringify(record, null, 2) + '\n');
			const errs = record.errors.length ? ` (${record.errors.length} signal error(s))` : '';
			const vis = record.pillars.visibility;
			const rank = vis?.rankedKeywords !== null && vis?.basketSize
				? ` [${vis.rankedKeywords}/${vis.basketSize} kw, AI ${record.pillars.ai?.citedQueryCount ?? '-'}/${record.pillars.ai?.basketSize ?? '-'}]`
				: '';
			console.log(`  ✓ ${biz.name} -> ${record.slug}.json${rank}${errs}`);
			ok++;
		} catch (e) {
			// last-resort guard: one business never aborts the run
			console.error(`  ✗ ${biz.name} — FAILED: ${e?.message || e}`);
		}
	}

	/* ---- Cost ledger ---- */

	const after = await balance();

	/* Reconcile against DataForSEO's per-task billing record rather than the
	   balance delta. The delta is NOT this run's spend — a concurrent run, or a
	   task posted by an earlier crashed run, settles inside the same window.
	   That is exactly how a $0.084 run once appeared to cost $1.53. The delta is
	   still recorded, clearly labelled as "not attributable to this run". */
	const reconciled = await spendSince(runStartedAt, { log: (m) => console.log(m) });
	const fxRate = engine.budget?.fxGbpUsd || 1.36;

	const costRecord = {
		index: indexSlug,
		collectedAt: new Date().toISOString(),
		businesses: businesses.length,
		keywords: keywords.length,
		prompts: prompts.length,

		forecastUsd: Number(forecast.toFixed(5)),
		ledgerUsd: Number(ledger.total.toFixed(5)),
		ledgerGbp: Number((ledger.total / fxRate).toFixed(5)),

		/* Per-task truth for the APIs that expose id_list. */
		reconciled: {
			window: { from: reconciled.from, to: reconciled.to },
			byApi: reconciled.byApi,
			attributedUsd: reconciled.attributed,
			note: 'serp + business_data only — ai_optimization exposes no id_list, '
				+ 'so AI spend is from the in-process ledger and is unverified.',
		},

		/* Recorded for completeness, NOT as this run's cost. */
		accountBalance: {
			before: before.balance,
			after: after.balance,
			deltaUsd: before.balance !== null && after.balance !== null
				? Number((before.balance - after.balance).toFixed(5))
				: null,
			note: 'Includes any concurrent or previously-posted task settling in '
				+ 'this window. Not attributable to this run — use reconciled/ledger.',
		},

		breakdown: ledger.entries.map((e) => ({
			label: e.label,
			calls: e.calls,
			cost: Number(e.cost.toFixed(5)),
		})),
	};
	await writeFile(join(outDir, '_cost.json'), JSON.stringify(costRecord, null, 2) + '\n');

	console.log(`\nDone. Wrote ${ok}/${businesses.length} business records to ${outDir}`);
	console.log(`\nCost this run:`);
	console.log(ledger.report());
	console.log(`\n    forecast   $${forecast.toFixed(5)}`);
	console.log(`    ledger     $${ledger.total.toFixed(5)} (£${(ledger.total / fxRate).toFixed(4)})`);
	console.log(`    reconciled $${reconciled.attributed.toFixed(5)} (serp + business_data, per-task via id_list)`);
	/* The delta is spend, not the balance, so it stays — it is the number that
	   makes the cost claims auditable. The absolute figures do not. */
	const delta = (before.balance ?? 0) - (after.balance ?? 0);
	console.log(`    balance moved $${delta.toFixed(5)} — includes anything else billing in this window, not just this run`);
	console.log('\nNext: node score.mjs ' + indexSlug);
}

/* Only run when executed directly. collectContent is imported by
   backfill-content.mjs, and an unguarded call here made that import run a whole
   collection and exit with a usage message. */
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((e) => {
		console.error(e);
		process.exit(1);
	});
}
