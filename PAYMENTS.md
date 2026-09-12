# Compralo — P4 Money

**P4 owns this file.** It answers one question: how does the user commit money at arm time so the agent can spend it, bounded, hours later with nobody watching.

Decision is at the bottom of § 3. The 60-minute build is § 5. Everything before that is why.

---

## 1. Kill-switch report — T+0:15

Run against the real account (`acct_1TJZ9WRny0QxauVn`, test mode). Not from docs — from the API, today.

| Capability | Status | Consequence |
|---|---|---|
| **Issuing** (virtual cards) | ❌ `Your account is not set up to use Issuing` | "Give the agent a card" is **dead for today** |
| **Connect** (pay a merchant) | ❌ `You can only create new accounts if you've signed up for Connect` | Money cannot visibly flow to a "MediaMarkt" |
| **Manual capture** (auth/capture) | ✅ works, no setup | **This is the lane** |
| **Partial capture** | ✅ captured 24800 of 25000 | Pay the true price, auto-release the rest |
| **Over-mandate refusal** | ✅ `amount_too_large` | Beat T+2:30 is real, not an `if` |
| **Idempotency** | ✅ same key → same `ch_`, no second charge | Beat 6 is real |
| **Release** | ✅ `canceled`, received 0, capturable 0 | No lingering hold |
| **SCA failure path** | ✅ `authentication_required` reproducible on demand | `NEEDS_ATTENTION` is demonstrable |

Both enablement-gated options are gated behind a dashboard application with unknown latency. **Do not put either on the critical path.** Someone can click "enable Issuing" in the background; if it lands before T+3:00 it becomes a bonus slide, never a dependency.

> One flag for the team lead: this is Recala's **live** Stripe account. Everything here is test mode and reversible. Nobody touches `--live` today, for any reason.

---

## 2. The thesis

Every option below is really answering the same question, and it isn't "how do we hold money."

> **When does the user authenticate?**

That is the whole problem. Cards get challenged — 3D Secure, a banking-app tap, an SMS. You cannot legislate that away, and no payment product on earth guarantees it away.

So you don't fight it. You **move it**:

> **Authenticate at arm time, when the user is present and tapping a button. Never at buy time, when the user is asleep and the stock is gone in forty seconds.**

An architecture that authenticates at buy time has its single point of failure at the exact moment the product promise is being kept. That is the wrong place to put it, and it is the reason Option A is not our default despite being the obvious one.

Everything else — ledgers, balances, scoped cards — is bookkeeping around that one decision.

---

## 3. The options

| | Option | Money in | Ceiling enforced by | Setup cost | 1 hour? |
|---|---|---|---|---|---|
| A | Save card, charge off-session later | at buy time | your `if` | none | ⚠️ fragile |
| **B** | **Mandate hold (auth now, capture later)** | **at arm time** | **Stripe** | **none** | **✅ yes** |
| C | Charge upfront, refund if unfilled | at arm time | your `if` | none | ⚠️ bad UX |
| D | Pre-funded wallet balance | upfront top-up | your `if` | regulatory | ❌ no |
| E | Scoped virtual card (Issuing) | separate problem | the card network | account approval | ❌ blocked |
| F | Delegated agentic rails (scoped tokens) | at arm time | the network | partner onboarding | ❌ no |

### A — Save the card, charge off-session when stock appears

`SetupIntent` at arm time, `PaymentIntent` with `off_session: true` when the offer qualifies.

Genuinely attractive: nothing is locked, the UX is clean, and it is the standard architecture for subscriptions.

It fails on the thesis. We reproduced the failure on the account in one call:

```
code    : authentication_required
decline : authentication_required
message : Your card was declined. This transaction requires authentication.
```

Under PSD2 the first payment must be on-session to establish the mandate, and even then the issuer may challenge a later merchant-initiated one. That decline arrives **at the moment stock appears** — the one moment the product exists to survive. The user gets `NEEDS_ATTENTION` and a sold-out page.

