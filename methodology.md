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

## What this method will not do

- No subjective quality or trustworthiness claims about the businesses. It measures digital presence, never service quality.
- Only objective, reproducible signals. If a number can't be reproduced from this method, it isn't published.
- A correction process on every page; the [site](https://hub.pyc.agency/indices/) is the editable source of truth.
- Business (not personal) data from public sources only.

## The deep scorecard

Every business gets a diagnostic scorecard, not just a row: score + percentile rank in sector, pillar breakdown vs. sector median, specific findings with measured values, quarter-on-quarter movement, the gap to the leader, and prioritised fixes. The full format is on the [canonical methodology page](https://hub.pyc.agency/indices/methodology/).
