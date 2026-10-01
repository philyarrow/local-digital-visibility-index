/* Unit tests for the team signal in lib/people.mjs.
 *
 * The signal was one regular expression over the homepage's links, and it
 * published "team page: no" about practices whose people are introduced under
 * another name. The fixtures below are the wording of real sites that were
 * marked that way.
 *
 * It feeds a published score about named businesses, so the half that matters
 * is what it REFUSES to count: a name-shaped heading, a customer's name in a
 * testimonial, another site's About page.
 *
 * Run: node --test test/
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { linksToPeople, aboutHref, peopleIntroduced } from '../lib/people.mjs';

/* --- links ----------------------------------------------------------------- */

test('everything the old pattern passed still passes', () => {
	for (const haystack of ['our team', '/our-team', '/meet-the-team/', '/our-people', 'staff', 'the team']) {
		assert.equal(linksToPeople(haystack), true, haystack);
	}
});

test('the names sites actually give these pages are recognised', () => {
	for (const haystack of ['meet the experts', '/meet-our-chiropractors/', 'meet our vets', '/our-vets', 'our practitioners', '/clinicians']) {
		assert.equal(linksToPeople(haystack), true, haystack);
	}
});

test('a link that only resembles one is not counted', () => {
	for (const haystack of ['about us', '/services', 'meeting rooms', 'steamroom', 'our services', 'contact']) {
		assert.equal(linksToPeople(haystack), false, haystack);
	}
});

/* --- which page to read ---------------------------------------------------- */

test('the About page is found from the homepage, as an absolute URL', () => {
	const html = '<nav><a href="/">Home</a><a href="/about-us">About Us</a></nav>';
	assert.equal(aboutHref(html, 'https://www.upliftchiropractic.co.uk/?utm_source=google'), 'https://www.upliftchiropractic.co.uk/about-us');
});

test("another site's About page is not this business's", () => {
	const html = '<a href="https://www.wix.com/about">About Wix</a><a href="mailto:about@x.co.uk">about</a>';
	assert.equal(aboutHref(html, 'https://x.co.uk/'), null);
});

test('www and no-www are the same site', () => {
	assert.equal(aboutHref('<a href="https://x.co.uk/about/">About</a>', 'https://www.x.co.uk/'), 'https://x.co.uk/about/');
});

test('a page with no About link, or a base that is not a URL, yields nothing', () => {
	assert.equal(aboutHref('<a href="/services">Services</a>', 'https://x.co.uk/'), null);
	assert.equal(aboutHref('<a href="/about">About</a>', 'not a url'), null);
});

/* --- reading the page ------------------------------------------------------ */

test('somebody introducing themselves, with a history, is an introduction', () => {
	/* Uplift Chiropractic's About page, as served. Published as "team page: no". */
	const html = '<h2>Get to know us</h2><p>Hi, I&#x27;m Ben. I have a Master’s degree in Chiropractic from the University of South Wales.</p>';
	assert.match(peopleIntroduced(html), /^introduces themselves: "I'm Ben\./);
});

test('a customer saying who they are is not', () => {
	const html = '<blockquote>I am Sarah and I have been coming here for years. Lovely place, great food.</blockquote>';
	assert.equal(peopleIntroduced(html), null);
});

test('a name with letters after it is an introduction', () => {
	assert.equal(peopleIntroduced('<p>Dr V. Helen Jones BVMS MRCVS</p>'), 'named with a qualification: "Dr V. Helen Jones BVMS"');
	assert.equal(peopleIntroduced('<p>Owner and Principal Chiropractor Kylie Foster D.C. MChiro, DACCP</p>'), 'named with a qualification: "Kylie Foster D.C."');
	assert.equal(peopleIntroduced('<p>Tom Cairns MChiro joined us in 2019.</p>'), 'named with a qualification: "Tom Cairns MChiro"');
});

test('a doctor merely mentioned is not an introduction', () => {
	/* Uplift Chiropractic's homepage names the man who devised a technique
	   they offer. The first draft of this check counted him as their team. */
	assert.equal(peopleIntroduced('<h3>Network Spinal (Dr Donny Epstein)</h3><p>Dr. Donny Epstein developed Network Spinal as a gentle approach.</p>'), null);
});

test("a heading that is a person's name, with their role under it, is an introduction", () => {
	/* Bristol Back Pain Clinic's homepage: people in a section, no page of their own. */
	const html = '<h2>Our Team</h2><h3>Harry Kauntze</h3><p>Chiropractor</p><h3>Marion Vey</h3><p>Osteopath</p>';
	assert.equal(peopleIntroduced(html), 'named with a role: "Harry Kauntze, chiropractor"');
});

test('a name-shaped heading is not a person', () => {
	/* "Our Services" over a paragraph that mentions a physiotherapist. */
	for (const heading of ['Our Services', 'About Us', 'Meet The Team', 'Opening Hours', 'Back Pain', 'Contact Us']) {
		assert.equal(peopleIntroduced(`<h2>${heading}</h2><p>See a physiotherapist or chiropractor this week.</p>`), null, heading);
	}
});

test('a name with no role near it is not an introduction', () => {
	assert.equal(peopleIntroduced('<h3>Lee Sutton</h3><p>Great night out, would recommend.</p>'), null);
});

test('a page that introduces nobody yields nothing', () => {
	assert.equal(peopleIntroduced('<h1>Welcome</h1><p>We offer physiotherapy and sports massage in Cheltenham. Book online.</p>'), null);
	assert.equal(peopleIntroduced(''), null);
});

test('text inside a script is not read as the page', () => {
	assert.equal(peopleIntroduced('<script>var bio = "Dr Anna Whitfield BVSc";</script><p>Welcome.</p>'), null);
});

/* --- the collector, against a stubbed network ------------------------------ */

import { collectContent } from '../collect.mjs';

const page = (html) => new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });

