#!/usr/bin/env bash
# launchd entry point. Lives in the publisher's own clone, updates it, then runs
# the release. launchd starts with a bare environment, so PATH is set in the plist.
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only --quiet origin main
exec node publish-month.mjs "$@"
