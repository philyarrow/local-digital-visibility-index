#!/usr/bin/env bash
# Regenerate every index into the site repo.
#
# This exists because an ad-hoc loop with `>/dev/null 2>&1` once swallowed a
# ReferenceError and failed all seven generations silently — the source looked
# correct, the site build passed, and the published pages stayed stale. Errors
# are surfaced and a single failure fails the run.
set -euo pipefail

SITE_ROOT="${1:-../../hub.philyarrow.co.uk}"
QUARTER="${2:-Q3-2026}"

cd "$(dirname "$0")"
# `mapfile` is bash 4+; macOS ships bash 3.2, so read the list portably.
SLUGS=()
while IFS= read -r line; do SLUGS+=("$line"); done < <(node -e "
  const c = require('./config/indices.json');
  Object.keys(c).filter(k => !k.startsWith('_')).forEach(k => console.log(k));
")

fail=0
skipped=0
for slug in "${SLUGS[@]}"; do
  printf '  %-28s' "$slug"
  # An index can be configured with a reviewed seed before it has ever been
  # collected. That is a normal intermediate state, not a failure, and it must
  # not stop the other six from regenerating.
  # A directory alone is not enough: a run aborted after writing _cost.json
  # leaves the directory with no business records, and score.mjs would then
  # fail the whole loop — the exact outcome this skip exists to prevent.
  if ! ls data/"$slug"/[!_]*.json >/dev/null 2>&1; then
    echo "not collected yet - skipped"; skipped=$((skipped+1)); continue
  fi

  # collect.mjs writes _cost.json once, after the per-business loop, so its
  # presence means the run finished. Without this an IN-PROGRESS collection at
  # 49 of 55 businesses passed the percentage test below and was generated
  # mid-flight — a published league table missing whoever had not been
  # collected yet.
  if [ ! -f "data/$slug/_cost.json" ]; then
    echo "collection in progress or aborted - skipped"; skipped=$((skipped+1)); continue
  fi

  # Nor is "some records" enough. An interrupted collection left 2 of 41
  # Gloucester accountants on disk and this script cheerfully generated and
  # published a two-firm league table. A cohort missing a fifth of its
  # businesses is not the index we said we measured, so it is skipped rather
  # than published short.
  if [ -f "seeds/$slug.csv" ]; then
    want=$(( $(wc -l < "seeds/$slug.csv") - 1 ))
    have=$(ls data/"$slug"/[!_]*.json 2>/dev/null | wc -l | tr -d ' ')
    if [ "$want" -gt 0 ] && [ "$have" -lt $(( want * 80 / 100 )) ]; then
      echo "partial ($have of $want) - skipped"; skipped=$((skipped+1)); continue
    fi
  fi
  if node score.mjs "$slug" >/dev/null && node generate.mjs "$slug" --quarter "$QUARTER" --site-root "$SITE_ROOT" >/dev/null; then
    echo "ok"
  else
    echo "FAILED"; fail=1
  fi
done

[ "$fail" -eq 0 ] || { echo "one or more indices failed to generate" >&2; exit 1; }
note=""
[ "$skipped" -gt 0 ] && note=" ($skipped not collected yet)"
echo "Regenerated $(( ${#SLUGS[@]} - skipped )) of ${#SLUGS[@]} indices into $SITE_ROOT$note"
