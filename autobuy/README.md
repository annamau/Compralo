# AutoBuy — limit orders for everyday products

Set the terms once, on the product page you are already looking at. An agent watches the market, and the moment a listing meets every term it buys exactly one unit at the real price and stops. You can close the browser.

**AI handles ambiguity. Deterministic software handles money.** Claude reads product pages and normalises messy retailer listings. A pure function decides whether to buy. A separate money service moves the money. No model is ever on the path between "offer qualifies" and "card charged".

## Run it

```bash
cd ../money && npm start   # P4 money service :4242 — holds, captures, releases, Zinc orders
cd ../autobuy
npm install
npm run dev                # market simulator :4000 + backend :3000 (dashboard at http://localhost:3000/dashboard)
```

The money service comes first: the backend checks `P4_URL/health` at boot and **exits** if it is
unreachable, rather than discovering it at purchase time. Its boot banner says `Money: P4 at <url>`.

Load the extension: `chrome://extensions` → Developer mode → **Load unpacked** → `packages/extension`. Pin it. Open a product page, click the AutoBuy icon; the side panel reads the page.

Config goes in `packages/backend/.env` (copy `.env.example`). **There is no Stripe key here** — this
backend holds no payment credentials at all. Every hold, capture, release and aggregator order goes
through the money service, which owns the Stripe and Zinc sandbox keys.

| Key | Absent | Present |
|---|---|---|
| `ANTHROPIC_API_KEY` | Hardcoded fixtures: any page reads as a PS5 Slim Digital, shoe-ish URLs read as Nike Air Max 90; listings are normalised by keyword rules | `claude-opus-5` reads the real page and returns product-specific controls; every new listing is normalised by Claude (cached per listing id) |
| `P4_URL` | defaults to `http://localhost:4242` | the money service, wherever it lives |

The backend prints its mode at boot (`AI: …`, `Money: …`) and the dashboard header shows it.

## The demo

```bash
./demo.sh reset        # clean market + backend state
# create a Buy Order in the side panel (or: ./demo.sh order), then quit Chrome
./demo.sh              # Enter pushes offer A, then B, then C (then D)
./demo.sh --mismatch-first   # A, B, D, C — the merchant changes price at checkout on D
./demo.sh --zinc       # A, B, E — the winning offer is an amazon listing, bought through Zinc
./demo.sh order 3ds    # a second order on Stripe's pm_card_authenticationRequired card
```

| Offer | Listing | Rule engine says |
|---|---|---|
| A · store-a | "PS5 Slim Disc Edition + Spider-Man 2 bundle" €430 | ✗ `variant:edition` disc ≠ digital · ✗ `bundle` not allowed |
| B · store-b | correct product €445 + €15 shipping | ✗ `price` 460.00 > 450.00 |
| C · store-c | correct product €448 delivered | ✓ all 10 checks → lock → revalidate → checkout → capture €448 → **PURCHASED** + macOS notification |
| D · store-a | correct product €440 listed, €470 at checkout | ✓ qualifies → checkout **409** → `CHECKOUT_PRICE_MISMATCH`, nothing captured, lock released, still monitoring |
| E · amazon | correct product €447 delivered | ✓ qualifies → routed to **Zinc**, not the simulator → **PURCHASED** with a `W…` order ref |
| F · amazon | correct product €446, Zinc's out-of-stock rehearsal slug | ✓ qualifies → Zinc refuses → `FAILED · out_of_stock`, hold **refunded** → `NEEDS_ATTENTION`, re-arm to try again |

Why a simulator and not real retailers: the demo needs three retailers to restock in a chosen order inside twenty seconds, and no real market does that on cue. The simulator is deterministic; monitoring adapters (Streetmerchant-style per-retailer pollers) are the swap-in behind `packages/backend/src/market.ts`.

## Architecture