Its second problem is quieter and worse for the pitch: the ceiling is a number in our own code. A judge asking "what stops you charging €5,000?" gets "we wrote an if statement." That is not an answer.

**Keep it as the roadmap answer for long deadlines.** Not the default.

### B — Mandate hold *(chosen)*

At arm time, authorize `max_total_cents`. At buy time, capture `true_total_cents`.

The authorization **is** the scoped credential. That is the insight that makes this more than a fallback:

- `amount` is the ceiling, held by Stripe, outside our process
- capture above it is refused by Stripe — `amount_too_large`, proven above
- capture below it takes exactly the true price and **auto-releases the difference**
- cancel releases everything, user made whole
- 3DS happens at arm time, on-session, where it costs nothing

That last bullet is the thesis, satisfied for free.

And the partial capture is quietly the best *product* behaviour in the whole system:

> You said up to €250. It cost €248 delivered. You were charged €248.

Nobody has to explain that sentence. It is the mandate, made visible in the user's bank app.

**The honest cost:** card authorizations expire. Stripe holds an uncaptured PaymentIntent for about **7 days**, and some issuers release sooner. A 30-day deadline does not fit inside one hold. Mitigations, in order of honesty:

1. Demo deadlines ≤ 7 days. The demo is a restock, not a 30-day wait.
2. Real product: re-authorize on a rolling schedule — cancel and re-auth before expiry, on the saved card.
3. Real product, properly: move to Option E once Issuing is enabled.

Say this out loud if a judge asks. "Seven days today, and here is the path to thirty" reads as engineering. Pretending it is unlimited reads as a bug you haven't found yet.

### C — Charge upfront and refund

Guaranteed funds, and that is the entire list of virtues. Refund fees on every unfilled instruction, money out of the user's account for a product they may never get, and you are now sitting on customer cash you have to account for. The product promise is "you lose nothing by arming this" and this option breaks it on day one.

**No.**

### D — Pre-funded wallet

Conceptually clean, and every consumer fintech eventually wants one.

Two problems. Holding user balances in the EU is regulated activity — e-money or payment-institution territory, with the authorisation and safeguarding that implies. That is a company decision, not a hackathon decision.

And it does not even buy what it looks like it buys: **pre-funding does not prevent the retailer's checkout from demanding authentication.** Money in your wallet and money that can move unattended at a merchant are two different facts. The readme already caught this — it is still true.

**No, and note the regulatory cost in the pitch so it reads as considered rather than missed.**

### E — Scoped virtual card — *the right long-term answer*

The agent gets a real card number whose ceiling lives in the credential:

```
spending_controls: {
  spending_limits: [{ amount: 25000, interval: 'per_authorization' }],
  allowed_categories: ['electronics_stores']
}
```

Amount, merchant category, use count, expiry — all enforced by the issuer and the network. The mandate stops being an application concept and becomes a payment-network fact. This is where the product goes.

Three reasons it is not today:

1. **Blocked.** `Your account is not set up to use Issuing.` Enablement latency unknown.
2. **It only solves money-out.** You still need a separate integration to collect from the user. A card is half an architecture.
3. **It does not dodge merchant authentication either.** A virtual card presented at a retailer can still be challenged. Option E is a better ceiling, not a magic unattended checkout.

Pitch it as the roadmap with the config block above on the slide. Specific beats aspirational.

### F — Delegated agentic rails

The direction the industry is actually moving: rather than the agent holding a card, the merchant is handed a **single-use token scoped to one purchase** — the agentic-commerce protocols and the card networks' agent programmes. The mandate travels with the payment credential and the merchant knows an agent is transacting.

Right answer, wrong decade for a hackathon: partner onboarding, merchant-side support, limited availability. Availability and terms move fast enough that you should check current state before putting specifics on a slide.

**One paragraph in the vision section. Zero lines of code today.**

---

## 4. The decision

> **Option B — the mandate hold.** Authorize `max_total_cents` at arm time. Capture `true_total_cents` at buy time. Cancel on every terminal state.

