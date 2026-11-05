#!/usr/bin/env bash
# launchd entry point. This clone is the publisher's own, so it is reset rather
# than pulled: a pull fails for ever once local and remote diverge, and it fails
# before the node script that would raise an alert.
set -uo pipefail
cd "$(dirname "$0")/.."

case "$(pwd -P)" in
  "$(cd "${PUBLISHER_HOME:?PUBLISHER_HOME is not set}" && pwd -P)"/*) ;;
  *) echo "Refusing to reset $(pwd -P): not inside PUBLISHER_HOME" >&2; exit 1 ;;
esac

if ! { git fetch --quiet origin main && git checkout --quiet -f main && git reset --quiet --hard origin/main; }; then
  gh issue create -R philyarrow/hub.philyarrow --title "Index publisher could not update itself" \
    --body "publisher/run.sh could not reset its clone in ${PUBLISHER_HOME}. Nothing was published. See publisher.log there."
  exit 1
fi
exec node publish-month.mjs "$@"
