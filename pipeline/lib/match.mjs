/* Matching a seed business against SERP items, local-pack entries and AI answer
   text.

   This is the part of the pipeline most likely to be quietly wrong, because a
   false positive inflates a score rather than throwing. Two rules keep it
   honest:
     1. Domain matching is exact on the registrable domain - never a substring.
        "allenandharris.co.uk" must not match "notallenandharris.co.uk".
     2. Name matching strips the sector words that every firm in an index shares
        ("estate agents", "solicitors", "ltd") before comparing, so what is left
        is the distinctive part of the name. A residual shorter than 4
        characters is treated as unmatchable rather than matched loosely.
*/

/* Public-suffix-ish handling for the UK-heavy case. Not a full PSL: enough to
   reduce host -> registrable domain for .co.uk, .org.uk, .ltd.uk etc. */
const MULTI_PART_TLDS = new Set([
	'co.uk', 'org.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk', 'ac.uk', 'gov.uk',
	'com.au', 'co.nz', 'co.za', 'com.br',
]);

export function hostFromUrl(url) {
	try {
		return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
	} catch {
		return null;
	}
}

export function registrableDomain(hostOrUrl) {
	if (!hostOrUrl) return null;
	let host = hostOrUrl.includes('://') ? hostFromUrl(hostOrUrl) : String(hostOrUrl).toLowerCase().replace(/^www\./, '');
	if (!host) return null;
	host = host.replace(/\.$/, '');
	const parts = host.split('.');
	if (parts.length <= 2) return host;
	const lastTwo = parts.slice(-2).join('.');
	if (MULTI_PART_TLDS.has(lastTwo)) return parts.slice(-3).join('.');
	return lastTwo;
}

/* Exact registrable-domain equality. */
export function domainsMatch(a, b) {
	const da = registrableDomain(a);
	const db = registrableDomain(b);
	return Boolean(da && db && da === db);
}

/* Words that appear in most firms' names within a sector index and therefore
   carry no distinguishing signal.

   Connectives ('and', 'of', 'the') are deliberately NOT here. normaliseName
   expands '&' to 'and', so stripping 'and' from the needle while the haystack
   keeps it means "Allen & Harris" can never match text containing "Allen &
   Harris" — silently zeroing the AI pillar for every firm with an ampersand in
   its name. Connectives are trimmed from the ends instead (see below). */
const GENERIC_WORDS = new Set([
	'ltd', 'limited', 'llp', 'plc', 'group', 'co', 'company',
	'estate', 'estates', 'agent', 'agents', 'letting', 'lettings', 'property', 'properties',
	'solicitor', 'solicitors', 'law', 'legal', 'firm', 'firms', 'partners', 'partnership',
	'dental', 'dentist', 'dentists', 'dentistry', 'practice', 'surgery', 'clinic',
	'construction', 'builder', 'builders', 'building', 'contractors', 'developments',
	'services', 'uk', 'bristol', 'bath', 'swindon', 'exeter', 'cheltenham', 'gloucester',
]);

