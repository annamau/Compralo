#!/usr/bin/env bash
# Stage runbook: the full AutoBuy demo with the REAL Chrome extension, cued step by step, with
# the market pushes and the agent's terminal output handled for you. Also the runbook for the
# live demo. You click; this script does everything else.
#
#   ./stage.sh              run the cued sequence
#   ./stage.sh --no-record  same, without the recording cues
set -u
MARKET=${MARKET_URL:-http://localhost:4000}
BACKEND=${BACKEND_URL:-http://localhost:3000}
PS5_URL=${PS5_URL:-https://www.game.es/PS5-DIGITAL-SLIM}
SHOE_URL=${SHOE_URL:-https://www.nike.com/es/t/air-max-90-zapatillas-hombre-r1Xg3K/CN8490-100}
RECORD=1; [ "${1:-}" = "--no-record" ] && RECORD=0
here=$(cd "$(dirname "$0")" && pwd)

box() { local w=78 line; printf '\n+%s+\n' "$(printf '%*s' $w '' | tr ' ' '-')"; for line in "$@"; do printf '| %-*s |\n' $((w-2)) "$line"; done; printf '+%s+\n' "$(printf '%*s' $w '' | tr ' ' '-')"; }
cue() { box "$@"; read -r -p ">>> press Enter when done  " _; echo; }
post() { local d=${2-}; [ -z "$d" ] && d='{}'; curl -s -X POST "$1" -H 'content-type: application/json' -d "$d"; }
active() { curl -s "$BACKEND/instructions" | jq '[.[] | select(.status=="ACTIVE")] | length' 2>/dev/null || echo 0; }

# 0. Preconditions
curl -s "$BACKEND/health" >/dev/null || { echo "backend not reachable at $BACKEND — run: npm run dev"; exit 1; }
curl -s "$MARKET/offers" >/dev/null || { echo "market not reachable at $MARKET — run: npm run dev"; exit 1; }
if ! grep -q "restock-agent/packages/extension" ~/Library/Application\ Support/Google/Chrome/*/Preferences 2>/dev/null; then
  box "AutoBuy does not look loaded in Chrome yet" "chrome://extensions → Developer mode ON → Load unpacked → $here/packages/extension" "then pin it: puzzle icon in the toolbar → pin AutoBuy"
  read -r -p ">>> press Enter once it is loaded (or if it already is)  " _
fi
post "$MARKET/admin/reset" >/dev/null; post "$BACKEND/admin/reset" >/dev/null
echo "market and backend state reset. Backend: $(curl -s $BACKEND/health | jq -r '"AI \(.ai), Stripe \(.stripe)"')"

# Live agent output in this terminal (the "quit Chrome, the agent keeps polling" beat).
LOG=""
for cand in "$here/backend.log" /private/tmp/claude-501/-Users-bradendavy/*/scratchpad/dev.log; do [ -f "$cand" ] && LOG=$cand; done
if [ -n "$LOG" ]; then tail -n 0 -f "$LOG" 2>/dev/null | grep --line-buffered -E '\] [A-Z_]{6,} |\[stripe|\[monitor\] tick' | sed -u 's/^\[backend\] /  agent │ /' & TAILPID=$!; trap 'kill $TAILPID 2>/dev/null' EXIT; else echo "(no backend log found to tail — keep the npm run dev terminal visible instead)"; fi

# 1. Recording
[ $RECORD = 1 ] && cue "START RECORDING" "Cmd-Shift-5 → 'Record Entire Screen' → Record. The file lands on the Desktop."

# 2. The environment beat: two real pages, controls change with the product
open "$SHOE_URL"
cue "SHOE PAGE is opening in Chrome" "Click the AutoBuy toolbar icon. The side panel reads the page:" "controls are Size (EU) / Colour / Width."
open "$PS5_URL"
cue "PS5 PAGE is opening" "The panel re-reads by itself: Edition / Storage / Colour." "Set: Digital, New, no bundles, max total 450, all three retailers, 30 days." "Click CREATE BUY ORDER and wait for 'Buy order is live'."
for i in $(seq 1 30); do [ "$(active)" != "0" ] && break; sleep 1; done
if [ "$(active)" = "0" ]; then box "No ACTIVE instruction yet. Click Create Buy Order, then press Enter."; read -r _; fi
curl -s "$BACKEND/instructions" | jq -r '.[] | select(.status=="ACTIVE") | "  order \(.id[0:8]) is ACTIVE — hold \(.stripe_payment_intent)"'

# 3. Quit Chrome. The agent keeps going in this terminal.
cue "QUIT CHROME (Cmd-Q). Watch this terminal: the agent is still polling every 3 s."

# 4. The market restocks, on cue
push() { post "$MARKET/admin/offers" "$1" >/dev/null; }
box "PUSHING OFFER A — store-a 'PS5 Slim Disc Edition + Spider-Man 2 bundle' EUR 430" "expect OFFER_REJECTED: edition disc ≠ digital, bundle not allowed"
push '{"id":"offer-a","retailer":"store-a","listing_title":"PS5 Slim Disc Edition + Spider-Man 2 bundle","price":430,"shipping":0,"currency":"EUR","condition":"new","in_stock":true,"url":"https://store-a.example/ps5-spiderman-bundle"}'; sleep 7
box "PUSHING OFFER B — store-b correct product EUR 445 + 15 shipping" "expect OFFER_REJECTED: 460.00 > 450.00"
push '{"id":"offer-b","retailer":"store-b","listing_title":"Sony PlayStation 5 Slim Digital Edition 1TB","price":445,"shipping":15,"currency":"EUR","condition":"new","in_stock":true,"url":"https://store-b.example/ps5-slim-digital"}'; sleep 7
box "PUSHING OFFER C — store-c correct product EUR 448 delivered" "expect QUALIFIED → LOCK → REVALIDATED → CHECKOUT_OK → PAYMENT_CAPTURED → PURCHASED + notification"
push '{"id":"offer-c","retailer":"store-c","listing_title":"PlayStation 5 Slim Digital Edition 1TB Console","price":448,"shipping":0,"currency":"EUR","condition":"new","in_stock":true,"url":"https://store-c.example/ps5-slim-digital"}'; sleep 8
curl -s "$BACKEND/instructions" | jq -r '.[] | "  \(.status)\(if .order then " — \(.order.total) \(.constraints.currency) from \(.order.retailer), order \(.order.merchant_order_id)" else "" end)"'

# 5. Back to Chrome: the trust story
open -a "Google Chrome" "$BACKEND/dashboard"
cue "DASHBOARD is opening in Chrome" "Click the PURCHASED card: every offer × every check, pass or fail, with the reason." "Scroll down for the timeline."
if [ $RECORD = 1 ]; then
  cue "STOP RECORDING: click the ■ stop icon in the menu bar (or Cmd-Ctrl-Esc)."
  sleep 2; f=$(ls -t ~/Desktop/Screen\ Recording*.mov 2>/dev/null | head -1)
  if [ -n "$f" ]; then mkdir -p "$here/docs"; cp "$f" "$here/docs/autobuy-demo-screen.mov"; box "SAVED: docs/autobuy-demo-screen.mov  ($(du -h "$f" | cut -f1))"; else box "Recording not found on the Desktop — check where macOS saved it."; fi
fi
box "DONE. Run ./stage.sh again for another take; it resets state each time."
