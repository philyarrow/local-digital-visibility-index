#!/usr/bin/env bash
# Regenerate every index into the site repo.
#
# This exists because an ad-hoc loop with `>/dev/null 2>&1` once swallowed a
# ReferenceError and failed all seven generations silently — the source looked
# correct, the site build passed, and the published pages stayed stale. Errors
# are surfaced and a single failure fails the run.
set -euo pipefail

# usage: regenerate-all.sh [SITE_ROOT] [QUARTER] [--only slug...]
#
# Slugs go behind --only, never in a bare positional. The bare positionals are
# SITE_ROOT then QUARTER, and a slug in either slot is not detectable after the
# fact: `regenerate-all.sh ../../site bristol-dentists` would take the slug as
# the quarter, stamp "bristol-dentists" into 11 pages' titles and JSON-LD, and
# write data/<slug>/bristol-dentists.json beside the real snapshot — exit 0, no
# complaint. Both positionals are therefore validated below rather than trusted.
SITE_ROOT=""
QUARTER=""
ONLY=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --only)
      shift
      while [ "$#" -gt 0 ]; do
        case "$1" in --*) break ;; esac
        ONLY+=("$1"); shift
      done
      ;;
    --site-root) SITE_ROOT="${2:?--site-root needs a path}"; shift 2 ;;
    --quarter)   QUARTER="${2:?--quarter needs a value}"; shift 2 ;;
    --*) echo "unknown option: $1" >&2; exit 1 ;;
    *)
      if   [ -z "$SITE_ROOT" ]; then SITE_ROOT="$1"
      elif [ -z "$QUARTER" ];   then QUARTER="$1"
      else echo "unexpected argument '$1' — slugs go after --only" >&2; exit 1
      fi
      shift
      ;;
  esac
done
SITE_ROOT="${SITE_ROOT:-../../hub.philyarrow.co.uk}"
QUARTER="${QUARTER:-Q3-2026}"

case "$QUARTER" in
  Q[1-4]-[0-9][0-9][0-9][0-9]) ;;
  *) echo "quarter must look like Q3-2026, got '$QUARTER'" >&2; exit 1 ;;
esac

cd "$(dirname "$0")"

# generate.mjs mkdirs its output recursively, so a mistyped site root is not an
# error there — it silently builds a whole content tree inside this repo.
[ -d "$SITE_ROOT/new/src/content/docs" ] || {
  echo "site root '$SITE_ROOT' does not look like the hub repo (no new/src/content/docs)" >&2
  exit 1
}

# Published indices only. This writes pages into the live site, so an index
# reaches it by a person setting publish:true in config/indices.json, never by a
# seed file existing. --only overrides the flag, for regenerating a single page.
#
# `mapfile` is bash 4+; macOS ships bash 3.2, so read the list portably.
SLUGS=()
if [ "${#ONLY[@]}" -gt 0 ]; then
  SLUGS=("${ONLY[@]}")
  # A typo'd slug otherwise falls through to the "not collected yet" skip and
  # the run reports success having regenerated nothing — the silent failure
  # this script was written to prevent, reached through its own interface.
  node -e "
    const c = require('./config/indices.json');
    const bad = process.argv.slice(1).filter((s) => s.startsWith('_') || !(s in c));
    if (bad.length) { console.error('not in config/indices.json: ' + bad.join(', ')); process.exit(1); }
  " "${SLUGS[@]}"
else
  while IFS= read -r line; do SLUGS+=("$line"); done < <(node -e "
    const c = require('./config/indices.json');
    Object.keys(c).filter((k) => !k.startsWith('_') && c[k] && c[k].publish === true).forEach((k) => console.log(k));
  ")
  # Count what the flag excluded. Without this the run prints "11 of 11" and a
  # forgotten publish:true is invisible in the one place an operator looks.
  UNPUBLISHED=$(node -e "
    const c = require('./config/indices.json');
    console.log(Object.keys(c).filter((k) => !k.startsWith('_') && !(c[k] && c[k].publish === true)).length);
  ")
fi
[ "${#SLUGS[@]}" -gt 0 ] || { echo "No published indices resolved from config/indices.json." >&2; exit 1; }

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
[ "$skipped" -gt 0 ] && note="$note ($skipped not collected yet)"
[ "${UNPUBLISHED:-0}" -gt 0 ] && note="$note (${UNPUBLISHED} configured but publish:false, not regenerated)"
echo "Regenerated $(( ${#SLUGS[@]} - skipped )) of ${#SLUGS[@]} indices into $SITE_ROOT$note"
