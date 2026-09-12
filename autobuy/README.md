# AutoBuy — limit orders for everyday products

Set the terms once, on the product page you are already looking at. An agent watches the market, and the moment a listing meets every term it buys exactly one unit at the real price and stops. You can close the browser.

**AI handles ambiguity. Deterministic software handles money.** Claude reads product pages and normalises messy retailer listings. A pure function decides whether to buy. Stripe moves the money. No model is ever on the path between "offer qualifies" and "card charged".

## Run it

```bash
npm install
npm run dev            # market simulator :4000 + backend :3000 (dashboard at http://localhost:3000/dashboard)
```

Load the extension: `chrome://extensions` → Developer mode → **Load unpacked** → `packages/extension`. Pin it. Open a product page, click the AutoBuy icon; the side panel reads the page.

Keys go in `packages/backend/.env` (copy `.env.example`). Both are optional and the demo runs without either:

| Key | Absent | Present |
|---|---|---|
| `ANTHROPIC_API_KEY` | Hardcoded fixtures: any page reads as a PS5 Slim Digital, shoe-ish URLs read as Nike Air Max 90; listings are normalised by keyword rules | `claude-opus-5` reads the real page and returns product-specific controls; every new listing is normalised by Claude (cached per listing id) |
| `STRIPE_SECRET_KEY` (`sk_test_…`) | Stripe stub: same shapes, logged as `STRIPE STUB` | A real test-mode authorisation for the max total, visible in the Stripe dashboard; the real price is captured on purchase |

The backend prints its mode at boot (`AI: …`, `Stripe: …`) and the dashboard header shows it.

## The demo

```bash
./demo.sh reset        # clean market + backend state
# create a Buy Order in the side panel (or: ./demo.sh order), then quit Chrome
./demo.sh              # Enter pushes offer A, then B, then C (then D)
./demo.sh --mismatch-first   # A, B, D, C — the merchant changes price at checkout on D
./demo.sh order 3ds    # a second order on Stripe's pm_card_authenticationRequired card
```

| Offer | Listing | Rule engine says |
|---|---|---|
| A · store-a | "PS5 Slim Disc Edition + Spider-Man 2 bundle" €430 | ✗ `variant:edition` disc ≠ digital · ✗ `bundle` not allowed |
| B · store-b | correct product €445 + €15 shipping | ✗ `price` 460.00 > 450.00 |
| C · store-c | correct product €448 delivered | ✓ all 10 checks → lock → revalidate → checkout → capture €448 → **PURCHASED** + macOS notification |
| D · store-a | correct product €440 listed, €470 at checkout | ✓ qualifies → checkout **409** → `CHECKOUT_PRICE_MISMATCH`, nothing captured, lock released, still monitoring |

Why a simulator and not real retailers: the demo needs three retailers to restock in a chosen order inside twenty seconds, and no real market does that on cue. The simulator is deterministic; monitoring adapters (Streetmerchant-style per-retailer pollers) are the swap-in behind `packages/backend/src/market.ts`.

## Architecture

```
Chrome extension (MV3, side panel)      ← the environment. Reads the page the user is on.
        │ POST /understand, POST /instructions
        ▼
Backend :3000 (Node/TS, Hono)           ← the agent. Owns state, polls, evaluates, executes.
   ├─ ai.ts / claude.ts   product understanding, control generation, listing normalisation (cached)
   ├─ rules.ts            pure function, no I/O — the only thing that decides
   ├─ executor.ts         lock → revalidate → merchant checkout → Stripe capture → fulfil
   ├─ monitor.ts          3 s poll, one instruction × one offer at a time, executor awaited
   └─ dashboard.html      one page + SSE event stream
        │ GET /offers (every 3 s), POST /checkout
        ▼
Market simulator :4000                  ← three fake retailers + an admin endpoint demo.sh drives
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
| Move the money | **Stripe** | Manual-capture hold for the ceiling at order time; capture the real total, never more |
| Buy once, ever | **Lock + status** | In-memory lock per instruction; only ACTIVE instructions are evaluated; PURCHASED stops the loop |

The rule engine's checks, in order: instruction live, deadline, retailer approved, in stock, condition, bundle policy, one check per mandated attribute (`variant:edition`, `variant:storage`, …), currency, delivered total ≤ ceiling with the arithmetic in the detail (`448.00 ≤ 450.00`). `npm run test:rules` asserts the demo offers give reject / reject / qualify.

### Executor order

The executor runs **checkout before capture**: revalidate → `POST /checkout` at the evaluated total → Stripe capture → PURCHASED. A merchant 409 (price changed) then costs nothing and the authorisation hold survives, so the agent keeps monitoring. Capturing first would consume the hold and make "abort and keep watching" impossible. If Stripe capture fails after a successful checkout the instruction goes `FAILED` with the detail (it does not happen in test mode).

### Failure handling

| Situation | What happens |
|---|---|
| Two qualifying offers in one tick | The monitor awaits the executor; the second sees the instruction is no longer ACTIVE |
| Two ticks overlap (a Claude call takes > 3 s) | Re-entrancy guard: the tick is skipped, not stacked |
| Listing changed between evaluate and execute | `REVALIDATED` fails → back to ACTIVE, lock released |
| Merchant returns a different total | `CHECKOUT_PRICE_MISMATCH` → back to ACTIVE, nothing captured |
| Card needs 3DS (`pm_card_authenticationRequired`) | Stripe returns `requires_action` → `NEEDS_ATTENTION`, never ACTIVE, nothing bought |
| Claude cannot normalise a listing | `FAILED` event with the reason; retried on the next two ticks, then skipped; the instruction stays ACTIVE |
| Backend restarts mid-run | State reloads from `data/state.json`; an instruction caught EXECUTING returns to ACTIVE (nothing is captured before checkout) |
| Market unreachable | One log line, retried every tick |

## Honest limitations

- **Simulated market.** Three fake retailers that restock on cue. Real monitoring is an adapter swap, not written here.
- **Test-mode payments.** Stripe test keys and test cards. The hold and the capture are real Stripe objects, but no money moves.
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
packages/backend/src/          index (routes) · monitor · executor · rules · ai · claude · sanitise · stripe · state · events
packages/backend/dashboard.html
packages/extension/            manifest.json · background.js · panel.html · panel.js · panel.css
```

Decisions taken where the spec was silent: `GET /retailers`, `GET /usage` and `POST /admin/reset` were added (panel checkboxes, dashboard footer, clean second run); `POST /instructions` accepts an optional `payment_method`; `EVALUATING` is in the type but unused; the simulator's admin-only `checkout_total` field is how offer D produces a 409.
