# Compralo — P4 Money

**P4 owns this file.** It answers one question: how does the user commit money at arm time so the agent can spend it, bounded, hours later with nobody watching.

Money in is decided in § 4. Money out — how the order actually gets placed at the retailer — is § 9–11. **P1, P2, P3: your asks are in § 12.** Everything else is why.

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

Capturing the hold means **the user pays Compralo**. The retailer is paid separately — by a checkout aggregator buying with its own accounts (§ 9). Compralo is the seller to the consumer; the aggregator is the buyer at the retailer. Two payments, three parties, and the user's card is only ever touched by us, on-session, at arm time.

If a judge asks who bought it at Amazon, say exactly that. Do not claim a retailer integration you cannot back — one unanswerable follow-up costs more than the beat was worth.

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

Everything in `money/money.mjs`, already written and verified against the account — see § 7.

**Done when:** a judge sees the committed amount, sees €465 refused with Stripe's own error code, sees €248 captured against a €250 ceiling with €2 released, and sees the hold vanish when nothing qualifies.

---

## 6. Contract notes for P1 — settle at T+0:30

Three things, all small, all cheaper now than at T+3:00.

1. **`/checkout` needs the amount.** `CONTRACTS.md` passes `offer_id` only, so P4 must read `offers.total_cents`. Until P1's DB is up, `money.mjs` accepts an **optional** `total_cents` in the body and prefers the DB when present. Additive, not a contract change — but P1 confirms it in writing.

2. **`expires` in the commit response is real and it is ~7 days.** Not decorative. P1's checker should stop watching and release when it passes, and the dashboard should show it.

3. **The idempotency key must be stable across retries.** `purchase_{instruction_id}` is the right shape — derived from the instruction, not generated per attempt. A key generated at call time is not idempotency, it is a second charge with extra steps. `purchases.idempotency_key UNIQUE` is the backstop; Stripe's header is the primary.

---

## 7. Files

- `money/money.mjs` — the three endpoints. Runnable. Verified against `acct_1TJZ9WRny0QxauVn` in test mode.
- `money/fixtures.sh` — fires all four demo fixtures at a running instance.

---

## 8. Deferred, deliberately

Not today, and each has a one-line answer if asked:

- **Our own retailer accounts and automation.** That is a company (§ 9), not a lane. We buy through one.
- **Deadlines beyond 7 days.** Rolling re-authorization, or Issuing.
- **Holding user balances.** Regulated activity; the hold model avoids it entirely.
- **Sanctioned agent checkout (Shopify UCP, Stripe SPT).** Invite-only today. The destination, on a slide.
- **Returns and warranty.** We are the seller to the consumer; they land on us. One line, not today.

---

## 9. Money out — buying through an aggregator

The model, in one line:

> **The user shops where they already shop. Compralo owns the loop, the judgment, and the money. The aggregator owns the click at the retailer.**

Extension on the retailer page → instruction + hold → our checker watches → our gate judges → Stripe enforces the ceiling → **Zinc / CartAI / Rye** places the order with *their* account → we confirm to the user. The retailer never sees us. The user never sees the aggregator.

### Why they can buy and we can't

Not a permission — each of them *is* the thing we would otherwise have to build:

- **A pool of retailer accounts.** Zinc runs its own Amazon accounts with payment methods, address books and purchase history that look like normal buyers. Months to build, against Amazon's terms, and they eat the bans.
- **Per-retailer automation someone re-fixes daily.** Checkouts move; bot detection is a product category. Rye's ">90% reliability, <35 s any-store resolution" is years of work.
- **Their own money at the retailer.** Business cards on established accounts — no 3DS, no fresh-card-on-fresh-session fingerprint. We have no such card (Issuing is off), and a new card on a new account is the exact pattern retailers flag.
- **Risk priced in.** Cancellations, mid-checkout price changes, chargebacks — absorbed and reflected in $0.05/order or a wallet.

Buying against retailers' wishes at scale is their whole company. We buy *through* them in one call, or spend months becoming them. It is also why Shopify and Stripe are building the sanctioned door (UCP / ACP) — invite-only today, the destination tomorrow.

### The consequence nobody should miss

**We can only auto-buy where the aggregator can buy.** An instruction on an uncovered retailer is a stock alert, not an order. P4 publishes coverage; P1 and P3 respect it (§ 12).

---

## 10. The money, end to end

