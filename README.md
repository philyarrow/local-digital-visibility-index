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
# 1. Collect raw signals for an index (uses a free PageSpeed key if set)
PAGESPEED_API_KEY=... node collect.mjs seeds/bristol-estate-agents.csv

# 2. Score + rank, compute sector medians
node score.mjs bristol-estate-agents

# 3. Generate the published artifacts (snapshot JSON/CSV)
node generate.mjs bristol-estate-agents --quarter Q2-2026
```

See [`pipeline/README.md`](./pipeline/README.md) for what each pillar measures, which signals are live vs. require an external data source, and the exact data flow.

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
