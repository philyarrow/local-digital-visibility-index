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
