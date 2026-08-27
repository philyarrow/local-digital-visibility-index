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
for slug in "${SLUGS[@]}"; do
  printf '  %-28s' "$slug"
  if node score.mjs "$slug" >/dev/null && node generate.mjs "$slug" --quarter "$QUARTER" --site-root "$SITE_ROOT" >/dev/null; then
    echo "ok"
  else
    echo "FAILED"; fail=1
  fi
done

[ "$fail" -eq 0 ] || { echo "one or more indices failed to generate" >&2; exit 1; }
echo "All ${#SLUGS[@]} indices regenerated into $SITE_ROOT"
