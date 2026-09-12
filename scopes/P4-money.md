# P4 — Money

Committing the user's money at arm time so the agent can spend it, bounded, hours later with nobody watching.

**The decision and the build plan live in [PAYMENTS.md](../PAYMENTS.md) — P4's own doc, and authoritative.** This file is only the boundary: what you own, what you must not build, and what the other three depend on you for.

---

## Decision as of T+0:15

Kill-switch answered against the real account. Issuing ❌, Connect ❌, manual capture ✅.

> **Option B — the mandate hold.** Authorize `max_total_cents` at arm time. Capture `true_total_cents` at buy time. Cancel on every terminal state.

The authorization **is** the scoped credential. Stripe refuses a capture above it (`amount_too_large`), captures below it take the true price and auto-release the rest, and 3DS lands at arm time when the user is present rather than at buy time when they are asleep. This is better than the Issuing plan it replaced, and it needs no account enablement.

---

## Owns

- `POST /funds/commit` — the hold, one tap
- `POST /checkout` — capture at the true price, with idempotency
- `POST /funds/release` — cancel, wired to every terminal state
- Mapping Stripe errors to the four contract statuses
- The decision-log line per outcome
- The `NEEDS_ATTENTION` path when authentication is required

## Does NOT own

- **Deciding an offer qualifies.** P1's gate.
- **Product identity or true cost.** P3.
- **When to buy.** You execute what you are handed.
- **Retailer-side checkout.** Out of scope today — we are merchant of record for the order, and PAYMENTS.md § 4 has the sentence to say if a judge asks.

> **Boundary rule: never validate the amount before calling Stripe.** Send the over-mandate capture and let it fail. `amount_too_large` coming back from Stripe *is* the demo beat — an `if` in your code that pre-empts it destroys the only evidence that the ceiling is enforced outside our process.

---

## Consumes

| From | What | Contract |
|------|------|----------|
| P1 | mandate: instruction, amount, deadline | `POST /funds/commit` |
| P1 | qualified offer + stable idempotency key | `POST /checkout` |
| P1 | terminal state transitions | `POST /funds/release` |

## Produces

| For | What | Due |
|-----|------|-----|
| Everyone | Kill-switch answer | ✅ **done at T+0:15** |
| P2 | committed amount + ceiling to show on arm | T+1:00 |
| P1 | `hold_id`, `expires`, checkout result | T+1:30 |

---

## Three things P1 must confirm in writing at T+0:30

From PAYMENTS.md § 6, now reflected in `CONTRACTS.md`:

1. **`/checkout` carries `total_cents`.** Optional in the body, DB preferred when present. Additive.
2. **`expires` is real and it is ~7 days.** Not decorative — the checker must stop and release when it passes, and the dashboard must show it. **Demo deadlines must be ≤ 7 days.**
3. **The idempotency key is `purchase_{instruction_id}`** — derived from the instruction, stable across retries. A key generated per attempt is not idempotency; it is a second charge with extra steps.

---

## Done when

A judge sees the committed amount, sees €465 refused with **Stripe's own error code**, sees €248 captured against a €250 ceiling with €2 released, and sees the hold vanish when nothing qualifies.
