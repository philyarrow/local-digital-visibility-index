#!/usr/bin/env bash
# Sets up the monthly publisher on this Mac: two dedicated clones, so its resets
# can never touch a working checkout, and a daily launchd job. Safe to re-run.
set -euo pipefail

HOME_DIR="${PUBLISHER_HOME:-$HOME/.local/share/pyc-index-publisher}"
NODE_BIN="$(command -v node)"
# fnm hands out a per-shell node path that disappears. launchd needs a stable one.
case "$NODE_BIN" in
  *fnm_multishells*) NODE_BIN="$(fnm exec --using=default which node)" ;;
esac
GIT_NAME="Phil Yarrow"
GIT_EMAIL="philyarrow@Phils-MacBook-Pro.local"

clone() {
  [ -d "$2/.git" ] || git clone --quiet "https://github.com/philyarrow/$1.git" "$2"
  git -C "$2" config user.name "$GIT_NAME"
  git -C "$2" config user.email "$GIT_EMAIL"
}

mkdir -p "$HOME_DIR"
clone local-digital-visibility-index "$HOME_DIR/pipeline"
clone hub.philyarrow "$HOME_DIR/site"

PLIST="$HOME/Library/LaunchAgents/co.philyarrow.index-publisher.plist"
sed -e "s#__HOME__#$HOME_DIR#g" -e "s#__NODE_DIR__#$(dirname "$NODE_BIN")#g" \
  "$(dirname "$0")/co.philyarrow.index-publisher.plist" > "$PLIST"
launchctl bootout "gui/$(id -u)/co.philyarrow.index-publisher" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed. Clones in $HOME_DIR, log at $HOME_DIR/publisher.log"
