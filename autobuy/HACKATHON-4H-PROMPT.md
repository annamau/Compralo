# Build AutoBuy — limit orders for everyday products. 4-hour hackathon build.

Build this in the current directory as a monorepo. Work autonomously through the build order at the end; only stop to ask me if something in this spec is contradictory. Report at each checkpoint named in the build order.

You are building a demo for a hackathon judged on: (1) a working agent inside a place people
already live, end to end; (2) whether that environment materially changes what the agent can do;
(3) engineering quality, orchestration and failure handling; (4) usefulness and user control.

Four hours. Everything below is scoped to a demo that runs twice in a row without failing. When
the spec is silent, choose whatever gets a vertical slice working sooner, and tell me what you
chose. Do not build anything not named here.

Principle that shapes every decision: **AI handles ambiguity. Deterministic software handles
money.** The LLM understands product pages and normalises listings. A pure function decides
whether to buy. Stripe moves the money. No LLM is ever on the path between "offer qualifies"
and "card charged".

## The demo (build backwards from this)

1. Open a REAL product page (a PS5 Slim Digital on a real retailer, out of stock). Open the
   extension side panel. It reads the page, and Claude returns the canonical product plus a set
   of purchasing controls that fit THIS product: Edition (Digital/Disc), Bundles allowed?, Condition.
   Then open a real shoe page: the controls change to Size, Colour, Condition. Ten seconds, and it
   is the whole argument for criterion 2 — a chatbox does not know what you are looking at.
2. Set: Digital only, New, no bundles, max total €450, approved retailers [any of the three], 30
   days. Click **Create Buy Order**. Backend authorises €450 on Stripe (test mode, manual capture)
   and the instruction goes ACTIVE.
3. **Quit Chrome entirely.** The terminal shows the agent still polling.
4. The market simulator emits three offers over ~20 seconds:
   - Store A, "PS5 Slim Disc Edition + Spider-Man 2 bundle", €430 → Claude normalises the
     listing → rule engine REJECTS: wrong edition, bundle not allowed.
   - Store B, correct product, €445 + €15 shipping → REJECTS: total €460 > €450.
   - Store C, correct product, €448 delivered → QUALIFIES → lock → revalidate → Stripe capture
     €448 → merchant checkout → PURCHASED. macOS notification fires.
5. Reopen Chrome, open the dashboard: PURCHASED €448, with the full decision history showing
   every check on every offer, pass or fail, with the reason.

Should-have if ahead of schedule (it is the difference between a 4 and a 5 on criterion 3):
6. A fourth offer where the merchant returns a different price at checkout than it listed. The
   agent aborts, releases the lock, records `CHECKOUT_PRICE_MISMATCH`, and keeps monitoring.
7. Create a second order using Stripe's `pm_card_authenticationRequired` test card. It lands in
   NEEDS_ATTENTION instead of pretending to succeed — the honest answer to "what about 3DS?".

## Architecture — three processes, one contract

```
Chrome extension (MV3, side panel)      ← the environment. Reads the page the user is on.
        │ POST /understand, POST /instructions
        ▼
Backend :3000 (Node/TS)                 ← the agent. Owns state, polls, evaluates, executes.
   ├─ AI: product understanding, control generation, listing normalisation (cached per listing)
   ├─ Rule engine: pure function, no I/O
   ├─ Executor: lock → revalidate → Stripe capture → merchant checkout → fulfil
   └─ Dashboard: one HTML page + SSE event stream
        │ GET /offers (poll every 3s), POST /checkout
        ▼
Market simulator :4000                  ← three fake retailers with an admin endpoint the demo
                                          script drives. Deterministic on stage.
```

Why a simulator and not Streetmerchant or real retailers: the demo needs three retailers to
restock in a chosen order inside twenty seconds. No real market does that on cue. Say so on
stage — "simulated market so the sequence is deterministic; monitoring adapters are the swap-in"
— and cite Streetmerchant as the adapter layer you'd plug in next. Do not fork it today.