```
Chrome extension (MV3, side panel)      ← the environment. Reads the page the user is on.
        │ POST /understand, POST /instructions
        ▼
Backend :3000 (Node/TS, Hono)           ← the agent. Owns state, polls, evaluates, executes.
   ├─ ai.ts / claude.ts   product understanding, control generation, listing normalisation (cached)
   ├─ rules.ts            pure function, no I/O — the only thing that decides
   ├─ executor.ts         lock → revalidate → one POST to the money service → fulfil
   ├─ monitor.ts          3 s poll, one instruction × one offer at a time, executor awaited
   └─ dashboard.html      one page + SSE event stream
        │ GET /offers (every 3 s)          │ POST /checkout, /funds/commit, /funds/release
        ▼                                  ▼
Market simulator :4000                  P4 money :4242            ← the money. Owns the Stripe and
   three fake retailers + an              ├─ store-*  verify at the market, then capture
   admin endpoint demo.sh drives          └─ amazon…  capture, then Zinc places the order
                                             Zinc sandbox keys. AutoBuy holds none.
```

State is in memory, mirrored to `./data/state.json` on every change. No database.

### Who decides what

| Question | Decided by | How |
|---|---|---|
| What product is on this page? Which controls matter for it? | **Claude** (`understand`, effort medium) | ld+json Product first, then sanitised HTML; structured output validated by Zod |
| Is this listing the same product? Is it a bundle? | **Claude** (`normaliseOffer`, effort low) | Same attribute keys as the target so fields compare one to one; cached by listing id |
| Does this offer qualify? | **Pure function** (`rules.ts`) | 9 checks in fixed order, every one recorded pass or fail with its reason |
| Is it still true right now? | **Executor** | Re-fetches the market and re-runs the same pure function under a lock |
| What does the merchant actually charge? | **Merchant checkout** | `POST /checkout { expected_total }` → 200, or 409 with the real total |
| Move the money | **P4 money service** | Manual-capture hold for the ceiling at arm time; capture the real total, never more. Stripe refuses an over-ceiling capture, so the ceiling is enforced outside this process |
| Which order to checkout and capture in | **P4, not AutoBuy** | The market can quote without committing, so it verifies first; Zinc commits on contact, so it captures first and an over-mandate order never reaches the aggregator |
| Buy once, ever | **Lock + status** | In-memory lock per instruction; only ACTIVE instructions are evaluated; PURCHASED stops the loop |

The rule engine's checks, in order: instruction live, deadline, retailer approved, in stock, condition, bundle policy, one check per mandated attribute (`variant:edition`, `variant:storage`, …), currency, delivered total ≤ ceiling with the arithmetic in the detail (`448.00 ≤ 450.00`). `npm run test:rules` asserts the demo offers give reject / reject / qualify.

### Executor order

Merchant checkout and payment used to be two steps in the executor. They are now **one call** to the
money service, because the order of those two steps depends on the merchant and only the money
service knows it:

- **`store-*`** — the market can quote a price without committing, so it verifies **first** and
  captures second. A 409 costs nothing and the hold survives, so the agent keeps monitoring.
- **`amazon…`** — Zinc commits on contact, so the capture comes **first**. An over-mandate order can
  therefore never reach the aggregator: Stripe refuses the capture and Zinc is never called.

AutoBuy does not choose. It sends the offer and maps one of five statuses back onto the instruction:

| P4 says | AutoBuy does |
|---|---|
| `PURCHASED` | `CHECKOUT_OK` + `PAYMENT_CAPTURED` (order ref, captured, released) → `PURCHASED` + notification |
| `DECLINED · price_mismatch` | `CHECKOUT_PRICE_MISMATCH` → back to `ACTIVE`, nothing captured, hold intact |
| `DECLINED · anything else` | `PAYMENT_DECLINED` with the reason **verbatim** → back to `ACTIVE`, still watching |
| `FAILED` | `FAILED` with the reason → `NEEDS_ATTENTION`; the hold was refunded, so re-arm |
| `NEEDS_ATTENTION` | `NEEDS_ATTENTION` — the customer has to do something |
| `UNKNOWN` | stay `EXECUTING` and poll `GET /purchases/:key` every 5 s for 10 min. Money moved and an order may exist: never retry, never refund |

`PAYMENT_DECLINED` is deliberately a different event from `CHECKOUT_PRICE_MISMATCH` and renders with
its own badge. A merchant that changed its price is a market fact; a payment layer that refused the
amount is a ceiling we did not write, and the dashboard quotes its sentence unedited.

### Releasing the hold

Every terminal state releases the funds, so no authorisation is ever left lingering:

