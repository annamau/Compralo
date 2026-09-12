#!/usr/bin/env bash
# Compralo — P4 demo sequence. Fires every money beat against a running money.mjs.
#
# Fixtures 1 (EUR 219, previous generation) and 2 (EUR 244 sticker / EUR 282 true total)
# are rejected by P1's gate and never reach P4. This script covers the ones that do:
# the two from CONTRACTS.md, plus two retailer-side failures Zinc's sandbox rehearses.
set -euo pipefail
API=${API:-http://localhost:4242}
INST=${INST:-inst_demo_ps5}
j() { python3 -m json.tool; }

Z=https://zinc.com/shop/products
arm() { curl -s $API/funds/commit -H 'content-type: application/json' \
  -d "{\"instruction_id\":\"$1\",\"amount_cents\":25000,\"currency\":\"eur\"}" \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["hold_id"])'; }
buy() { # buy <inst> <hold> <offer_id> <key> <url> <total_cents>
  curl -s $API/checkout -H 'content-type: application/json' -d "{
    \"instruction_id\":\"$1\",\"offer_id\":\"$3\",\"hold_id\":\"$2\",\"idempotency_key\":\"$4\",
    \"offer\":{\"url\":\"$5\",\"retailer\":\"amazon\",\"total_cents\":$6}}" | j; }

echo "== ARM: mandate ceiling EUR 250.00 =="
HOLD=$(arm $INST); curl -s $API/funds/$HOLD | j

echo; echo "== FIXTURE 4: EUR 465 offer. Stripe refuses it. Zinc is never called. =="
buy $INST $HOLD off_4 "purchase_${INST}_off4" $Z/test-success 46500

echo; echo "== FIXTURE 3: EUR 248 delivered, qualifies. Stripe captures, Zinc buys, EUR 2 released. =="
buy $INST $HOLD off_3 "purchase_${INST}" $Z/test-success 24800

echo; echo "== DOUBLE-FIRE: same key on purpose. One purchase. =="
buy $INST $HOLD off_3 "purchase_${INST}" $Z/test-success 24800

echo; echo "== BONUS A: sold out between the check and the buy. Refunded. =="
H=$(arm ${INST}_oos); buy ${INST}_oos $H off_5 "purchase_${INST}_oos" $Z/test-out-of-stock 24800

echo; echo "== BONUS B: retailer price jumped after we committed. Zinc's own ceiling refuses. Refunded. =="
H=$(arm ${INST}_px); buy ${INST}_px $H off_6 "purchase_${INST}_px" $Z/test-price-exceeded 24800

echo; echo "== RELEASE: nothing ever qualified =="
H=$(arm ${INST}_expired)
curl -s $API/funds/release -H 'content-type: application/json' -d "{\"hold_id\":\"$H\",\"reason\":\"deadline_expired\"}" | j

echo; echo "== COVERAGE =="; curl -s $API/coverage | j
