# Pipeline — Local Digital Visibility Index

The measurement engine behind the [Local Digital Visibility Indices](https://hub.pyc.agency/indices/).
It turns a seed list of businesses into a ranked, fully-cited league table and per-business
diagnostic scorecards, scored to the published [methodology](../methodology.md).

Node ESM, **no npm dependencies** — Node built-ins + global `fetch` only (Node 20+ recommended).

## Data flow

```
seeds/<index-slug>.csv
        │  node collect.mjs seeds/<index-slug>.csv
        ▼
data/<index-slug>/<business-slug>.json      one raw-signals file per business
        │  node score.mjs <index-slug>
        ▼
data/<index-slug>/_ranked.json              scored, ranked, sector medians
        │  node generate.mjs <index-slug> --quarter Q2-2026
        ▼
published JSON/CSV snapshot + scorecard content
```

The `<index-slug>` is derived from the seed filename, e.g.
`seeds/bristol-estate-agents.csv` → `bristol-estate-agents`.

## What's live vs. external

- **Live (works out of the box):** Speed & Core Web Vitals (PageSpeed Insights API — set `PAGESPEED_API_KEY` to avoid rate limits), Technical foundation (homepage / robots / sitemap / structured-data parsing), and part of Content & trust.
- **Requires an external data source:** Local presence (Google Places / GBP API), Visibility (a SERP source), AI search presence (per-engine access or an AI-SERP source). These are documented stub functions in `collect.mjs` — wire your own source. Until then, those pillars are excluded and the weights renormalise.

## Note on `generate.mjs`

`generate.mjs` produces the published snapshot artifacts (JSON/CSV) and the per-business
scorecard content. The data snapshots land in this repo's [`/data`](../data/) directory; the
human-facing analysis is published at [hub.pyc.agency/indices](https://hub.pyc.agency/indices/),
which is the canonical home.

## Guardrails

Objective, publicly-observable signals only. Never commit API keys. No subjective claims about
businesses. Business data from public sources only.