| Terminal state | Released by |
|---|---|
| `PURCHASED` | nothing to release — the hold was captured and the remainder returned automatically |
| `CANCELLED` | `POST /instructions/:id/cancel`, also the **Cancel** button on every dashboard card |
| `EXPIRED` | the monitor's deadline sweep, every tick |
| `FAILED` on the Zinc path | the money service already refunded before replying |

### Failure handling

| Situation | What happens |
|---|---|
| Two qualifying offers in one tick | The monitor awaits the executor; the second sees the instruction is no longer ACTIVE |
| Two ticks overlap (a Claude call takes > 3 s) | Re-entrancy guard: the tick is skipped, not stacked |
| Listing changed between evaluate and execute | `REVALIDATED` fails → back to ACTIVE, lock released |
| Merchant returns a different total | `CHECKOUT_PRICE_MISMATCH` → back to ACTIVE, nothing captured |
| Card needs 3DS (`pm_card_authenticationRequired`) | the money service returns `needs_attention` → `NEEDS_ATTENTION`, never ACTIVE, nothing bought |
| The money service is down at boot | the backend refuses to start and says so |
| The money service is down at purchase time | `FAILED` event, back to `ACTIVE`, nothing captured, retried next tick |
| Claude cannot normalise a listing | `FAILED` event with the reason; retried on the next two ticks, then skipped; the instruction stays ACTIVE |
| Backend restarts mid-run | State reloads from `data/state.json`; an instruction caught EXECUTING returns to ACTIVE (nothing is captured before checkout) |
| Market unreachable | One log line, retried every tick |

## Honest limitations

- **Simulated market.** Three fake retailers that restock on cue. Real monitoring is an adapter swap, not written here.
- **Test-mode payments.** Stripe test keys and test cards, and a Zinc *sandbox* key. The hold and the capture are real Stripe objects and the Zinc order is a real sandbox order, but no money moves and nothing ships.
- **Zinc sandbox substitutes URLs.** The sandbox knows only its rehearsal slugs, so a real listing URL is swapped for `test-success` and the original is kept on the record (`sandbox_url_substituted: true`).
- **Authorisation holds expire in about 7 days.** A 30-day mandate in production needs the saved-payment-method flow (SetupIntent + off-session PaymentIntent at purchase time), not a single long-lived hold.
- **Merchant checkout is the simulator's endpoint.** A real merchant checkout is the hard part (accounts, addresses, anti-bot); it is out of scope and out of the demo.
- **Preferences are shown, not enforced.** Controls with `required_match: false` (cover colour) are rendered for the user but only `required_match: true` controls become rules. 
- **Prompt caching is wired but the system prompts (~600 tokens) sit below the model's minimum cacheable prefix**, so cache reads stay at zero at this size. The `cache_control` block is in place for when the prompts grow.
- Extension `host_permissions` include `http://*/*` and `https://*/*` in addition to `activeTab` so "Re-read page" and automatic re-reads on tab change work after navigation without another toolbar click.

## Token cost

Every Claude call logs `usage`; `GET /usage` and the dashboard footer show totals and USD at Opus 5 list price ($5 / $25 per MTok in / out).

| Call | Model, effort | Input | Typical cost |
|---|---|---|---|
| `/understand` (one per page read) | `claude-opus-5`, medium | ld+json + sanitised HTML capped at 40k chars (a Nike page: 819k → 34k chars) | measured live in `/usage` once `ANTHROPIC_API_KEY` is set |
| `normaliseOffer` (one per new listing id) | `claude-opus-5`, low | target product + one listing | measured live; the second and every later poll is a cache hit at zero tokens |

Without a key the figures are zero and the dashboard says `AI: hardcoded`.

## Repository

```
demo.sh                        operator script
packages/shared/types.ts       the contract all three packages share
packages/market/server.js      simulator, one file, zero deps
packages/backend/src/          index (routes) · monitor · executor · rules · ai · claude · sanitise · stripe (P4 client) · state · events
packages/backend/dashboard.html
packages/extension/            manifest.json · background.js · panel.html · panel.js · panel.css · config.js · INSTALL.md
```

Decisions taken where the spec was silent: `GET /retailers`, `GET /usage` and `POST /admin/reset` were added (panel checkboxes, dashboard footer, clean second run); `POST /instructions` accepts an optional `payment_method`; `EVALUATING` is in the type but unused; the simulator's admin-only `checkout_total` field is how offer D produces a 409.