State is in memory, mirrored to `./data/state.json` on every change. No database.

## Shared contract — fix this first, then the three packages can be built in parallel

```ts
// packages/shared/types.ts
export type CanonicalProduct = {
  name: string;                       // "PlayStation 5 Slim Digital Edition 1TB"
  category: string;                   // "games_console" | "footwear" | "gpu" | ...
  brand: string | null;
  identifiers: { gtin?: string; ean?: string; sku?: string; model?: string };
  attributes: Record<string, string>; // { edition: "digital", storage: "1TB" }
  listed_price: number | null;
  currency: string | null;
  in_stock: boolean;
};

export type Control = {
  key: string;                        // "edition"
  label: string;                      // "Edition"
  type: "select" | "multiselect" | "number" | "boolean";
  options?: string[];                 // for select/multiselect
  default: string | string[] | number | boolean;
  required_match: boolean;            // true → offer.attributes[key] must equal the chosen value
};

export type Constraints = {
  max_total: number;                  // delivered price ceiling, in currency
  currency: string;
  quantity: 1;                        // fairness rule: hard-coded to 1
  condition: "new" | "refurbished" | "any";
  approved_retailers: string[];
  deadline: string;                   // ISO date
  variant: Record<string, string | string[]>;  // chosen values keyed by Control.key
  allow_bundles: boolean;
};

export type Instruction = {
  id: string;
  product: CanonicalProduct;
  constraints: Constraints;
  status: "ACTIVE" | "EVALUATING" | "EXECUTING" | "PURCHASED" | "NEEDS_ATTENTION" | "FAILED" | "EXPIRED" | "CANCELLED";
  stripe_payment_intent: string | null;
  order: { retailer: string; total: number; merchant_order_id: string; at: string } | null;
  created_at: string;
};

export type RawOffer = {              // what the market emits — deliberately unstructured
  id: string; retailer: string; listing_title: string; price: number; shipping: number;
  currency: string; condition: string; in_stock: boolean; url: string;
};

export type NormalisedOffer = RawOffer & {
  canonical: CanonicalProduct;        // Claude's reading of the listing, cached by offer.id
  is_bundle: boolean;
  total: number;                      // price + shipping
};

export type Check = { name: string; pass: boolean; detail: string };
export type Evaluation = { qualified: boolean; checks: Check[] };

export type Event = {
  at: string; instruction_id: string;
  type: "CREATED" | "OFFER_SEEN" | "OFFER_NORMALISED" | "OFFER_REJECTED" | "OFFER_QUALIFIED"
      | "LOCK_ACQUIRED" | "REVALIDATED" | "PAYMENT_CAPTURED" | "CHECKOUT_OK" | "PURCHASED"
      | "CHECKOUT_PRICE_MISMATCH" | "PAYMENT_ACTION_REQUIRED" | "FAILED";
  detail: string; data?: unknown;
};
```

Backend HTTP (CORS open; extension also declares the host permission):

```
POST /understand        { url, html }               → { product: CanonicalProduct, controls: Control[] }
POST /instructions      { product, constraints }    → Instruction   (creates Stripe auth, status ACTIVE)
GET  /instructions                                  → Instruction[]
GET  /instructions/:id                              → Instruction
GET  /events?instruction_id=                        → Event[]
GET  /events/stream                                 → SSE, one Event per message
GET  /dashboard                                     → HTML
```

Market simulator :4000:

```
GET  /offers                                        → RawOffer[]  (currently live listings)
POST /checkout          { offer_id, expected_total } → 200 { merchant_order_id }  |  409 { actual_total }
POST /admin/offers      RawOffer                    → adds/replaces a listing
POST /admin/reset
```

The `409 actual_total` response is how the simulator produces the price-mismatch failure in
should-have #6. The checkout endpoint verifies the total the agent thinks it is paying.

## Package 1 — Chrome extension (`packages/extension`)

