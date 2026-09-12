#!/usr/bin/env bash
# Compralo demo browser: Chrome for Testing with the AutoBuy extension pre-loaded.
#
# Branded Google Chrome has ignored --load-extension since 137 (it opens a window and
# says nothing). Chrome for Testing honours it, and Playwright already leaves builds in
# ~/Library/Caches/ms-playwright. The profile is persistent, so the pinned icon and the
# saved backend URL survive relaunches.
#
#   ./demo-browser.sh                       opens the dashboard
#   ./demo-browser.sh https://…/product     opens a product page instead
#   CHROME_FOR_TESTING=/path/to/binary      use a specific build
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="${COMPRALO_CHROME_PROFILE:-$HOME/.compralo/chrome-profile}"
PORT="${COMPRALO_CDP_PORT:-}"
if [ -z "$PORT" ]; then           # first free DevTools port from 9222 up; another Chromium may own 9222
  for p in 9222 9223 9224 9225 9226; do lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1 || { PORT=$p; break; }; done
fi
BIN="${CHROME_FOR_TESTING:-}"
if [ -z "$BIN" ]; then
  BIN="$(ls -d "$HOME"/Library/Caches/ms-playwright/chromium-*/chrome-mac-arm64/"Google Chrome for Testing.app"/Contents/MacOS/"Google Chrome for Testing" 2>/dev/null | sort -V | tail -1 || true)"
fi
if [ ! -x "$BIN" ]; then
  echo "No Chrome for Testing found. Install one:  npx @puppeteer/browsers install chrome@stable" >&2
  echo "then run:  CHROME_FOR_TESTING=<path to the binary> $0" >&2
  exit 1
fi
mkdir -p "$PROFILE"
echo "browser : $BIN"
echo "profile : $PROFILE"
echo "ext     : $HERE"
exec "$BIN" \
  --user-data-dir="$PROFILE" \
  --load-extension="$HERE" \
  --no-first-run --no-default-browser-check \
  --remote-debugging-port="$PORT" \
  "${@:-http://localhost:3000/dashboard}"
