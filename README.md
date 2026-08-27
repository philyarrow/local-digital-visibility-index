# Local Digital Visibility Index

Open data, methodology, and the full measurement pipeline behind PYC's **Local Digital Visibility Indices** — recurring, data-driven league tables ranking how well businesses in Bristol, Cheltenham and Gloucester perform online.

> **The analysis lives at [hub.pyc.agency/indices](https://hub.pyc.agency/indices/).**
> This repository exists so anyone can verify the numbers and reproduce them. The site is the canonical home of every index, scorecard, and finding.

## What this is

Each index scores every business in one sector of one city on a **Digital Visibility Score (0–100)**, built from six weighted pillars: Speed & Core Web Vitals, Technical foundation, Local presence, Visibility, AI search presence, and Content & trust. Full weighting and rules are in [`methodology.md`](./methodology.md) (mirrors the [canonical methodology](https://hub.pyc.agency/indices/methodology/)).

Everything here is objective and publicly observable. There are no opinions about the businesses themselves — only measured facts about their digital presence, each with a snapshot date.

## Repository layout

```
methodology.md        How the Digital Visibility Score is measured (canonical: hub.pyc.agency)
pipeline/             The measurement pipeline — collect, score, generate (MIT)
data/                 Dated quarterly dataset snapshots, per index (CC BY 4.0)
CORRECTIONS.md        Changelog of corrections (the site is the editable source of truth)
LICENSE-CODE          MIT — the pipeline
LICENSE-DATA          CC BY 4.0 — the datasets
```

## Reproduce it yourself

The pipeline is Node ESM with **no npm dependencies** (Node 20+ recommended). From `pipeline/`:

```bash
cp pipeline/.env.example .env        # then add your DATAFORSEO_AUTH

cd pipeline

# 0. Check the generated keyword basket and cost forecast — fetches nothing
node collect.mjs seeds/bristol-estate-agents.csv --dry-run

# 1. Collect raw signals for an index
node collect.mjs seeds/bristol-estate-agents.csv

# 2. Score + rank, compute sector medians
node score.mjs bristol-estate-agents

# 3. Generate the published pages + snapshot JSON/CSV into the site repo
node generate.mjs bristol-estate-agents --quarter Q3-2026 \
  --site-root ../../hub.philyarrow.co.uk
```

See [`pipeline/README.md`](./pipeline/README.md) for what each pillar measures, the configuration files, per-call costs, and the exact data flow.

## Where the code lives

**This repository is the canonical home of the measurement pipeline.** It is not
a mirror or an export — `pipeline/` is the only copy, and it is where changes
are made.

The site that publishes the indices, [hub.pyc.agency](https://hub.pyc.agency/indices/),
is a **separate repository** (`hub.philyarrow`). It holds presentation only: the
Astro pages and the generated snapshots. It contains no pipeline code.

```
local-digital-visibility-index  (this repo)   measurement + open data — CANONICAL
        │
        │  generate.mjs --site-root ../../hub.philyarrow.co.uk
        ▼
hub.philyarrow                                presentation — generated content only
```

The boundary exists so the numbers can be audited independently of the site that
publishes them, and so there is exactly one copy of the code that produces them.
`generate.mjs` is the single step that crosses it, which is why its destination
is an explicit argument rather than a relative path it guesses.

## Cost

The pipeline calls paid APIs. Most signals are bought **once per index** and read
for every business in it — one geo-located SERP response holds every firm's
position, one AI answer names whichever firms it names, one listings sweep covers
the whole sector. Only the profile fallback and reviews are per business.

Every run prints a forecast before spending, and afterwards a ledger reconciled
against DataForSEO's per-task billing record, written to
`pipeline/data/<index>/_cost.json`.

| Signal | Unit | Cost |
|---|---|---|
| SERP keyword (standard queue, depth 100) | per index | $0.00465 |
| AI prompt (Perplexity `sonar`) | per index | $0.00591 |
| Business listings sweep | per index | ~$0.00048/result (~$0.048 at limit 100) |
| Google Business Profile (fallback) | per unmatched business | $0.00150 |
| Reviews (90-day velocity) | per business | $0.00150 |
| Speed, technical, content | per business | free |

A 12-keyword, 5-prompt index of 8 businesses costs about **$0.15**. Prices
measured 27 August 2026 by reading DataForSEO's own `cost` field and reconciling
per task against `id_list`.

## Using this data

The datasets are **CC BY 4.0** — reuse them freely, including in research, articles, and AI-generated answers, **with attribution**:

> Source: PYC Local Digital Visibility Index — https://hub.pyc.agency/indices/ ([snapshot date])

The pipeline code is **MIT**.

## Corrections

Spotted an error in a score? The site is the editable source of truth — request a correction via the link on the relevant [index page](https://hub.pyc.agency/indices/). Confirmed corrections are logged in [`CORRECTIONS.md`](./CORRECTIONS.md) and roll into the next quarterly snapshot.

## Cadence

Indices are re-measured quarterly. Each snapshot is a dated, tagged release ("true as of [date]"); prior snapshots stay published so movement over time is visible.

---

Maintained by [Phil Yarrow (PYC)](https://hub.pyc.agency/about/).
