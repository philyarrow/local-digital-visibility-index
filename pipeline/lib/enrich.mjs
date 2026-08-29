/* enrich.mjs — third-party sources that make a published score harder to argue with.
 *
 * CrUX (Chrome UX Report)
 *   The Speed pillar is PageSpeed lab data: a synthetic run on Google's
 *   hardware. Any firm can reasonably say "that isn't what our customers
 *   experience". CrUX is the field data — real Chrome users on real devices,
 *   aggregated over 28 days. Publishing both turns the heaviest-weighted
 *   pillar (20%) from contestable to observed. Free; needs the Chrome UX
 *   Report API enabled on a Google Cloud key.
 *
 * Companies House
 *   The strongest objection to any league table is "you are comparing a
 *   three-person firm with a fifty-person one". Company age, status and SIC
 *   code let the index segment and normalise instead of hand-waving, and tie
 *   each business to an official registry identifier rather than a name we
 *   matched on. Free; needs a Companies House API key.
 *
 * Both degrade to nulls without a key, and a null is excluded from scoring
 * rather than counted as zero — the same rule the rest of the pipeline follows.
 */

const CRUX_ENDPOINT = 'https://chromeuxreport.googleapis.com/v1/records:queryRecord';
const CH_API = 'https://api.company-information.service.gov.uk';

/* The callback must consume the body INSIDE the timeout. Returning the
   Response and reading .json() afterwards disarmed the abort at headers, so a
   server that sent headers and then stalled hung collectBusiness forever — and
   with it the whole matrix job, burning its 330-minute budget and losing the
   run's DataForSEO spend. */
async function withTimeout(fn, ms) {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), ms);
	try { return await fn(ctrl.signal); }
	finally { clearTimeout(t); }
}

/* ---------------------------------------------------------------- CrUX ---- */

/* Thresholds are Google's own "good" boundaries, kept here so the score can be
   read without a second source. INP replaced FID as the responsiveness metric. */
export const CWV_GOOD = { lcp: 2500, inp: 200, cls: 0.1 };

