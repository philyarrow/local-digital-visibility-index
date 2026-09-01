/* Stable business identity across runs.
 *
 * Everything downstream of this file — quarter-on-quarter deltas, movers and
 * fallers, score-change email to a claimed business — is only as trustworthy as
 * the answer to "is this the same firm as last quarter?". Get it wrong and the
 * failure is silent: a renamed firm becomes one exit plus one entry, its history
 * is severed, and nothing throws.
 *
 * THE RULE: never key on business name. Names change ("Saunders Estate Agents"
 * -> "Saunders"), and a name-keyed diff turns an ordinary rebrand into a
 * fabricated departure. The one place a name is allowed anywhere near identity
 * is the hand-maintained map in config/business-ids.json, where a person has
 * written the decision down and can be held to it.
 *
 * THE PRECEDENCE, highest first:
 *   1. place_id  Google's own identifier. Survives renames, redesigns and
 *                domain moves. Present on 1151 of 1156 businesses as of
 *                Q3-2026 — but see the warning below.
 *   2. domain    Registrable domain from the business URL, via
 *                registrableDomain() in match.mjs (which already handles
 *                co.uk and friends). Survives a rename; does not survive a
 *                domain move.
 *   3. manual    A hand-assigned stable slug from config/business-ids.json,
 *                for the handful that resolve to neither.
 *
 * WHY THIS RETURNS EVERY KEY, NOT JUST THE BEST ONE
 *
 * The obvious design — resolve each business to one id and match ids — is
 * broken by this project's own history, and quietly.
 *
 * The data/<index>/history/2026-08.json files have no localMatch object at all;
 * place_id first appears in the 2026-09 measurements. Resolve each side to its
 * single best id and August yields domain ids while September yields place_id
 * ids, so NOTHING matches: bristol-estate-agents diffs to 18 entries and 18
 * exits on a cohort where all 18 firms are plainly the same. The diff would
 * report a total collapse and rebuild of the Bristol estate agency market.
 *
 * So a business resolves to an identity carrying ALL the keys available for it,
 * and diffRuns matches on the strongest key the two runs SHARE. August's domain
 * and September's domain agree, and the pair matches on domain even though one
 * side could also have offered a place_id.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { registrableDomain } from './match.mjs';
import { slugify } from './common.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const MANUAL_IDS_PATH = join(HERE, '..', 'config', 'business-ids.json');

/* Ordered strongest-first. diffRuns walks this to pick the best shared key. */
export const ID_SOURCES = ['place_id', 'domain', 'manual'];

/* Is this actually a domain? Labels of [a-z0-9-] not starting or ending in a
   hyphen, at least one dot, and an alphabetic TLD of two or more characters. */
const DOMAIN_SHAPE = /^(?!-)[a-z0-9-]+(?<!-)(\.(?!-)[a-z0-9-]+(?<!-))*\.[a-z]{2,}$/;

/* The registrable domain, normalised: lowercased, protocol and www. stripped,
   path and query discarded.
   Delegates to match.mjs rather than reimplementing — that function already
   knows that bathvetgroup.co.uk is a registrable domain and vetgroup.co.uk is
   not, and a second copy of public-suffix handling would drift from the first.
 *
 * But it is WRAPPED, not called bare, for two reasons its own callers never hit.
 * registrableDomain treats any string without '://' as a bare hostname and
 * returns it unexamined, so 'not a url' comes back as the domain 'not a url';
 * and it calls .includes() on its argument, so a non-string throws. match.mjs
 * feeds it SERP fields that are already hostnames, so neither matters there.
 * Here the input is a `url` field from a snapshot, and either would put junk
 * into an identity key — where it would match nothing, forever, silently. The
 * guard belongs on this side: match.mjs is on the scoring path and changing it
 * is out of scope. */
export function normaliseDomain(urlOrHost) {
	if (typeof urlOrHost !== 'string' || !urlOrHost.trim()) return null;
	const domain = registrableDomain(urlOrHost);
	return domain && DOMAIN_SHAPE.test(domain) ? domain : null;
}

/* A place_id from either shape this repo stores.
     published snapshot  businesses[].localMatch.placeId
     raw pipeline record pillars.local.placeId
   Both are read because backfill walks published snapshots while a live
   ingest walks raw records, and the brief requires one identity function for
   every ingest path rather than one per caller. */
export function placeIdOf(business) {
	const fromSnapshot = business?.localMatch?.placeId;
	const fromRaw = business?.pillars?.local?.placeId;
	const id = fromSnapshot || fromRaw || null;
	return typeof id === 'string' && id.trim() ? id.trim() : null;
}

/* The lookup key for the manual map: "<index>/<name-slug>".
   This is the ONLY name-derived string in the identity path, and it is a
   lookup into a file a human wrote — never an identity in its own right. It
   matches the slug already used for the page URL, so an operator reading
   /indices/bath-vets/kelston-vets/ knows exactly what to write in the map. */