export function normaliseName(s) {
	return (s || '')
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/&/g, ' and ')
		.replace(/['’`]/g, '')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

const CONNECTIVES = new Set(['and', 'of', 'the']);

/* The distinctive residue of a business name: normalised, with generic sector
   words removed and connectives trimmed from the ends only (so "Hydes of
   Bristol" -> "hydes", but "Allen & Harris" -> "allen and harris").

   Returns '' when nothing distinctive survives — a firm named only in generic
   words is unmatchable BY NAME and must be matched by domain instead. Falling
   back to the generic tokens here would match every firm in the index. */
export function distinctiveName(name) {
	const tokens = normaliseName(name).split(' ').filter(Boolean);
	const kept = tokens.filter((t) => !GENERIC_WORDS.has(t));

	while (kept.length && CONNECTIVES.has(kept[0])) kept.shift();
	while (kept.length && CONNECTIVES.has(kept[kept.length - 1])) kept.pop();

	if (!kept.length || kept.every((t) => CONNECTIVES.has(t))) return '';
	const residue = kept.join(' ');
	return residue.length >= 4 ? residue : '';
}

/* Why `text` matched this business: 'domain' (authoritative), 'name' (the
   distinctive residue appeared as a whole-word run), or null.

   Returned rather than a bare boolean so a score can be audited later — a
   name-only match on a short common-word name ("Ocean") is weaker evidence
   than a domain citation, and the record should say which one fired. */
export function matchReason(text, { name, url }) {
	if (!text) return null;
	const haystackRaw = String(text).toLowerCase();

	const domain = registrableDomain(url);
	if (domain && haystackRaw.includes(domain)) return 'domain';

	const needle = distinctiveName(name);
	if (!needle) return null;

	const haystack = normaliseName(haystackRaw);
	const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(`(^|\\s)${escaped}($|\\s)`).test(haystack) ? 'name' : null;
}

/* Does `text` name this business? */
export function textNamesBusiness(text, business) {
	return matchReason(text, business) !== null;
}

/* Find a business's organic position in one SERP result.
   Returns { position, url } or null. Uses rank_group, which counts only
   organic blocks - rank_absolute would mix in ads and PAA boxes. */
export function findOrganicPosition(serpResult, business) {
	const items = serpResult?.items || [];
	for (const item of items) {
		if (item.type !== 'organic') continue;
		if (domainsMatch(item.domain, business.url)) {
			return { position: item.rank_group ?? null, url: item.url || null };
		}
	}
	return null;
}

/* Does the business appear in the local 3-pack for this SERP result?
   Local pack items carry a title and sometimes a domain/url. */
export function inLocalPack(serpResult, business) {
	const items = serpResult?.items || [];
	for (const item of items) {
		if (item.type !== 'local_pack') continue;
		if (item.domain && domainsMatch(item.domain, business.url)) return true;
		if (item.url && domainsMatch(item.url, business.url)) return true;
		if (item.title && textNamesBusiness(item.title, business)) return true;
	}
	return false;
}

/* ---- the wider landscape ------------------------------------------------ */

/* Every organic result in a SERP, not just the seed's.

   The seed businesses are a handful of the domains on any results page. The
   rest — directories, national chains, local firms nobody put in the seed —
   are the actual competitive set, and they arrive free in a response already
   paid for. Discarding them (as this pipeline did until now) means the "share
   of page one" figure can only ever be a residual with no names behind it. */
export function extractOrganic(serpResult, limit = 20) {
	const out = [];
	for (const item of serpResult?.items || []) {
		if (item.type !== 'organic') continue;
		const domain = registrableDomain(item.domain || item.url);
		if (!domain) continue;
		out.push({ domain, position: item.rank_group ?? null, url: item.url || null });
		if (out.length >= limit) break;
	}
	return out;
}

/* Paid slots, when Google served any. Ad inventory varies by auction, device
   and time of day, so an empty array means "none served in this sample" — not
   "nobody advertises on this term". Treat it as a sample, never a census. */
export function extractPaid(serpResult) {
	const out = [];
	for (const item of serpResult?.items || []) {
		if (item.type !== 'paid') continue;
		const domain = registrableDomain(item.domain || item.url);
		out.push({
			domain: domain || null,
			position: item.rank_group ?? null,
			title: item.title || null,
			url: item.url || null,
		});
	}
	return out;
}

/* Aggregate a whole index's SERPs into a domain-level picture.

   serpByKeyword : Map<keyword, serpResult|null>
   seedUrls      : the seed businesses' urls, to mark which domains are tracked */
export function buildLandscape(serpByKeyword, seedUrls) {
	const seed = new Set(seedUrls.map(registrableDomain).filter(Boolean));
	const domains = new Map();
	const perKeyword = {};
	let measuredKeywords = 0;

	for (const [keyword, result] of serpByKeyword) {
		if (!result) continue;
		measuredKeywords++;
		const organic = extractOrganic(result, 20);
		const paid = extractPaid(result);
		perKeyword[keyword] = { organic, paid, paidCount: paid.length };

		for (const row of organic) {
			if (!domains.has(row.domain)) {
				domains.set(row.domain, {
					domain: row.domain,
					inSeed: seed.has(row.domain),
					top10Slots: 0,
					top20Slots: 0,
					bestPosition: null,
					keywords: [],
				});
			}
			const d = domains.get(row.domain);
			d.top20Slots++;
			if (row.position !== null && row.position <= 10) d.top10Slots++;
			if (d.bestPosition === null || (row.position !== null && row.position < d.bestPosition)) {
				d.bestPosition = row.position;
			}
			d.keywords.push({ keyword, position: row.position });
		}
	}

	// null bestPosition coerces to 0 in a subtraction, sorting an unranked
	// domain ahead of a genuine #1. Push nulls to the end explicitly.
	const rank = (v) => (v === null || v === undefined ? Number.POSITIVE_INFINITY : v);
	const all = [...domains.values()].sort((a, b) =>
		b.top10Slots - a.top10Slots || rank(a.bestPosition) - rank(b.bestPosition));

	const heldBySeed = all.filter((d) => d.inSeed).reduce((s, d) => s + d.top10Slots, 0);
	const heldByOthers = all.filter((d) => !d.inSeed).reduce((s, d) => s + d.top10Slots, 0);
	const available = measuredKeywords * 10;

	/* Domains ranking top-10 that the seed does not track. Some are directories
	   and always will be; others are local firms the seed simply missed, which
	   makes this the index auditing its own completeness.

	   Two ways in: repeated presence (2+ top-10 slots), or a single very strong
	   placement (top 5). Requiring repetition alone would miss a domain sitting
	   at #3 for the head term whenever the basket is small. */
	const seedGaps = all.filter((d) =>
		!d.inSeed && (d.top10Slots >= 2 || (d.bestPosition !== null && d.bestPosition <= 5)));

	/* Count ALL paid slots, including any whose domain did not parse. Counting
	   only resolvable domains meant a page full of ads could report zero and
	   print "no paid slots served" — the false-absence claim this file exists
	   to avoid. Unresolved ones are tracked separately so the total is honest. */
	const paidDomains = new Map();
	let paidSlots = 0;
	let paidUnresolved = 0;
	for (const k of Object.keys(perKeyword)) {
		for (const ad of perKeyword[k].paid) {
			paidSlots++;
			if (!ad.domain) { paidUnresolved++; continue; }
			paidDomains.set(ad.domain, (paidDomains.get(ad.domain) || 0) + 1);
		}
	}

	return {
		measuredKeywords,
		summary: {
			slotsAvailable: available,
			heldBySeed,
			heldByOthers,
			seedSharePct: available ? Number(((heldBySeed / available) * 100).toFixed(1)) : null,
			distinctDomains: all.length,
			paidSlotsSeen: paidSlots,
			paidSlotsUnresolvedDomain: paidUnresolved,
		},
		domainShare: all,
		seedGaps,
		paidAdvertisers: [...paidDomains.entries()]
			.map(([domain, slots]) => ({ domain, slots }))
			.sort((a, b) => b.slots - a.slots),
		perKeyword,
	};
}

/* Match a targeted title search back to the seed business.

   Stricter than the area sweep, because a title filter casts wide: searching
   "saunders" near Bristol returns a doctor, a music teacher and an unrelated
   solutions company, all of which contain the distinctive name. Two ways to
   accept:

     domain  — the listing's website is the seed's domain. Authoritative.
     name    — the name matches AND the listing sits in one of the sector's
               Google categories. Without the category test, "Saunders Dr P"
               is indistinguishable from "Saunders Estate Agents".

   A name-only match is reported as such so a published score can show which
   evidence it rests on. It is also how a genuine NAP inconsistency surfaces:
   Elephant Estate Agents' profile points at elephantlovesbristol.co.uk, not
   the domain in the seed. */
export function matchTargeted(items, business, sectorCategories = []) {
	const cats = new Set((sectorCategories || []).map((c) => String(c).toLowerCase()));

	const byDomain = items.filter((i) => i.domain && domainsMatch(i.domain, business.url));
	if (byDomain.length) return { items: byDomain, matchedBy: 'domain' };

	/* Categories live in `category_ids` as slugs (["real_estate_agents"]).
	   `category` is a human label ("Estate agent") and will never equal a
	   configured slug — testing it silently rejected every name-only match. */
	const byName = items.filter((i) => {
		if (!i.title || !textNamesBusiness(i.title, { name: business.name, url: null })) return false;
		if (!cats.size) return false;
		const ids = (i.category_ids || []).map((c) => String(c).toLowerCase());
		if (ids.some((c) => cats.has(c))) return true;
		// Fall back to the human label with separators normalised.
		const flat = (v) => String(v || '').toLowerCase().replace(/[\s_-]+/g, '');
		const labels = [i.category, ...(i.additional_categories || [])].map(flat);
		return [...cats].some((c) => labels.includes(flat(c)));
	});
	if (!byName.length) return { items: [], matchedBy: null };

	/* A title search casts wide enough to catch a same-sector NAMESAKE, which
	   the category test cannot see: searchNeedle("Ocean Estate Agents") is
	   "ocean", and every "Ocean …" agency in the radius is a real estate agency.
	   aggregateBranches would then sum a stranger's reviews into this firm.

	   Branches of one business share a website; unrelated namesakes do not. So
	   accept only when the candidates resolve to a single domain. If they span
	   several, the match is ambiguous and no local data is better than another
	   firm's. */
	const domains = new Set(byName.map((i) => registrableDomain(i.domain)).filter(Boolean));
	if (domains.size > 1) return { items: [], matchedBy: null, ambiguous: [...domains] };

	return { items: byName, matchedBy: 'name-category' };
}

/* A needle for an `ilike` title filter.

   NOT distinctiveName(): that expands "&" to "and", so the needle "leese and
   nagle" never matches a listing titled "Leese & Nagle" and the firm reads as
   having no Google presence at all. Joining the distinctive tokens with the
   SQL wildcard sidesteps every connective and punctuation difference —
   "leese%nagle" matches "Leese & Nagle", "Leese and Nagle" and "Leese-Nagle"
   alike.

   Capped at two tokens: more makes the pattern brittle against listings that
   append a branch or service ("Boardwalk Property Co. - Easton Office"). */
export function searchNeedle(name) {
	const residue = distinctiveName(name);
	if (!residue) return null;
	const tokens = residue.split(' ').filter((t) => t !== 'and' && t !== 'of' && t !== 'the');
	return tokens.slice(0, 2).join('%') || null;
}
