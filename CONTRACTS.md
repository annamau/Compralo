# Compralo — Contracts

**P1 owns this file.** Everyone else codes against it. Changes after the freeze times in [BOARD.md](BOARD.md) need all four to agree.

Rules that keep the parts joinable:

- **Money is integer cents.** Never a float, anywhere, in any language.
- **`total_cents` always means delivered, all-in.** A price without shipping is not a price.
- **The model returns facts. Code returns decisions.** `/adjudicate` never says "buy" — it says what the thing is and what it truly costs.
- **Every write that can spend money carries an idempotency key.**

---

## Auth

Freeze at **T+0:30**. P1 and P2 both blocked until this is written down.

```
Authorization: Bearer <token>
```

Every request except login. The backend resolves `user_id` from the token — the client never sends `user_id` in a body. Queue items, balances and instructions are all attributed server-side.

```
POST /auth/login      { email }              → { token, user_id }
GET  /auth/me         —                      → { user_id, email }
```

Whatever you use for tokens, decide the expiry now and make the extension handle a 401 by re-prompting rather than silently failing.

---

## State machine

```
DRAFT → ARMED → EVALUATING → EXECUTING → PURCHASED
                     ↑____________|
                (offer rejected, keep watching)

Exits: NEEDS_ATTENTION · FAILED · EXPIRED · CANCELLED
```

- Only `EXECUTING` holds the lock, and an instruction may enter it **exactly once**.
- Every terminal state releases committed funds, revokes spend authority, and cancels outstanding checks.
- If checkout times out, verify with the merchant whether an order exists **before any retry**. A double purchase is the one bug that turns a demo into an apology.

---

## Schema

Owned by P1. P3 writes `candidates`, `offers`, `verdicts`. P4 writes `holds`, `purchases`.

```sql
users          id · email · created_at

instructions   id · user_id · status · canonical jsonb · constraints jsonb
               max_total_cents · currency · deadline · quantity · created_at

candidates     id · instruction_id · retailer · url · ean · mpn
               match_confidence · source ('page' | 'exa') · created_at

offers         id · instruction_id · candidate_id · retailer · url
               price_cents · shipping_cents · total_cents · currency
               seller · condition · raw jsonb · seen_at

verdicts       id · offer_id · verdict · reason · resolved jsonb
               confidence · decided_at

holds          id · user_id · instruction_id · amount_cents
               status ('committed' | 'spent' | 'released') · created_at

purchases      id · instruction_id · offer_id · total_cents · order_ref
               idempotency_key UNIQUE · created_at

notifications  id · user_id · instruction_id · kind · channel · sent_at
```

`purchases.idempotency_key` being UNIQUE is the last line of defence against a double buy. Do not drop it.

---

## P3 — Intelligence

### POST /understand

Screenshot in, product understanding out. The expensive call — made once per product, then cached.

```
req  { url, screenshot_b64, dom_hints: { title, price, jsonld } }

res  { canonical: { name, brand, model, generation, category,
                    variant_axes: { ... },
                    identifiers: { ean?, gtin?, mpn? } },
       listing:   { retailer, price_cents, shipping_cents, total_cents,
                    currency, condition, seller_type },
       constraint_schema: [ { key, label, type, options?, default } ],
       confidence: 0.0–1.0 }
```

`constraint_schema` drives P2's UI. `type` is one of `enum` · `bool` · `money` · `date` · `int`. P2 renders generically and must never branch on `key`.

### POST /discover

Exa semantic search for the same product elsewhere.

```
req  { canonical, currency, region }

res  { candidates: [ { retailer, url, ean?, mpn?,
                       match_confidence: 0.0–1.0,
                       why: "same EAN" | "title+spec match" } ] }
```

Identifiers beat inference. When an EAN matches, confidence is 1.0 and the model isn't consulted.

### POST /adjudicate

One offer, one verdict. **Facts only.**

```
req  { instruction_id, offer_id }

res  { verdict: "QUALIFIES" | "REJECTED",
       reason:  "Previous generation — this listing is the prior model",
       resolved: { is_same_product, true_total_cents,
                   hidden_costs: [ { label, amount_cents } ],
                   condition, seller_ok },
       confidence: 0.0–1.0 }
```

`reason` is shown to the user verbatim and read aloud on stage. It must sound like a sharp friend catching a near-miss, not a validation error.

---

## P1 — Core

