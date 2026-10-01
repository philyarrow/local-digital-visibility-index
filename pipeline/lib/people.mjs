/* Whether a site introduces the people who do the work.
 *
 * WHY THIS IS NOT JUST A LINK CHECK ANY MORE
 *
 * The team signal was one regular expression over the homepage's links:
 * /\bteam\b|our-team|meet-the-team|our-people|staff/. A practice that introduces
 * its people under "About Us", "Meet the Experts" or "Our Vets", or in a
 * section of the homepage itself, was published as "team page: no" — a
 * statement about a named business that was not true of its website. Of the
 * 1,222 businesses in the published indices, 866 were marked that way, and 589
 * of those link to an About page.
 *
 * The signal is meant to say whether a visitor can find out who they would be
 * dealing with. A link whose label we recognise is one way to learn that.
 * Reading the page is another, and this file is the second.
 *
 * WHAT COUNTS, AND WHY IT IS NARROW
 *
 * This feeds a published score, so a pattern only counts if it is hard to
 * satisfy by accident:
 *
 *   - somebody introducing themselves in the first person, with a
 *     qualification or a history close by;
 *   - a name with professional letters after it;
 *   - a heading that is a person's name, with their role directly under it.
 *
 * A bare capitalised phrase is not a person ("Our Services" is name-shaped),
 * and a name in a testimonial is not an introduction. Each match returns the
 * words it matched, which are stored as `teamEvidence` so a published "yes" can
 * be checked against the page.
 */

/* Links that lead to the people, by any of the names sites give them. The
   original five alternatives are kept exactly as they were, so nothing that
   passed before stops passing. */
const PEOPLE_LINK = new RegExp([
	String.raw`\bteam\b|our-team|meet-the-team|our-people|staff`,
	String.raw`meet[-\s]+(?:the|our)\b`,
	String.raw`\bour[-\s]+(?:vets|dentists|people|practitioners|clinicians|physios|physiotherapists|chiropractors|osteopaths|therapists|architects|solicitors|partners|experts|specialists|surgeons)\b`,
	String.raw`\bpractitioners\b|\bclinicians\b`,
].join('|'));

/* `haystack` is the lowercased anchor text and hrefs of the homepage, as
   collectContent builds it. */
export function linksToPeople(haystack) {
	return PEOPLE_LINK.test(haystack);
}

const ABOUT_LINK = /\babout\b|about-us|our-story|who-we-are/;

/* The first same-site link that reads as an About page, absolute, or null.
   Another site's "about" page tells us nothing about this business. */
export function aboutHref(rawHtml, baseUrl) {
	let base;
	try { base = new URL(baseUrl); } catch { return null; }
	for (const m of rawHtml.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
		if (!ABOUT_LINK.test(`${m[1]} ${m[2]}`.toLowerCase())) continue;
		let target;
		try { target = new URL(m[1], base); } catch { continue; }
		if (!/^https?:$/.test(target.protocol)) continue;
		if (target.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) continue;
		/* The homepage linking to itself is not a second page to read. */
		if (target.pathname.replace(/\/+$/, '') === base.pathname.replace(/\/+$/, '') && !target.search) continue;
		return target.toString();
	}
	return null;
}

const decode = (html) => html
	.replace(/&#x27;|&#0?39;|&apos;|&rsquo;|&lsquo;|[’‘]/gi, "'")
	.replace(/&nbsp;|&#160;/gi, ' ')
	.replace(/&amp;/gi, '&');

const visibleText = (html) => decode(html
	.replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, ' ')
	.replace(/<!--[\s\S]*?-->/g, ' ')
	.replace(/<[^>]+>/g, ' '))
	.replace(/\s+/g, ' ');

/* Something a person says about themselves, as against something a customer
   says about a visit: "I'm Sarah and I've been coming here for years" names
   nobody who works there. */
const HISTORY = /qualif|graduat|degree|trained|training|registered|founded|established|years[' ]{0,2}(of )?experience|practis|specialis|career/i;

/* Letters after a name. "D.C." is how chiropractors trained abroad write it,
   which is why the match below cannot end on a word boundary. */
const LETTERS = String.raw`BVSc|BVetMed|BVMS|BVM&S|MRCVS|MCSP|HCPC|BSc|MSc|MChiro|D\.C\.|DC|DACCP|BDS|BChD|RIBA|ARB|ACA|FCA|ACCA|MRICS|MNAEA|MARLA|BOst|MOst|PhD|MRCS|FRCS`;

const ROLE = /\b(veterinary surgeon|veterinary nurse|vet|physiotherapist|chiropractor|osteopath|dentist|hygienist|nurse|architect|solicitor|partner|director|founder|owner|proprietor|principal|practice manager|manager|associate|consultant|therapist|technician|surveyor|negotiator|valuer|accountant|head chef|chef|installer|fitter|engineer)\b/i;

/* Words a heading can be made of without being anybody's name. */
const NOT_A_NAME = new Set(['our', 'the', 'about', 'us', 'meet', 'team', 'services', 'service', 'contact', 'why', 'what', 'how', 'who', 'your', 'you', 'we', 'opening', 'hours', 'get', 'in', 'touch', 'book', 'now', 'online', 'latest', 'news', 'welcome', 'to', 'and', 'of', 'for', 'a', 'new', 'home', 'care', 'clinic', 'practice', 'centre', 'center', 'pain', 'treatment', 'treatments', 'reviews', 'testimonials', 'find', 'more', 'learn', 'read']);

function isName(heading) {
	const words = heading.split(' ');
	if (words.length < 2 || words.length > 4) return false;
	return words.every((word) => /^[A-Z][a-zA-Z'-]+\.?$/.test(word) && !NOT_A_NAME.has(word.toLowerCase()));
}

/* The words on this page that introduce somebody, or null if nothing does.
   Returned rather than a boolean so the claim can be audited. */
export function peopleIntroduced(rawHtml) {
	const text = visibleText(rawHtml);

	const self = text.match(/\b(?:I'm|I am|My name is)\s+[A-Z][a-z]{2,}\b[^]{0,300}/);
	if (self && HISTORY.test(self[0])) return `introduces themselves: "${self[0].slice(0, 48).trim()}…"`;

	const lettered = text.match(new RegExp(String.raw`\b(?:Dr\.? (?:[A-Z]\.? )?)?[A-Z][a-z]+ [A-Z][a-zA-Z'-]+,? (?:${LETTERS})(?=[\s,.;)]|$)`));
	if (lettered) return `named with a qualification: "${lettered[0]}"`;

	/* A title alone is NOT counted. "Dr Donny Epstein" is on Uplift
	   Chiropractic's homepage because he devised a technique they offer; a
	   doctor being mentioned is not a doctor being introduced. */

	for (const m of rawHtml.matchAll(/<h[1-5]\b[^>]*>([\s\S]{0,120}?)<\/h[1-5]>/gi)) {
		const heading = visibleText(m[1]).trim();
		if (!isName(heading)) continue;
		const role = visibleText(rawHtml.slice(m.index + m[0].length, m.index + m[0].length + 400)).slice(0, 160).match(ROLE);
		if (role) return `named with a role: "${heading}, ${role[0].toLowerCase()}"`;
	}
	return null;
}
