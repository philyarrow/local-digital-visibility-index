# Index methodology

> Canonical version: **[hub.pyc.agency/indices/methodology](https://hub.pyc.agency/indices/methodology/)**. This file mirrors it so the data in this repo is self-documenting. If the two ever differ, the site is authoritative.

Every Local Digital Visibility Index is built the same way — same pillars, same weights, same data sources, same snapshot discipline — so league tables stay comparable across cities and sectors, and anyone can reproduce the numbers.

The headline metric is the **Digital Visibility Score**, a 0–100 figure from six pillars of objective, publicly-observable signals.

## The six scoring pillars

| Pillar | Weight | Signals |
|--------|-------:|---------|
| Speed & Core Web Vitals | 20% | PageSpeed Insights / CrUX — LCP, INP, CLS, mobile performance score |
| Technical foundation | 20% | HTTPS, mobile-friendly, indexable, XML sitemap, robots hygiene, valid structured data |
| Local presence | 20% | Google Business Profile completeness, review count, average rating, review velocity (new/90d), NAP consistency |
| Visibility | 15% | Ranking visibility for a fixed local keyword basket; local-pack appearance |
| AI search presence | 15% | Appearance in AI Overviews, ChatGPT search, Perplexity and Gemini for core local queries |
| Content & trust | 10% | Indexed page count, about / team / credentials present, content freshness |

Each pillar is scored 0–100, then combined by the weights above. Pillar scores are always published alongside the headline number, so a single figure never stands alone. Pillars with no available data for a given run are excluded and the remaining weights are renormalised (see `pipeline/score.mjs`).

## What counts as a measurement

A signal is only used in a published index when it is:

1. **Publicly observable** — from the live site, the public Google Business Profile, public SERPs, or public AI-search answers.
2. **Machine-measured** — produced by a documented tool or API, not a human judgement.
3. **Dated** — every index carries its snapshot date and names the source.

## Context data that is recorded but never scored

Three further sources are collected alongside the pillars. **None of them carries any weight in the Digital Visibility Score, and none can move a ranking.** That separation is deliberate: a published score must never change because a third party enabled an API key, or because a business is small enough to be absent from someone else's dataset.

**A first-party crawl.** Each site is crawled from its homepage — obeying `robots.txt`, one page at a time with a delay, capped by page count, depth and total time, identifying itself as `PYCLocalIndexBot` with a link to this page. It records click depth to key pages, internal links per page, the share of anchors that name nothing ("click here", "read more"), and pages listed in the sitemap that were never reached by following links. Orphan counts are only reported when a crawl finished naturally: a crawl stopped by the page cap has unvisited pages by construction, and calling those orphans would be false.

**Chrome UX Report (CrUX).** The Speed pillar uses PageSpeed lab data — a synthetic run on Google's hardware. CrUX is the field equivalent: real Chrome users, 28-day p75. Where both exist, the index publishes both.

CrUX has a coverage limit that matters here. Google only reports origins with enough traffic to be statistically meaningful, and most small local firms do not reach it — of the first twelve Gloucester accountancy practices tested, **none** had CrUX data, while a Bristol estate agency with far more traffic did. Absence therefore correlates with being small. Scoring on it would systematically penalise exactly the businesses least able to change it, which is why it is context and not a pillar.

**Companies House.** Company number, incorporation date, status and SIC code, matched on an exact normalised name against an active company — anything less confident records no match rather than guessing. This gives each business an official registry identifier rather than a name we matched on, and lets a cohort be read with company age and size in view, which is the fairest answer to "you are comparing a three-person firm with a fifty-person one". The SIC code also states, from an authoritative source, what a company is registered to do.

Professional-regulator registers (SRA, Gas Safe, Propertymark) are **not** used. Their published crawl policies disallow the register search endpoints, and this project will not take data it has been asked not to take. Where an official rating is genuinely open — the FSA's food hygiene ratings, for example — it may be used and will be named.

## What this method will not do

- No subjective quality or trustworthiness claims about the businesses. It measures digital presence, never service quality.
- Only objective, reproducible signals. If a number can't be reproduced from this method, it isn't published.
- A correction process on every page; the [site](https://hub.pyc.agency/indices/) is the editable source of truth.
- Business (not personal) data from public sources only.

## The deep scorecard

Every business gets a diagnostic scorecard, not just a row: score + percentile rank in sector, pillar breakdown vs. sector median, specific findings with measured values, quarter-on-quarter movement, the gap to the leader, and prioritised fixes. The full format is on the [canonical methodology page](https://hub.pyc.agency/indices/methodology/).
