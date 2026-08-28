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
		const res = await withTimeout((signal) => fetch(`${CRUX_ENDPOINT}?key=${encodeURIComponent(key)}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ origin, formFactor }),
			signal,
		}), 20000);

		if (res.status === 404) { out.available = false; return out; } // origin below CrUX threshold
		if (!res.ok) {
			const body = await res.text().catch(() => '');
			out.error = `CrUX HTTP ${res.status}${/blocked/i.test(body) ? ' (API not enabled on this key)' : ''}`;
			return out;
		}

		const m = (await res.json())?.record?.metrics || {};
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

export async function collectCompaniesHouse(name, { key = process.env.COMPANIES_HOUSE_KEY, postcode = null } = {}) {
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
		error: null,
	};
	if (!key) { out.error = 'no API key'; return out; }
	if (!name) { out.error = 'no name'; return out; }

	try {
		const q = encodeURIComponent(postcode ? `${name} ${postcode}` : name);
		const res = await withTimeout((signal) => fetch(`${CH_API}/search/companies?q=${q}&items_per_page=20`, {
			headers: { Authorization: chAuth(key) },
			signal,
		}), 20000);
		if (!res.ok) { out.error = `Companies House HTTP ${res.status}`; return out; }

		const items = (await res.json())?.items || [];
		const want = normaliseCo(name);
		const hit = items.find((i) => i.company_status === 'active' && normaliseCo(i.title) === want);
		if (!hit) { out.matched = false; return out; }

		out.matched = true;
		out.matchConfidence = 'exact-normalised-name';
		out.companyNumber = hit.company_number || null;
		out.companyName = hit.title || null;
		out.companyStatus = hit.company_status || null;
		out.incorporatedOn = hit.date_of_creation || null;
		if (out.incorporatedOn) {
			const ms = Date.now() - Date.parse(out.incorporatedOn);
			if (!Number.isNaN(ms)) out.ageYears = Number((ms / 31557600000).toFixed(1));
		}

		if (out.companyNumber) {
			const p = await withTimeout((signal) => fetch(`${CH_API}/company/${out.companyNumber}`, {
				headers: { Authorization: chAuth(key) },
				signal,
			}), 20000);
			if (p.ok) {
				const prof = await p.json();
				out.sicCodes = prof?.sic_codes || null;
				out.companyStatus = prof?.company_status || out.companyStatus;
			}
		}
	} catch (e) {
		out.error = e?.name === 'AbortError' ? 'Companies House timeout' : String(e?.message || e);
	}
	return out;
}