async function withSite(pages, run) {
	const real = globalThis.fetch;
	const asked = [];
	globalThis.fetch = async (url) => {
		asked.push(String(url));
		const answer = pages[String(url)];
		if (answer instanceof Error) throw answer;
		return answer ? page(answer) : new Response('not found', { status: 404, headers: { 'content-type': 'text/html' } });
	};
	try { return { out: await run(), asked }; } finally { globalThis.fetch = real; }
}

const HOME = '<html><body><nav><a href="/about-us">About Us</a><a href="/contact">Contact</a></nav><p>Chiropractic care in Gloucester.</p></body></html>';
const ABOUT = '<html><body><p>Hi, I&#x27;m Ben. I have a Master’s degree in Chiropractic.</p></body></html>';

test('people introduced on the About page are found when no link says team', async () => {
	/* THE REGRESSION TEST. This is Uplift Chiropractic, published as "team page: no". */
	const { out, asked } = await withSite({ 'https://x.co.uk/': HOME, 'https://x.co.uk/about-us': ABOUT }, () => collectContent('https://x.co.uk/', null));
	assert.equal(out.hasTeamLink, true);
	assert.equal(out.teamSource, 'about page');
	assert.match(out.teamEvidence, /I'm Ben/);
	assert.deepEqual(asked, ['https://x.co.uk/', 'https://x.co.uk/about-us']);
});

test('a team link on the homepage is enough, and nothing else is fetched', async () => {
	const home = HOME.replace('About Us</a>', 'About Us</a><a href="/meet-the-team">Meet the team</a>');
	const { out, asked } = await withSite({ 'https://x.co.uk/': home }, () => collectContent('https://x.co.uk/', null));
	assert.equal(out.hasTeamLink, true);
	assert.equal(out.teamSource, 'homepage link');
	assert.equal(out.teamEvidence, null);
	assert.deepEqual(asked, ['https://x.co.uk/']);
});

test('people introduced on the homepage itself are found without a second fetch', async () => {
	const home = HOME.replace('<p>Chiropractic care', '<h3>Harry Kauntze</h3><p>Chiropractor</p><p>Chiropractic care');
	const { out, asked } = await withSite({ 'https://x.co.uk/': home }, () => collectContent('https://x.co.uk/', null));
	assert.equal(out.teamSource, 'homepage');
	assert.deepEqual(asked, ['https://x.co.uk/']);
});

test('an About page that introduces nobody leaves the answer at no', async () => {
	const { out } = await withSite({ 'https://x.co.uk/': HOME, 'https://x.co.uk/about-us': '<p>Founded in 2010, we serve Gloucester.</p>' }, () => collectContent('https://x.co.uk/', null));
	assert.equal(out.hasTeamLink, false);
	assert.equal(out.teamSource, null);
	assert.equal(out.hasAboutLink, true);
});

test('a broken About page costs only this signal, never the check', async () => {
	for (const about of [undefined, new Error('socket hang up')]) {
		const { out } = await withSite({ 'https://x.co.uk/': HOME, 'https://x.co.uk/about-us': about }, () => collectContent('https://x.co.uk/', null));
		assert.equal(out.error, null);
		assert.equal(out.hasTeamLink, false);
		assert.equal(out.hasAboutLink, true);
		assert.equal(typeof out.wordCount, 'number');
	}
});