It is the only option that is simultaneously buildable in the hour, free of account enablement, and structurally honest about the ceiling.

### The three layers, and why a judge can see all of them

`BOARD.md` promises three independent things standing between the model and the user's money. This delivers all three, and the third one is not ours:

| Layer | Who | Demo evidence |
|---|---|---|
| Facts | P3 `/adjudicate` | "Mandatory add-on at checkout — true total €282" |
| Mandate | P1 the gate | ~40 lines, no model, shown on screen |
| **Ceiling** | **Stripe** | **`amount_too_large` — our code never ran** |

The fourth fixture exists only to prove the third row. When €465 is refused, the line in the log must be Stripe's error code, not our sentence. **If P4 ever validates the amount before calling Stripe, that beat is destroyed.** Send the over-mandate capture and let it fail. That is the point.

### One thing to say honestly

In this architecture, capturing the hold means **the user pays Compralo**. It does not mean Compralo paid MediaMarkt. Compralo is merchant of record for the order; the retailer-side purchase is stubbed today (Connect is off, and a real retailer checkout is out of scope per § Scope discipline).

If a judge asks, say exactly that. The defensible claim is the mandate architecture, and it is a strong one. Do not fake a merchant confirmation you cannot back — one unanswerable follow-up costs more than the beat was worth.

---

## 5. The 60 minutes

| Min | Do |
|---|---|
| 0–5 | `STRIPE_SECRET_KEY` from the test profile. `npm i stripe express`. Assert the key starts `sk_test_`. |
| 5–15 | `POST /funds/commit` — PaymentIntent, `capture_method: manual`, `amount = max_total_cents`. Return `hold_id` + `client_secret`. |
| 15–25 | `POST /checkout` — capture `amount_to_capture = true_total_cents` with the idempotency key. Map Stripe errors to the four contract statuses. |
| 25–32 | `POST /funds/release` — cancel. Wire it to every terminal state with P1. |
| 32–42 | Run all four fixtures end to end. €219, €282, €248, €465. |
| 42–52 | The decision log line per fixture. **This is what judges actually read.** |
| 52–60 | Run the sequence twice clean. Then stop. |

Everything in `p4/money.mjs`, already written and verified against the account — see § 7.

**Done when:** a judge sees the committed amount, sees €465 refused with Stripe's own error code, sees €248 captured against a €250 ceiling with €2 released, and sees the hold vanish when nothing qualifies.

---

## 6. Contract notes for P1 — settle at T+0:30

Three things, all small, all cheaper now than at T+3:00.

1. **`/checkout` needs the amount.** `CONTRACTS.md` passes `offer_id` only, so P4 must read `offers.total_cents`. Until P1's DB is up, `money.mjs` accepts an **optional** `total_cents` in the body and prefers the DB when present. Additive, not a contract change — but P1 confirms it in writing.

2. **`expires` in the commit response is real and it is ~7 days.** Not decorative. P1's checker should stop watching and release when it passes, and the dashboard should show it.

3. **The idempotency key must be stable across retries.** `purchase_{instruction_id}` is the right shape — derived from the instruction, not generated per attempt. A key generated at call time is not idempotency, it is a second charge with extra steps. `purchases.idempotency_key UNIQUE` is the backstop; Stripe's header is the primary.

---

## 7. Files

- `p4/money.mjs` — the three endpoints. Runnable. Verified against `acct_1TJZ9WRny0QxauVn` in test mode.
- `p4/fixtures.sh` — fires all four demo fixtures at a running instance.

---

## 8. Deferred, deliberately

Not today, and each has a one-line answer if asked:

- **Retailer checkout.** Out of scope; we are merchant of record for the order.
- **Deadlines beyond 7 days.** Rolling re-authorization, or Issuing.
- **Holding user balances.** Regulated activity; the hold model avoids it entirely.
- **Automating a real retailer's checkout.** Against most retailers' terms, and fragile enough to lose a demo. The readme already ruled it out. Still ruled out.