export function manualKey(indexSlug, name) {
	/* Both must be real strings. slugify() calls .toLowerCase() on its argument,
	   so a record whose `name` arrived as an object or a number would throw here
	   — and this function runs over every business in every backfilled run, where
	   one malformed record must not abort the other 1,155. */
	if (typeof indexSlug !== 'string' || !indexSlug) return null;
	if (typeof name !== 'string' || !name.trim()) return null;
	return `${indexSlug}/${slugify(name)}`;
}

/* Load the hand-maintained map. Returns { byKey, byDomain } lookup tables.
   Absent file is not an error: the map is an escape hatch, and most indices
   never need one. */
export async function loadManualIds(path = MANUAL_IDS_PATH) {
	let raw;
	try {
		raw = await readFile(path, 'utf8');
	} catch (e) {
		if (e?.code === 'ENOENT') return { byKey: new Map(), byDomain: new Map(), entries: {} };
		throw e;
	}
	const parsed = JSON.parse(raw);
	return indexManualIds(parsed.entries || {});
}

/* Build lookup tables from the map's entries. Separated from the file read so
   it can be unit tested without touching disk. */
export function indexManualIds(entries) {
	const byKey = new Map();
	const byDomain = new Map();
	for (const [id, entry] of Object.entries(entries)) {
		if (!entry || typeof entry !== 'object') continue;
		for (const alias of entry.aliases || []) {
			byKey.set(String(alias), id);
		}
		for (const url of entry.urls || []) {
			const d = normaliseDomain(url);
			if (d) byDomain.set(d, id);
		}
	}
	return { byKey, byDomain, entries };
}

/* Resolve one business to a stable identity.
 *
 *   business    a published-snapshot record or a raw pipeline record
 *   indexSlug   the cell it belongs to; scopes the manual map
 *   manualIds   the tables from loadManualIds/indexManualIds
 *
 * Returns:
 *   id        the strongest available key, as the brief's snapshot schema wants
 *   idSource  which one that was: 'place_id' | 'domain' | 'manual' | null
 *   keys      EVERY key available, for cross-source matching (see file header)
 *   resolved  false when no key at all could be derived
 *   reason    why, when it could not
 *
 * Never throws on a malformed record. A business that cannot be identified is
 * reported as unresolved and listed by the caller — it must never fall through
 * to a name, and it must never be silently dropped.
 */
export function resolveBusinessId(business, { indexSlug = null, manualIds = null } = {}) {
	const tables = manualIds || { byKey: new Map(), byDomain: new Map() };

	const placeId = placeIdOf(business);
	const domain = normaliseDomain(business?.url);
	const key = manualKey(indexSlug, business?.name);

	/* Manual wins its slot by either route: an alias a person wrote for this
	   index+name, or a URL they pinned. The URL route is what survives a
	   rename — the alias for the old name stops matching, the pinned domain
	   does not. */
	const manual = (key && tables.byKey.get(key)) || (domain && tables.byDomain.get(domain)) || null;

	const keys = {
		place_id: placeId,
		domain: domain,
		manual: manual,
	};

	for (const source of ID_SOURCES) {
		if (keys[source]) {
			return { id: keys[source], idSource: source, keys, resolved: true, reason: null };
		}
	}

	return {
		id: null,
		idSource: null,
		keys,
		resolved: false,
		reason: business?.url
			? 'url present but no registrable domain could be parsed from it, and no place_id or manual entry'
			: 'no place_id, no url to derive a domain from, and no manual entry',
	};
}

/* Resolve a whole cohort, and surface the two things a caller must not ignore:
   businesses with no identity at all, and identities claimed by more than one
   business in the same run.
 *
 * The duplicate check matters because a shared key is not hypothetical: two
 * branches of one chain seeded as separate businesses share a domain, and
 * matching them by it would swap their histories at random from quarter to
 * quarter. There are none in Q3-2026 — verified across all 32 indices — but
 * "none today" is not a guarantee, and the failure would be invisible. */
export function resolveCohort(businesses, { indexSlug = null, manualIds = null } = {}) {
	const resolved = [];
	const unresolved = [];
	const seen = { place_id: new Map(), domain: new Map(), manual: new Map() };

	for (const business of businesses || []) {
		const identity = resolveBusinessId(business, { indexSlug, manualIds });
		const row = { business, identity };
		if (identity.resolved) resolved.push(row);
		else unresolved.push({ name: business?.name ?? null, url: business?.url ?? null, reason: identity.reason });

		for (const source of ID_SOURCES) {
			const k = identity.keys[source];
			if (!k) continue;
			if (!seen[source].has(k)) seen[source].set(k, []);
			seen[source].get(k).push(business?.name ?? null);
		}
	}

	const ambiguous = [];
	for (const source of ID_SOURCES) {
		for (const [k, names] of seen[source]) {
			if (names.length > 1) ambiguous.push({ source, key: k, names });
		}
	}

	return { resolved, unresolved, ambiguous };
}
