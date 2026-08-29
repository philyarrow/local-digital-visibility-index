# Datasets

Dated quarterly snapshots of each Local Digital Visibility Index, one folder per index.

```
data/
  bristol-estate-agents/      Bristol — estate agents
  cheltenham-law-firms/       Cheltenham — law firms & accountants   (planned)
  gloucester-construction/    Gloucester — construction & trades     (planned)
```

Each index folder holds one `<quarter>.json` and `<quarter>.csv` per snapshot, e.g. `q2-2026.json`. Snapshots are immutable and dated ("true as of [date]"); prior snapshots stay published so movement over time is visible.

## Two kinds of file, and the difference matters

```
data/bristol-estate-agents/
  q3-2026.json        PUBLISHED  the ranking, editorially reviewed
  q3-2026.csv         PUBLISHED
  history/
    2026-09.json      INTERIM    a monthly measurement, not a ranking
    2026-09.csv       INTERIM
```

**`<quarter>.json` is the published index.** It is what the site shows, what the
scorecards are generated from, and what a citation refers to. It is written once
per quarter and never rewritten.

**`<quarter>-superseded-<date>.json` is a withdrawn published dataset.** When a
figure is corrected after publication the original is kept, not deleted, so
anyone who cited it can still find exactly what they cited. The
[changelog](https://hub.pyc.agency/indices/changelog/) says what changed and why.

**`history/<YYYY-MM>.json` is an interim measurement.** Collection runs monthly
so that movement can be analysed over time — you cannot fit a trend to one data
point. These files carry `"status": "interim"`, they are produced automatically
without editorial review, and **no business is ranked on them**.

If you are citing a score for a business, cite the quarterly file. If you are
analysing change over time, use the history series. Do not present an interim
figure as a business's position in the index, because it isn't one.

**License:** all data here is CC BY 4.0 — see [`../LICENSE-DATA`](../LICENSE-DATA). Reuse freely with attribution to `PYC Local Digital Visibility Index — https://hub.pyc.agency/indices/`.

The human-facing analysis for every snapshot lives at [hub.pyc.agency/indices](https://hub.pyc.agency/indices/) (canonical).
