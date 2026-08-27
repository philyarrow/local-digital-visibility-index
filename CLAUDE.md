# CLAUDE.md — local-digital-visibility-index

Guidance for Claude Code working in this repository.

## What this repo is

The **canonical home of the Local Digital Visibility Index measurement
pipeline**, plus the published open datasets. Public repository, MIT for code
and CC BY 4.0 for data.

This is not a mirror or an export. `pipeline/` is the only copy of this code.
Make changes here.

## The two-repo boundary

| Repo | Owns | Contains |
|---|---|---|
| `local-digital-visibility-index` (this one) | Measurement + open data | `pipeline/`, `data/`, `methodology.md` |
| `hub.philyarrow` | Presentation | Astro site, generated MDX, `new/public/data/` |

The site repo holds **no pipeline code**. If you find yourself copying a file
from `pipeline/` into the site repo, stop — that duplication is exactly what
this split removed, and the two copies silently diverged last time.

`generate.mjs` is the only step that writes across the boundary. Its destination
is a required `--site-root` argument, never inferred from `__dirname`.

## Running it

```bash
cp pipeline/.env.example .env     # DATAFORSEO_AUTH is required
cd pipeline

node collect.mjs seeds/<index>.csv --dry-run   # basket + cost forecast, spends nothing
node collect.mjs seeds/<index>.csv             # spends money
node score.mjs <index-slug>
node generate.mjs <index-slug> --quarter Q3-2026 --site-root ../../hub.philyarrow.co.uk
```

Node 20+. No npm dependencies anywhere in the pipeline — keep it that way, it is
part of the "anyone can verify this" promise.

## Money — read before touching collect.mjs

This pipeline spends real money on every run. Several rules exist because they
were learned the expensive way:

- **Always `--dry-run` first** when changing baskets or config. It resolves the
  keywords and prints a forecast without fetching.
- **A posted queued task is already charged.** Task IDs are persisted to
  `data/<index>/_serp-tasks.json` *before* harvesting, so a crash or timeout
  resumes instead of paying twice. Do not remove that.
- **`task_get` is free.** It echoes the task's original cost in its `cost`
  field, which is why retrieval calls pass `free: true` and are excluded from
  the ledger. Counting them doubles every queued task in the report.
- **A not-ready task answers with 40601/40602**, which are *not* failures.
  Treating them as failures silently discards work already bought.
- **Balance deltas are only valid with nothing else in flight.** Concurrent runs
  contaminate them. For per-task attribution use the `id_list` endpoint, which
  is immune to concurrency.
- **Never retry a charged call silently.** Report the failure instead.
- **`location_name` is required by `business_data/google/reviews` even when
  addressing by `place_id`.** Omitting it returns 40501 "Invalid Field:
  'location_name'" — their wording for a *missing* required field — which
  silently zeroes review velocity for the whole index while still charging.

## Local presence uses two sources on purpose

Neither source is adequate alone, and they fail on *different* firms:

| Source | Scope | Cheltenham | Bristol |
|---|---|---|---|
| `business_listings/search` | one sweep per index | 3/8 | 10/18 |
| `my_business_info` | per business | 7/8 | 7/18 |

Coverage depends on how densely populated the Google category is —
`real_estate_agency` is dense, `law_firm` is sparse. So the sweep runs first
(it also aggregates a firm's branches, which a per-business lookup cannot), and
`profileFallback` fills the gaps. Do not "simplify" this back to one source.

`dfsCategories` is a list for the same reason: a single category missed most of
a seed.

Branch aggregation weights ratings by review count — a 4.9 from 3 reviews must
not outweigh a 4.2 from 500. Summing branch reviews favours chains, which is a
real difference in local presence; `branchCount` and `placeIds` are recorded so
that effect stays visible.

## Cost shape — why collect.mjs is ordered as it is

Visibility (SERP) and AI presence are bought **once per index** and read for
every business in it: one geo-located SERP response holds every firm's position,
one AI answer names whichever firms it names. Local presence is bought **per
business** and multiplies.

Collecting the shared signals per-business would multiply an index's cost by its
business count for identical data. Preserve that structure.

## Configuration, not code

Adding an index is a config entry plus a seed CSV — never a code change.

| File | Holds |
|---|---|
| `pipeline/config/engine.json` | SERP depth/mode, AI engine + model, prompts and keywords per index, cadence, budget |
| `pipeline/config/sectors.json` | Keyword and AI-prompt templates per sector, with `{town}` / `{area}` placeholders |
| `pipeline/config/indices.json` | Index registry: slug → sector, town, DataForSEO `locationName`, areas |

The seed CSV filename must match the `indices.json` key.

## Scoring integrity

These are public, ranked judgements about named real businesses. The scoring
rules protect against publishing something indefensible:

- A pillar with no data is **excluded and the remaining weights renormalised**,
  never scored zero. Zero would punish every business identically and make the
  headline number meaningless.
- `basketSize` counts keywords that **actually returned**, not keywords
  requested. One API failure must never depress everyone's coverage.
- Business matching is in `pipeline/lib/match.mjs`. Domain matching is exact on
  the registrable domain — never a substring, or `notallenandharris.co.uk`
  matches `allenandharris.co.uk`. Name matching strips shared sector words but
  **keeps connectives**: `normaliseName` expands `&` to `and`, so stripping
  `and` makes every firm with an ampersand unmatchable and silently zeroes its
  AI pillar.
- AI citations record `matchedBy` (`domain` or `name`) so a published score can
  be audited. A domain citation is stronger evidence than a bare name mention.

If you change a scorer or a weight, update `methodology.md` in the same commit —
the site mirrors it, and a score is only defensible if the published rules match
the code that produced it.

## Style

Tabs. Node ESM. Block comments explaining *why*, not what. Every network call
gets a timeout; one bad site never aborts a run.