```
CUSTOMER ──① hold max_total  (arm · one tap · 3DS here)──────▶ COMPRALO / Stripe
COMPRALO ──② capture true_total  (buy · Stripe enforces ceiling)
COMPRALO ──③ prefunded wallet / card on file─────────────────▶ AGGREGATOR
AGGREGATOR ─④ buys with its own account and card─────────────▶ RETAILER
RETAILER ──⑤ ships to the address collected at arm time──────▶ CUSTOMER
```

Decisions this fixes:

- **Prepayment stays the mandate hold.** Customer sees "Compralo €250 pending," pays nothing until a purchase happens. Nothing qualifies → the hold releases. **No refund fee.** That is the quiet advantage over charge-upfront.
- **Capture the aggregator's landed quote, not the sticker.** Zinc and Rye return true delivered cost before confirm. Quote → capture → order. Over the mandate, Stripe refuses at capture and **the aggregator is never called.** Zinc's `max_price` is a second, independent ceiling on the order itself.
- **Compralo carries float.** Capture settles to our Stripe balance in days; the aggregator wants its wallet funded now. Working capital ≈ in-flight orders. Trivial today; the number to know on stage.
- **Compralo is the seller to the consumer.** Returns and warranty land on us.

Failure paths, all of which must reach the user with a sentence:

| When | What happens | State |
|---|---|---|
| Nothing qualifies before deadline | hold released | `EXPIRED` |
| Hold hits ~7 days before stock | ask user to re-arm | `NEEDS_ATTENTION · hold_expired` |
| Quote > mandate | Stripe refuses capture, no order | `DECLINED · amount_too_large` |
| Captured, aggregator order fails | refund capture | `FAILED` |
| Retailer cancels after purchase | refund capture | `REFUNDED` |

---

## 11. Every path, with links

