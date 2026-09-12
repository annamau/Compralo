#!/usr/bin/env bash
# AutoBuy demo driver. The operator never types a curl on stage.
#
#   ./demo.sh reset             wipe market + backend state (do this BEFORE creating the order)
#   ./demo.sh order             create the hardcoded PS5 buy order via curl (checkpoint runs / second run)
#   ./demo.sh                   reset the market only, then push offers A, B, C, D one per Enter
#   ./demo.sh --mismatch-first  same, ordered A, B, D (price mismatch), C — one mandate shows every path
#
set -u
MARKET=${MARKET_URL:-http://localhost:4000}
BACKEND=${BACKEND_URL:-http://localhost:3000}

box() {  # box "line 1" "line 2" ...
  local w=78 line
  printf '\n+%s+\n' "$(printf '%*s' $w '' | tr ' ' '-')"
  for line in "$@"; do printf '| %-*s |\n' $((w-2)) "$line"; done
  printf '+%s+\n\n' "$(printf '%*s' $w '' | tr ' ' '-')"
}
post() { local d=${2-}; [ -z "$d" ] && d='{}'; curl -s -X POST "$1" -H 'content-type: application/json' -d "$d"; }

OFFER_A='{"id":"offer-a","retailer":"store-a","listing_title":"PS5 Slim Disc Edition + Spider-Man 2 bundle","price":430,"shipping":0,"currency":"EUR","condition":"new","in_stock":true,"url":"https://store-a.example/ps5-spiderman-bundle"}'
OFFER_B='{"id":"offer-b","retailer":"store-b","listing_title":"Sony PlayStation 5 Slim Digital Edition 1TB","price":445,"shipping":15,"currency":"EUR","condition":"new","in_stock":true,"url":"https://store-b.example/ps5-slim-digital"}'
OFFER_C='{"id":"offer-c","retailer":"store-c","listing_title":"PlayStation 5 Slim Digital Edition 1TB Console","price":448,"shipping":0,"currency":"EUR","condition":"new","in_stock":true,"url":"https://store-c.example/ps5-slim-digital"}'
OFFER_D='{"id":"offer-d","retailer":"store-a","listing_title":"PlayStation 5 Slim Digital Edition 1TB","price":440,"shipping":0,"currency":"EUR","condition":"new","in_stock":true,"checkout_total":470,"url":"https://store-a.example/ps5-slim-digital"}'

case "${1:-run}" in
  reset)
    post "$MARKET/admin/reset" >/dev/null && echo "market  reset: 3 seeded listings, all out of stock"
    post "$BACKEND/admin/reset" >/dev/null && echo "backend reset: 0 instructions, 0 events"
    box "CLEAN SLATE" "Now create a Buy Order (side panel, or ./demo.sh order), quit Chrome, then ./demo.sh"
    exit 0 ;;
  order)
    if date -v+30d >/dev/null 2>&1; then DEADLINE=$(date -u -v+30d +%Y-%m-%dT%H:%M:%SZ); else DEADLINE=$(date -u -d '+30 days' +%Y-%m-%dT%H:%M:%SZ); fi
    BODY='{"product":{"name":"Sony PlayStation 5 Slim Digital Edition 1TB","category":"games_console","brand":"Sony","identifiers":{"model":"CFI-2016"},"attributes":{"edition":"digital","storage":"1TB","colour":"white"},"listed_price":449.99,"currency":"EUR","in_stock":false},'
    BODY+='"constraints":{"max_total":450,"currency":"EUR","quantity":1,"condition":"new","approved_retailers":["store-a","store-b","store-c"],"deadline":"'"$DEADLINE"'","variant":{"edition":"digital","storage":"1TB"},"allow_bundles":false}'
    [ "${2:-}" = "3ds" ] && BODY+=',"payment_method":"pm_card_authenticationRequired"'
    BODY+='}'
    OUT=$(post "$BACKEND/instructions" "$BODY")
    echo "$OUT" | jq -r '"instruction \(.id)  status \(.status)  hold \(.stripe_payment_intent)"' 2>/dev/null || echo "$OUT"
    exit 0 ;;
  --mismatch-first) ORDER=(A B D C) ;;
  run) ORDER=(A B C D) ;;
  *) echo "usage: ./demo.sh [reset | order [3ds] | run | --mismatch-first]"; exit 1 ;;
esac

post "$MARKET/admin/reset" >/dev/null || { echo "market not reachable at $MARKET — is npm run dev running?"; exit 1; }
ACTIVE=$(curl -s "$BACKEND/instructions" | jq '[.[] | select(.status=="ACTIVE")] | length' 2>/dev/null || echo 0)
box "AUTOBUY MARKET SIMULATOR — sequence ${ORDER[*]}" "market reset (3 listings, all out of stock); backend has $ACTIVE ACTIVE instruction(s)" "Press Enter to push each offer. Watch the backend terminal."
[ "$ACTIVE" = "0" ] && echo "!! no ACTIVE instruction — create one first (side panel or ./demo.sh order)"

for step in "${ORDER[@]}"; do
  case $step in
    A) label="OFFER A  store-a  'PS5 Slim Disc Edition + Spider-Man 2 bundle'  EUR 430 + 0"; expect="expect OFFER_REJECTED — edition disc ≠ digital, bundle not allowed"; body=$OFFER_A ;;
    B) label="OFFER B  store-b  'Sony PlayStation 5 Slim Digital Edition 1TB'  EUR 445 + 15 ship"; expect="expect OFFER_REJECTED — 460.00 > 450.00"; body=$OFFER_B ;;
    C) label="OFFER C  store-c  'PlayStation 5 Slim Digital Edition 1TB Console'  EUR 448 delivered"; expect="expect QUALIFIED → LOCK → REVALIDATED → CHECKOUT_OK → PAYMENT_CAPTURED → PURCHASED + notification"; body=$OFFER_C ;;
    D) label="OFFER D  store-a  'PlayStation 5 Slim Digital Edition 1TB'  EUR 440 listed, 470 at checkout"
       if [ "${ORDER[*]}" = "A B D C" ]; then expect="expect QUALIFIED → LOCK → REVALIDATED → CHECKOUT_PRICE_MISMATCH (470 ≠ 440) → back to ACTIVE, nothing captured"
       else expect="expect NOTHING — mandate already PURCHASED; one order per instruction (./demo.sh --mismatch-first shows this path)"; fi
       body=$OFFER_D ;;
  esac
  read -r -p "[Enter] push $step  " _
  post "$MARKET/admin/offers" "$body" >/dev/null
  box "PUSHED  $label" "$expect"
done
box "SEQUENCE DONE" "Reopen Chrome → http://localhost:3000/dashboard for the decision history."