Manifest V3, vanilla JS, no bundler, no framework. Use the **side panel** (`chrome.sidePanel`,
`"side_panel": {"default_path": "panel.html"}`), not a popup — popups close when the user clicks
anywhere else and that has killed more hackathon demos than bugs have.

Permissions: `activeTab`, `scripting`, `sidePanel`, `host_permissions: ["http://localhost:3000/*"]`.

Flow: panel opens → `chrome.scripting.executeScript` on the active tab with
`func: () => ({ url: location.href, title: document.title, html: document.documentElement.outerHTML })`
(no content script needed) → POST `/understand` → render the product card and the returned
`controls` with a 40-line renderer that handles the four control types, plus the universal fields
(max total, condition, approved retailers as checkboxes fetched from the backend, deadline days)
→ **Create Buy Order** → POST `/instructions` → show the instruction id and a link to the dashboard.

Show a skeleton state while `/understand` runs (it takes a few seconds). Show the backend error
verbatim if it fails. Do not put the Anthropic key anywhere near the extension; every model call
happens in the backend.

## Package 2 — Backend (`packages/backend`)

Node 20+, TypeScript via `tsx`, Hono (or Express if you prefer, no difference). Files:

- `ai.ts` — the three Claude calls (below).
- `rules.ts` — `evaluate(instruction, offer): Evaluation`. Pure. No imports except types. Checks,
  in order, each producing a `Check` even when an earlier one fails (the dashboard shows all of
  them): instruction is ACTIVE; deadline not passed; retailer approved; in stock; condition
  allowed; not a bundle unless allowed; every `required_match` attribute equals the mandate;
  currency matches; `total <= max_total` with the arithmetic in `detail` ("448.00 ≤ 450.00").
- `executor.ts` — `execute(instruction, offer)`: acquire an in-memory lock keyed by instruction
  id (a Map; if present, return immediately with `LOCK_HELD`); set EXECUTING; re-fetch `/offers`
  and re-run `evaluate` (REVALIDATED); Stripe `paymentIntents.capture(pi, { amount_to_capture })`;
  market `POST /checkout` with `expected_total`; on 409 → record CHECKOUT_PRICE_MISMATCH, set
  back to ACTIVE, release lock; on 200 → PURCHASED, record order, `osascript -e 'display
  notification ...'`. The lock and the one-order-per-instruction check make triple restocks buy
  once — say that out loud in the demo.
- `monitor.ts` — `setInterval` 3s: GET `/offers`; for each ACTIVE instruction × each offer not yet
  seen for that instruction: normalise (cached), evaluate, emit events, and if qualified, hand to
  the executor. `await` the executor so two qualifying offers in one tick cannot race.
- `state.ts` — in-memory + JSON mirror. `events.ts` — append + SSE fan-out.
- `dashboard.html` — one page, `EventSource('/events/stream')`, three columns: Active /
  Needs attention / Purchased, and under the selected instruction the decision history as a table
  of offers × checks with ✓/✗ and the detail text. This table is the trust story. Make it legible
  from the back of a room: large type, green/red, retailer name and total in bold.

### The Claude calls (`ai.ts`)

`@anthropic-ai/sdk`, model `claude-opus-5` — exact string, never a date suffix. Use
`client.messages.parse` with `zodOutputFormat` from `@anthropic-ai/sdk/helpers/zod` so the
output is a validated Zod object; `parsed_output` is null on failure — guard it and surface the
failure as an event rather than throwing. Thinking is on by default on Opus 5; do not pass
`thinking` or `budget_tokens`. Put `effort` inside `output_config`. Put the static system prompt
behind `cache_control: { type: "ephemeral" }` and the volatile page content after it.

Before every call, strip `<script>`, `<style>`, `<svg>`, `<noscript>`, comments and inline event
handlers with cheerio and cap at ~40k characters. If the page has a `script[type="application/ld+json"]`
with a `Product`, pass it first and tell the model to prefer it — deterministic identifiers beat
inference, and it makes the extraction cheaper.

