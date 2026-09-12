#!/usr/bin/env bash
# Compralo — P4 demo sequence. Fires every money beat against a running money.mjs.
#
# Fixtures 1 (EUR 219, previous generation) and 2 (EUR 244 sticker / EUR 282 true total)
# are rejected by P1's gate and never reach P4. This script covers the two that do,
# plus the release path.
set -euo pipefail
API=${API:-http://localhost:4242}
INST=${INST:-inst_demo_ps5}
j() { python3 -m json.tool; }

echo "== ARM: mandate ceiling EUR 250.00 =="
HOLD=$(curl -s $API/funds/commit -H 'content-type: application/json' \
  -d "{\"instruction_id\":\"$INST\",\"amount_cents\":25000,\"currency\":\"eur\"}" \
  | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d["hold_id"])')
curl -s $API/funds/$HOLD | j

echo
echo "== FIXTURE 4: EUR 465 offer. The payment layer refuses it. Our code never validated it. =="
curl -s $API/checkout -H 'content-type: application/json' \
  -d "{\"instruction_id\":\"$INST\",\"offer_id\":\"off_4\",\"hold_id\":\"$HOLD\",\"idempotency_key\":\"purchase_${INST}_off4\",\"total_cents\":46500}" | j

echo
echo "== FIXTURE 3: EUR 248 delivered, qualifies. EUR 2 released. =="
curl -s $API/checkout -H 'content-type: application/json' \
  -d "{\"instruction_id\":\"$INST\",\"offer_id\":\"off_3\",\"hold_id\":\"$HOLD\",\"idempotency_key\":\"purchase_${INST}\",\"total_cents\":24800}" | j

echo
echo "== DOUBLE-FIRE: same key on purpose. One purchase. =="
curl -s $API/checkout -H 'content-type: application/json' \
  -d "{\"instruction_id\":\"$INST\",\"offer_id\":\"off_3\",\"hold_id\":\"$HOLD\",\"idempotency_key\":\"purchase_${INST}\",\"total_cents\":24800}" | j

echo
echo "== RELEASE: a second instruction where nothing ever qualified =="
H2=$(curl -s $API/funds/commit -H 'content-type: application/json' \
  -d '{"instruction_id":"inst_expired","amount_cents":25000,"currency":"eur"}' \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["hold_id"])')
curl -s $API/funds/release -H 'content-type: application/json' \
  -d "{\"hold_id\":\"$H2\",\"reason\":\"deadline_expired\"}" | j