export async function collectCrux(url, { key = process.env.PAGESPEED_API_KEY, formFactor = 'PHONE' } = {}) {
	const out = {
		source: 'Chrome UX Report (field data, 28-day p75)',
		available: null,      // null = not attempted; false = no data for this origin
		formFactor,
		lcpMs: null, inpMs: null, cls: null,
		lcpGood: null, inpGood: null, clsGood: null,
		passesCwv: null,
		error: null,
	};
	if (!key) { out.error = 'no API key'; return out; }

	let origin;
	try { origin = new URL(url).origin; } catch { out.error = 'invalid URL'; return out; }

	try {
		const res = await withTimeout(async (signal) => {
			const r = await fetch(`${CRUX_ENDPOINT}?key=${encodeURIComponent(key)}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ origin, formFactor }),
				signal,
			});
			return { status: r.status, ok: r.ok, text: await r.text() };
		}, 20000);

		if (res.status === 404) { out.available = false; return out; } // origin below CrUX threshold
		if (!res.ok) {
			out.error = `CrUX HTTP ${res.status}${/blocked/i.test(res.text) ? ' (API not enabled on this key)' : ''}`;
			return out;
		}

		const m = JSON.parse(res.text)?.record?.metrics || {};
		const p75 = (k) => {
			const v = m[k]?.percentiles?.p75;
			return v === undefined ? null : Number(v);
		};
		out.lcpMs = p75('largest_contentful_paint');
		out.inpMs = p75('interaction_to_next_paint');
		out.cls = p75('cumulative_layout_shift');
		out.available = out.lcpMs !== null || out.inpMs !== null || out.cls !== null;

		if (out.lcpMs !== null) out.lcpGood = out.lcpMs <= CWV_GOOD.lcp;
		if (out.inpMs !== null) out.inpGood = out.inpMs <= CWV_GOOD.inp;
		if (out.cls !== null) out.clsGood = out.cls <= CWV_GOOD.cls;

		/* Google's own definition: all three available metrics at "good". A
		   missing metric is not counted as a pass. */
		const flags = [out.lcpGood, out.inpGood, out.clsGood].filter((v) => typeof v === 'boolean');
		out.passesCwv = flags.length ? flags.every(Boolean) : null;
	} catch (e) {
		out.error = e?.name === 'AbortError' ? 'CrUX timeout' : String(e?.message || e);
	}
	return out;
}

/* ------------------------------------------------------ Companies House ---- */

const chAuth = (key) => 'Basic ' + Buffer.from(`${key}:`).toString('base64');

/* Name matching against a public register is where a naive implementation
   invents facts. Two guards: the candidate must be an active company, and its
   name must match on a normalised comparison rather than a substring — "Ocean"
   must not match "Ocean Finance Ltd" in a different sector. Anything less
   confident returns null and the pillar excludes it. */
function normaliseCo(s) {
	return String(s || '')
		.toLowerCase()
		.replace(/&/g, ' and ')
		.replace(/\b(limited|ltd|llp|plc|company|co)\b/g, ' ')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

export async function collectCompaniesHouse(name, { key = process.env.COMPANIES_HOUSE_KEY, postcode = null, town = null } = {}) {
	const out = {
		source: 'Companies House public register',
		matched: null,
		companyNumber: null,
		companyName: null,
		companyStatus: null,
		incorporatedOn: null,
		ageYears: null,
		sicCodes: null,
		matchConfidence: null,
		registeredAddress: null,
		error: null,
	};
	if (!key) { out.error = 'no API key'; return out; }
	if (!name) { out.error = 'no name'; return out; }

	try {
		const q = encodeURIComponent(postcode ? `${name} ${postcode}` : name);
		const res = await withTimeout(async (signal) => {
			const r = await fetch(`${CH_API}/search/companies?q=${q}&items_per_page=20`, {
				headers: { Authorization: chAuth(key) },
				signal,
			});
			return { ok: r.ok, status: r.status, text: await r.text() };
		}, 20000);
		if (!res.ok) { out.error = `Companies House HTTP ${res.status}`; return out; }

		const items = JSON.parse(res.text)?.items || [];
		const want = normaliseCo(name);
		const hits = items.filter((i) => i.company_status === 'active' && normaliseCo(i.title) === want);

		if (!hits.length) { out.matched = false; return out; }

		/* AMBIGUITY IS A NON-MATCH. normaliseCo strips Ltd/LLP/PLC, so a short
		   trading name — "Ocean", "Bell", "The Grange" — collides with unrelated
		   active companies. Taking the first would publish a stranger's company
		   number, age and SIC on a firm's page under a confident-sounding label.
		   Recording no match is the honest answer; the pillar excludes it. */
		if (hits.length > 1) {
			out.matched = false;
			out.error = `ambiguous: ${hits.length} active companies share this normalised name`;
			return out;
		}
		const hit = hits[0];
		if (!hit.company_number) { out.matched = false; out.error = 'no company number on the match'; return out; }

		/* Unique is not the same as correct. Exactly one active company may
		   normalise to "Ocean" and still be a haulier in Hull rather than the
		   estate agent we are measuring. When the index tells us the town, the
		   registered address must corroborate it; without that corroboration
		   the match is recorded at lower confidence so nothing downstream can
		   present it as verified. */
		const snippet = String(hit.address_snippet || '').toLowerCase();
		const townOk = town ? snippet.includes(String(town).toLowerCase()) : null;
		if (town && !townOk) {
			out.matched = false;
			out.error = `registered address does not mention ${town}`;
			return out;
		}

		out.matched = true;
		out.matchConfidence = townOk ? 'unique-name-and-town' : 'unique-name-only';
		out.registeredAddress = hit.address_snippet || null;
		out.companyNumber = hit.company_number || null;
		out.companyName = hit.title || null;
		out.companyStatus = hit.company_status || null;
		out.incorporatedOn = hit.date_of_creation || null;
		if (out.incorporatedOn) {
			const ms = Date.now() - Date.parse(out.incorporatedOn);
			if (!Number.isNaN(ms)) out.ageYears = Number((ms / 31557600000).toFixed(1));
		}

		if (out.companyNumber) {
			const p = await withTimeout(async (signal) => {
				const r = await fetch(`${CH_API}/company/${out.companyNumber}`, {
					headers: { Authorization: chAuth(key) },
					signal,
				});
				return { ok: r.ok, text: await r.text() };
			}, 20000);
			if (p.ok) {
				const prof = JSON.parse(p.text);
				out.sicCodes = prof?.sic_codes || null;
				out.companyStatus = prof?.company_status || out.companyStatus;
			}
		}
	} catch (e) {
		out.error = e?.name === 'AbortError' ? 'Companies House timeout' : String(e?.message || e);
	}
	return out;
}

/* ------------------------------------------------- FSA hygiene ratings ---- */

/* The Food Standards Agency publishes food hygiene ratings as a genuinely open
 * API: no key, no registration, no crawl restriction. That matters because it
 * is the one official rating this project can legitimately cross-reference —
 * the professional regulators (SRA, Gas Safe, Propertymark) all disallow the
 * register endpoints their data would have to come from.
 *
 * Ratings are 0-5 in England, Wales and Northern Ireland. Scotland uses
 * Pass/Improvement Required, and non-numeric values also cover
 * AwaitingInspection, AwaitingPublication, Exempt and AwaitingRatingChange.
 * Those are recorded verbatim rather than coerced to a number.
 */

const FSA_API = 'https://api.ratings.food.gov.uk';

/* Same discipline as the Companies House matcher: a unique exact match on a
 * normalised name, corroborated by town, or no match at all. A hygiene rating
 * published against the wrong restaurant is worse than no rating. */
function normaliseVenue(s, town = null) {
	let v = String(s || '')
		.normalize('NFKD')                    // "Café René" and "Cafe Rene" must agree
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/&/g, ' and ');
	/* Trading names often carry the town as a disambiguator that the register
	   does not use: "Tim Hortons - Gloucester", "Cote Gloucester". */
	if (town) v = v.replace(new RegExp(`\\b${String(town).toLowerCase()}\\b`, 'g'), ' ');
	return v
		.replace(/\b(the|ltd|limited|restaurant|cafe|bar|pub|inn)\b/g, ' ')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

/* Great-circle distance in km. The FSA name search is national in practice —
   "Royal Oak" in a Gloucester query returned a pub in GL54, 25km away — so a
   match has to be inside the index's own radius or it is not our business. */
function distanceKm(a, b) {
	const R = 6371, rad = (d) => (d * Math.PI) / 180;
	const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(h));
}

export async function collectFsa(name, { town = null, coordinate = null } = {}) {
	const out = {
		source: 'Food Standards Agency food hygiene ratings (open data)',
		matched: null,
		fhrsId: null,
		businessName: null,
		businessType: null,
		ratingValue: null,      // string: "5" … "0", or "Pass", "Exempt", "AwaitingInspection"
		ratingNumeric: null,    // number 0-5 where the scheme is numeric, else null
		ratingDate: null,
		postcode: null,
		localAuthority: null,
		distanceKm: null,
		locatedBy: null,
		scores: null,           // { hygiene, structural, confidenceInManagement } — lower is better
		error: null,
	};
	if (!name) { out.error = 'no name'; return out; }

	try {
		/* Query with the town suffix removed. "Tim Hortons - Gloucester" and
		   "Cote Gloucester" are trading names; the register lists the venue.
		   Searching the raw string returns nothing for them. */
		const queryName = town
			? String(name).replace(new RegExp(`[\\s-]*\\b${String(town)}\\b`, 'gi'), '').trim() || String(name)
			: String(name);
		const qs = new URLSearchParams({ name: queryName, pageSize: '40' });
		if (town) qs.set('address', town);
		const res = await withTimeout(async (signal) => {
			const r = await fetch(`${FSA_API}/Establishments?${qs}`, {
				headers: { 'x-api-version': '2', accept: 'application/json' },
				signal,
			});
			return { ok: r.ok, status: r.status, text: await r.text() };
		}, 20000);
		if (!res.ok) { out.error = `FSA HTTP ${res.status}`; return out; }

		const items = JSON.parse(res.text)?.establishments || [];
		const want = normaliseVenue(name, town);
		let hits = items.filter((e) => normaliseVenue(e.BusinessName, town) === want);

		/* Distance gate before the ambiguity check, so two same-named venues in
		   different towns do not read as an ambiguous match in ours. */
		let centre = null, radiusKm = null;
		if (coordinate) {
			const [la, lo, rad] = String(coordinate).split(',').map(Number);
			if (Number.isFinite(la) && Number.isFinite(lo)) { centre = { lat: la, lon: lo }; radiusKm = Number.isFinite(rad) ? rad : 15; }
		}
		/* Two ways to corroborate location, because the FSA populates geocode for
		   only some establishments — Greek On The Docks, plainly in Gloucester,
		   has latitude and longitude both null. Rejecting those outright threw
		   away correct matches; accepting them blindly is how a Cotswold pub
		   ends up on a Gloucester scorecard. LocalAuthorityName is the reliable
		   second signal: Gloucester City, Cotswold, Bristol. */
		const townKey = town ? String(town).toLowerCase() : null;
		const locatedBy = new Map();
		if (centre || townKey) {
			hits = hits.filter((e) => {
				const g = e.geocode || {};
				/* Number(null) is 0, not NaN, so a null geocode passed isFinite
				   and the distance was measured to lat 0 / lon 0 — the Gulf of
				   Guinea — silently rejecting every establishment the FSA has
				   not geocoded, which includes plainly-local ones. */
				const hasGeo = g.latitude != null && g.longitude != null;
				const lat = Number(g.latitude), lon = Number(g.longitude);
				if (centre && hasGeo && Number.isFinite(lat) && Number.isFinite(lon)) {
					const d = distanceKm(centre, { lat, lon });
					if (d <= radiusKm) { locatedBy.set(e, { how: 'distance', d }); return true; }
					return false;
				}
				if (townKey && String(e.LocalAuthorityName || '').toLowerCase().includes(townKey)) {
					locatedBy.set(e, { how: 'local-authority', d: null });
					return true;
				}
				return false;
			});
		}

		if (!hits.length) { out.matched = false; return out; }
		if (hits.length > 1) {
			/* A chain with several branches in one town, or two venues sharing a
			   name. Without an address to disambiguate we do not guess. */
			out.matched = false;
			out.error = `ambiguous: ${hits.length} establishments share this name in the area`;
			return out;
		}

		const e = hits[0];
		out.matched = true;
		const loc = locatedBy.get(e);
		out.locatedBy = loc?.how ?? null;
		if (loc?.d != null) out.distanceKm = Math.round(loc.d * 10) / 10;
		out.fhrsId = e.FHRSID ?? null;
		out.businessName = e.BusinessName ?? null;
		out.businessType = e.BusinessType ?? null;
		out.ratingValue = e.RatingValue != null ? String(e.RatingValue) : null;
		out.ratingNumeric = /^[0-5]$/.test(out.ratingValue || '') ? Number(out.ratingValue) : null;
		out.ratingDate = e.RatingDate ? String(e.RatingDate).slice(0, 10) : null;
		out.postcode = e.PostCode ?? null;
		out.localAuthority = e.LocalAuthorityName ?? null;
		const sc = e.scores || {};
		if (sc.Hygiene != null || sc.Structural != null || sc.ConfidenceInManagement != null) {
			out.scores = {
				hygiene: sc.Hygiene ?? null,
				structural: sc.Structural ?? null,
				confidenceInManagement: sc.ConfidenceInManagement ?? null,
			};
		}
	} catch (err) {
		out.error = err?.name === 'AbortError' ? 'FSA timeout' : String(err?.message || err);
	}
	return out;
}