| Path | Status | Start | Docs |
|---|---|---|---|
| **Zinc** — Amazon US/UK/DE/FR/CA/MX, Best Buy, Walmart, Home Depot, hundreds in beta | ✅ **open, no signup** | [Agent sandbox](https://www.zinc.com/docs/v2/agent-sandbox/overview.md) | [Retailers](https://www.zinc.com/docs/v1/supported-retailers.md) · [Docs](https://www.zinc.com/docs) |
| **CartAI** — verified live US stores (Polaroid, Turtle Beach, Levi's, REI…) | ✅ open, self-serve | [Signup](https://portal.cartai.ai/signup) | [Intro](https://docs.cartai.ai/docs/introduction) · [Merchants](https://docs.cartai.ai/docs/sample-merchants-to-get-started.md) · [Create checkout](https://docs.cartai.ai/reference/create-checkout-task.md) |
| **Rye** — 15k merchants, Amazon NA, US shipping only | ✅ open, console signup | [Console](https://console.rye.com/login) | [Quickstart](https://rye.com/docs/api-v2/example-flows/simple-checkout) · [FAQ](https://rye.com/docs/faq) · [Pricing](https://rye.com/pricing) |
| Shopify UCP `complete_checkout` | ❌ case-by-case, no application | [Agents](https://shopify.dev/docs/agents) | [Auth tiers](https://shopify.dev/docs/agents/profiles/auth-and-rate-limiting) |
| Stripe Link CLI / Shared Payment Tokens | ❌ private preview | [Waitlist](https://go.stripe.global/agentic-commerce-contact-sales) | [For agents](https://docs.stripe.com/agentic-commerce/for-agents) |
| WebMCP | ❌ not a checkout path — needs an active tab, no shops ship it, demos exclude `place_order` | | [Guide](https://freshman.tech/webmcp/) |
| Retailer DOM automation with the user's session | ⚠️ works with the laptop open on a lax shop; ToS-hostile; no help with the anti-bot side | | |

**Pick:** Zinc for the demo (zero signup, Amazon.de is a real EU listing, a decade of doing this). CartAI second (real Shopify stores, `payment.provider: "test"`).

Mint a sandbox key — no account, no personal data:

```bash
curl -s -X POST https://api.zinc.com/sandbox/keys | python3 -m json.tool
```

Sandbox orders are fake; keys expire after 7 idle days. Production: Zinc ships from amazon.de/fr to Spain plausibly — verify before promising it.

---

## 12. Asks

Paste these. Each is one message.

### To P1 — endpoints

1. **Shipping and contact live on the instruction.** `POST /instructions` req gains `shipping: { name, email, phone, line1, line2?, city, province, postal_code, country }`; schema gains `instructions.shipping jsonb`. No aggregator places an order without it.
2. **`/checkout` goes async.** Aggregators take 5–60 s (Rye polls 5 s × 120). Proposal: `POST /checkout → 202 { status: "EXECUTING", task_id }`, then P4 calls back `POST /instructions/:id/purchase-result { status, order_ref?, total_cents?, released_cents?, decline_reason? }`. P1 holds the lock until the callback. If you'd rather poll `GET /checkout/:task_id`, say so by T+2:00.
3. **`/checkout` req carries the offer facts.** `offer: { url, retailer, total_cents }`. Aggregators need the product URL and retailer code; P4 should not read the offers table under lock.
4. **Two new states.** `REFUNDED` (retailer cancels after `PURCHASED`; P4 refunds and calls back) and `NEEDS_ATTENTION` with `reason: "hold_expired"` when `funds.expires` passes before stock, plus `POST /instructions/:id/rearm` → a fresh `/funds/commit` **carrying `attempt: n`** — the commit idempotency key must change or you get the old hold back.
5. **The checker stops and releases at `funds.expires`.** Restated because it now has a re-arm path behind it.
6. **Coverage.** P4 exposes `GET /coverage → { retailers: ["amazon", "amazon_de", "bestbuy", …] }`. Filter `retailers[]` against it at `POST /instructions`. A watch nobody can buy from is a stock alert.
7. **The demo restock.** `POST /demo/restock { instruction_id }` replays fixture #3 into the checker. The presenter fires it from a phone with the laptop closed — that *is* the scheduled restock, and it is the beat the whole demo is built around.

### To P2 — the UI

1. **Arm screen collects shipping + contact once**, saved to the profile, prefilled forever after. Name, email, phone, address, country. The only extra form, and only the first time.
2. **Payment is the Stripe Payment Element in the panel**, confirming `client_secret` from `/funds/commit`. Copy: *"Holding up to €250. You're charged only what it actually costs."* 3DS may pop here — that is the intended place. Don't hide it.
3. **Confirmation card:** committed amount · ceiling · expires (countdown, 7 d) · *"charged nothing until it's bought"* · **Cancel** (releases).
4. **States to render:** `ARMED` (hold + expiry) · `EXECUTING` (*"Buying at amazon.de…"* — 5–60 s, never a spinner on an empty card) · `PURCHASED` (retailer, order_ref, *"You said €250. It cost €248. You paid €248."*) · `DECLINED` (Stripe's reason verbatim, with a **refused by payment layer** badge) · `NEEDS_ATTENTION` (`hold_expired` → **Re-arm**) · `FAILED` / `REFUNDED`.
5. **The decision log:** the €465 line must look *different* from gate rejections. That is the money shot, and it is your pixels.
6. **The web dashboard shows all of it with the browser closed.** BOARD Gap #1.

### To P3 — one line

`/discover` tags each candidate `buyable: true|false` from P4's coverage and ranks buyable ones first.

---

## 13. Wired — what runs today

`cd p4 && npm start` boots against two **sandbox** keys in `p4/.env` (gitignored; the service refuses any other kind). `bash fixtures.sh` replays every money beat. From the run on 12 Sep:

| Beat | Result |
|---|---|
| Arm €250 | hold committed, expires in 7 d |
| €465 offer | `DECLINED · amount_too_large · enforced_by: stripe` — **Zinc never called** |
| €248 offer | `PURCHASED · order_ref W55917434 · captured 24800 · released 200` |
| Same key again | identical response, same order — one purchase |
| Sold out between check and buy | `FAILED · out_of_stock · refunded 24800` |
| Retailer price jumped after commit | `FAILED · max_price_exceeded` — **Zinc's own ceiling** — `refunded 24800` |
| Nothing qualified | `released · 25000` |

Three ceilings between the model and the money, none of them an `if` of ours: the gate before anything, Stripe at capture, Zinc at placement.

**What crosses to P1:** `/checkout` req now carries `offer: { url, retailer, total_cents }` and optional `shipping` (defaults to a US demo address until shipping lives on the instruction). `GET /coverage` lists where we can buy. Sandbox resolves in ~1 s so the call is synchronous today; production is minutes → the async callback in § 12.

**Found in the run:** the commit idempotency key is `commit_{instruction_id}`, so re-arming the same instruction returns the *old* hold. Re-arm must carry an attempt number — added to the P1 ask.

**The retailer on stage:** Amazon. The extension reads a real listing; `/checkout` sends Zinc's sandbox slugs (`test-success`, `test-out-of-stock`, `test-price-exceeded`) in place of the listing URL. The restock is P1's `POST /demo/restock`, fired from a phone with the laptop closed.