```
POST /instructions          create + arm
  req  { canonical, constraints, max_total_cents, currency,
         deadline, quantity, retailers[] }
  res  { instruction_id, status: "ARMED", funds: { committed_cents, expires } }

GET  /instructions          the user's watch list
  res  { instructions: [ { id, canonical, status, max_total_cents,
                           deadline, last_checked_at } ] }

GET  /instructions/:id      everything the dashboard renders
  res  { status, mandate, funds,
         offers: [ { retailer, total_cents, verdict, reason, at } ],
         purchase?: { total_cents, retailer, order_ref, at } }

POST /instructions/:id/cancel
  res  { status: "CANCELLED", released_cents }

POST /offers                checker worker → normalized offer
  req  { instruction_id, candidate_id, retailer, url, raw_text,
         price_cents, shipping_cents, currency, seller, condition }
  res  { offer_id, queued: true }
```

### The gate

Runs **after** `/adjudicate`, never inside it. No model.

```
verdict == QUALIFIES
AND resolved.is_same_product
AND resolved.true_total_cents <= instruction.max_total_cents
AND retailer IN instruction.retailers
AND resolved.condition IN instruction.constraints.condition
AND now() < instruction.deadline
AND instruction.status == ARMED
AND no purchase exists for this instruction
→ acquire lock → EXECUTING
```

Three independent layers stand between the model and the user's money: the model resolves facts, the gate applies the mandate, the payment layer enforces the ceiling. A judge should be able to see all three.

---

## P4 — Money

```
POST /funds/commit          the mandate hold — ONE TAP
  req  { instruction_id, amount_cents, currency }
  res  { hold_id, client_secret, status: "committed", expires }

POST /funds/release
  req  { hold_id, reason }
  res  { status: "released", amount_cents }

POST /checkout              capture the hold at the true price
  req  { instruction_id, offer_id, hold_id, idempotency_key,
         total_cents? }          ← optional; DB preferred when present
  res  { status: "PURCHASED" | "NEEDS_ATTENTION" | "DECLINED" | "FAILED",
         order_ref?, total_cents?, decline_reason? }
```

**Decided at T+0:15 — see [PAYMENTS.md](PAYMENTS.md).** Issuing and Connect are unavailable on the account; the model is a **mandate hold**: authorize `max_total_cents` at arm time, capture `true_total_cents` at buy time, cancel on every terminal state. The authorization is the scoped credential.

Three consequences everyone codes against:

- **`expires` is real and it is ~7 days.** Card authorizations do not last thirty days. The checker must stop and release when it passes, the dashboard must show it, and **demo deadlines must be ≤ 7 days.**
- **`idempotency_key` is `purchase_{instruction_id}`** — derived from the instruction, stable across retries. A key generated per attempt is not idempotency. Same key twice returns the **first** result; it never buys twice.
- **`DECLINED` comes from the payment layer, never from our validation.** P4 sends the over-mandate capture and lets Stripe refuse it with `amount_too_large`. An `if` that pre-empts that call destroys the only evidence the ceiling is enforced outside our process. Keep the two paths visibly distinct in the log.

Capturing the hold means the user paid Compralo. It does not mean Compralo paid the retailer — retailer-side checkout is out of scope today and we are merchant of record for the order. Say that plainly if asked rather than faking a merchant confirmation.

---

## Mocks

P1 publishes these at T+0:15 and P3 at T+0:20, before either writes real code. Three people build against them immediately.

Put them in `mocks/` as flat JSON named after the endpoint: `mocks/understand.json`, `mocks/discover.json`, `mocks/adjudicate.json`, `mocks/instructions.json`. Point every client at a `MOCK=1` env flag and flip it off at the freeze.

---

## Demo fixtures

The three offers the demo turns on. Keep them in `fixtures/offers.json` so anyone can replay the sequence without waiting for a real restock.

| # | Sticker | Expected | Why |
|---|---------|----------|-----|
| 1 | €219 | REJECTED | Previous generation under a near-identical title |
| 2 | €244 | REJECTED | Mandatory add-on at checkout — true total €282 |
| 3 | €248 | QUALIFIES | Correct variant, approved seller, delivered within limit |
| 4 | €465 | DECLINED | Over the €250 ceiling — refused by Stripe, `amount_too_large` |

Fixture 4 exists only to be refused by the payment layer. It is the last beat of the demo — do not let it be refused by application code. `p4/fixtures.sh` fires all four at a running instance.