1. `understand(url, html) → { product: CanonicalProduct, controls: Control[] }`
   System prompt asks for: the canonical product, any GTIN/EAN/SKU/model found verbatim, the
   category, and 2–5 purchasing controls that would matter to a buyer of THIS product (edition,
   size, colour, capacity, manufacturer…) with sensible options and `required_match` set true
   for anything that changes what the product is (edition, size) and false for preferences.
   `effort: "medium"`. Log `usage` tokens.

2. `normaliseOffer(raw: RawOffer, target: CanonicalProduct) → { canonical, is_bundle }`
   Given a listing title and the target product, return the listing's canonical form using the
   same attribute keys as the target so the rule engine can compare them field by field, and
   whether it is a bundle. `effort: "low"`. Cache by `raw.id` in memory — the second and every
   later poll costs zero tokens. Log tokens; the dashboard footer shows total spend.

3. Optional if ahead: `parseInstruction(text, product, controls) → Partial<Constraints>` so the
   panel accepts "digital only, new, under 450, any store" and pre-fills the controls.

### Stripe (test mode)

`stripe` Node SDK, `STRIPE_SECRET_KEY=sk_test_…`. On `POST /instructions`:

```ts
const pi = await stripe.paymentIntents.create({
  amount: Math.round(constraints.max_total * 100), currency: constraints.currency.toLowerCase(),
  payment_method: "pm_card_visa", payment_method_types: ["card"],
  confirm: true, capture_method: "manual",
  description: `AutoBuy mandate: ${product.name}`,
});
```

That is a real authorisation hold in Stripe's test environment — the Stripe dashboard shows it,
which is the answer to "is the checkout mocked?". Capture the actual total on purchase (never
more than authorised). If `pi.status === "requires_action"` (the `pm_card_authenticationRequired`
test card), set NEEDS_ATTENTION and stop — that is should-have #7 and it is one `if`. Note in the
README that card authorisations expire in about a week, so a 30-day mandate needs the saved-
payment-method flow in production.

## Package 3 — Market simulator (`packages/market`)

Node, one file, ~80 lines. Three retailers: `store-a`, `store-b`, `store-c`. Endpoints above.
`POST /checkout` returns 409 with `actual_total` when the stored listing's total differs from
`expected_total`. Seed with all three listings `in_stock: false`.

`demo.sh` at the repo root: `reset`, then on each keypress pushes the next scripted offer
(the three from the demo, then the price-mismatch one). The operator never types a curl on
stage. Print what it just did in large text.

## Build order — strictly vertical slice first

1. `shared/types.ts`, then the market simulator seeded with the three listings. `curl` it.
2. Backend with `/understand` returning a HARDCODED product and controls, `/instructions`,
   the monitor loop, and the rule engine. Prove the three-offer sequence produces
   reject / reject / PURCHASED in the terminal with no AI and no Stripe. **This is the checkpoint
   that matters — reach it by the end of hour one.**
3. Extension: side panel that calls the hardcoded `/understand` and creates an instruction. Get it
   loaded in Chrome and creating an order by hour two.
4. Swap in the real Claude calls. Test on two real product pages. Then Stripe.
5. Dashboard with SSE. Run the full demo twice, including quitting Chrome.
6. Buffer: should-haves #6 and #7, README, and a screen recording of a clean run as backup.

## Non-goals

No Streetmerchant fork, no real retailer monitoring, no Playwright, no browser-agent checkout, no
database, no auth, no cross-store discovery UI, no alternatives, no price history, no mobile, no
production payments, no CAPTCHA or proxy anything. Quantity is hard-coded to 1.

## Deliverables

Monorepo with `npm install && npm run dev` starting market + backend; `demo.sh`; the extension
loadable via "Load unpacked"; README with the architecture diagram, the "AI handles ambiguity,
deterministic software handles money" split drawn as a table of which component decides what,
the honest-limitations section (simulated market, test-mode payments, auth hold expiry), and
token cost per `/understand` and per normalised listing.

Start with the types and the market simulator. Report back when the terminal shows
reject / reject / PURCHASED on hardcoded data.
