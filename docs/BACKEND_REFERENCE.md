# Backend Reference (for the P2 / extension session)

**Status: descriptive, not a contract.** This file records what the backend
code *actually does today*, read from the source on branch `rusty`. Where it
disagrees with [CONTRACTS.md](CONTRACTS.md), neither side is "wrong" yet — they
are two different systems that have not been reconciled. CONTRACTS.md is still
the agreed target; this file tells you what exists, so the frontend can be built
without assuming endpoints that no process serves.

Written 2026-09-12 from commit `b34aaad` (`origin/rusty`).

---

## 0. The first thing to know: the backend is not on `main`

```
main / UI_extensionChrome   docs + money/money.mjs only — no server code
origin/rusty                the entire Rust backend
```

`main` and `rusty` have **no common ancestor** (two root commits: `c232e17` and
`d30cad7`). They are unrelated histories, so joining them needs
`git merge origin/rusty --allow-unrelated-histories` or a subtree copy. Nothing
in `main` imports anything from `rusty` and vice versa.

Practical consequence for the extension session: **you cannot `cargo run` the
backend from a `main` checkout.** To see a live server you need a worktree on
`rusty`:

```bash
git worktree add ../Compralo-backend origin/rusty
```

---

## 1. What the backend is

A Rust/Axum service that **polls public product URLs on a schedule, extracts a
normalized offer from the HTML, evaluates it against deterministic constraints,
and — if it qualifies — runs a simulated checkout.** It keeps an append-only
event log per monitor and streams it over SSE.

Workspace layout on `rusty`:

| Crate | Role |
| --- | --- |
| `backend/crates/domain` | Core types: `Monitor`, `NormalizedOffer`, `CanonicalProduct`, `PurchaseConstraints`, `MonitorStatus`, `OfferSource` trait |
| `backend/crates/monitoring` | SSRF-safe URL validation, Spider-based fetcher, backoff policy |
| `backend/crates/product-intelligence` | HTML → `NormalizedOffer` via JSON-LD, then OpenGraph/meta. AI provider is defined but **disabled** |
| `backend/crates/rule-engine` | Pure `evaluate(monitor, offer, now) -> EvaluationDecision`. No model, no I/O |
| `backend/crates/execution` | `ExecutionEngine`: revalidate → check authorization → checkout → record, with idempotency |
| `backend/crates/merchant-demo` | `DemoMerchant`: scripted checkout outcomes, in-memory orders |
| `backend/crates/persistence` | SQLite store (sqlx), job leasing, event log |
| `backend/crates/server` | Axum router + the `MonitorWorker` background loop |

Its own `API.md` (on `rusty`) is the closest thing to hand-written API docs and
is accurate except for one detail flagged in §5.3.

---

## 2. Running it

```bash
cp .env.example .env
cargo run -p server
```

- Listens on **`127.0.0.1:3000`** by default (`BIND_ADDR`).
- SQLite at `./buy-agent.sqlite` by default (`DATABASE_URL`); migrations run at boot.
- **`SPIDER_CLOUD_API_KEY` is required or the process exits at startup.** It is
  only used as a *fallback* when a direct crawl is blocked, but it is checked
  unconditionally.
- Docker: `docker compose up` → port **8080**, SQLite in the `compralo-data` volume.

CORS is `CorsLayer::permissive()` and there is **no authentication of any kind**.
An MV3 side panel can call it directly from `fetch` with no token and no preflight
problems. `VITE_API_URL=http://127.0.0.1:3000` already matches the default bind
address in `extension/src/services/apiClient.ts`.

---

## 3. Endpoint inventory (complete — this is every route)

From `backend/crates/server/src/lib.rs::router`:

| Method | Path | Returns |
| --- | --- | --- |
| GET | `/health` | `200 {"status":"ok"}` |
| GET | `/openapi.json` | `200` — a stub, route names only, less useful than `API.md` |
| POST | `/v1/monitors` | `201` `Monitor` |
| GET | `/v1/monitors` | `200` `Monitor[]`, newest first (`created_at DESC`) |
| GET | `/v1/monitors/{id}` | `200` `Monitor` · `404` |
| POST | `/v1/monitors/{id}/cancel` | `204` · `409` on a bad transition |
| GET | `/v1/monitors/{id}/events` | `200` `MonitorEvent[]`, ascending `id` |
| GET | `/v1/monitors/{id}/events/stream` | `200` `text/event-stream` |
| POST | `/v1/monitors/{id}/payment-authorizations` | `201 {"id":"<uuid>"}` |
| POST | `/v1/demo/offers/{monitor_id}` | `200` `EvaluationDecision` |
| POST | `/v1/demo/scenarios/{scenario}` | `204` |

There is **no** update/PATCH route, no delete, no per-user anything, and no
route that lists offers or orders as first-class resources — offer history is
reachable only through the event log.

Errors are always `{"error":"<message>"}` with `400` (validation), `404`
(unknown monitor), `409` (illegal state transition), `500` (storage).

---

## 4. Wire types (exact field names, from the serde derives)

Money is **integer minor units** and every field is suffixed `_minor`, not
`_cents`. Timestamps are RFC 3339 UTC. Ids are UUID strings; event ids are
integers.

### 4.1 `Monitor`

```json
{
  "id": "89fc47a5-17e5-4ea4-959d-2fbdb639dbdc",
  "url": "https://shop.example/products/console",
  "product": {
    "name": "Example Console",
    "brand": "Example",
    "model": "X1",
    "identifiers": { "sku": "X1-001" }
  },
  "constraints": {
    "maximum_total_minor": 45000,
    "currency": "EUR",
    "condition": "new",
    "variants": { "color": "black" },
    "bundles_allowed": false,
    "approved_retailers": ["shop.example"]
  },
  "deadline": "2026-12-31T23:59:59Z",
  "status": "active",
  "check_interval_seconds": 60,
  "created_at": "2026-09-12T12:00:00Z"
}
```

`product` is `null`-able. `identifiers` and `variants` are free-form
`Record<string,string>` maps. `condition` is `"new" | "refurbished" | "used" |
"unknown" | null`.

### 4.2 `NormalizedOffer`

```json
{
  "product": { "name": "...", "brand": null, "model": null, "identifiers": {} },
  "retailer": "shop.example",
  "available": true,
  "item_price_minor": 44000,
  "shipping_minor": 500,
  "total_minor": 44500,
  "currency": "EUR",
  "condition": "new",
  "variants": { "color": "black" },
  "source_url": "https://shop.example/products/console",
  "checked_at": "2026-09-12T12:05:00Z"
}
```

Every price field, `currency` and `condition` are nullable — a page that does not
publish them yields `null`, which the rule engine treats as a rejection (§5.2).

### 4.3 `MonitorEvent`

```json
{
  "id": 1,
  "monitor_id": "89fc47a5-...",
  "kind": "monitor_created",
  "payload": {},
  "created_at": "2026-09-12T12:00:00Z"
}
```

`payload` is an arbitrary JSON object whose shape depends on `kind` — see §6.

### 4.4 `POST /v1/monitors` request

```json
{
  "url": "https://shop.example/products/console",
  "product": null,
  "constraints": { "...": "as in Monitor" },
  "deadline": "2026-12-31T23:59:59Z",
  "check_interval_seconds": 60
}
```

Server-side validation, all `400` on failure:

- `constraints.maximum_total_minor > 0`
- `constraints.currency` non-blank (**not** validated as ISO-4217)
- `deadline` strictly in the future — **no 7-day ceiling is enforced here**; the
  ≤7-day clamp from PAYMENTS.md is a frontend/P4 rule, this service will happily
  accept 2030
- `10 <= check_interval_seconds <= 86400`, defaults to `60` if omitted
- `url` is http(s), no embedded credentials, host is not localhost/private/link-local

That last rule matters for development: **you cannot monitor a page served from
`localhost`.** A local fixture store is not reachable by this backend; use the
demo-offer endpoint (§7) instead.

`product` is optional. When omitted, the first successful scrape *establishes*
the baseline and explicitly **cannot** trigger checkout on that pass.

---

## 5. The decision model

### 5.1 Monitor lifecycle

The declared `MonitorStatus` set is `active`, `evaluating`, `executing`,
`purchased`, `payment_required`, `failed`, `expired`, `cancelled`.

**Only six of those are ever observable.** Grepping every `SET status=` in
`persistence`: nothing writes `evaluating`, and `fail_execution` writes
`active` or `payment_required` — never `failed`. So a client will see:

```
active ──► executing ──► purchased            (terminal)
   │           │
   │           ├──────► payment_required ──► (cancel / expire)
   │           └──────► active               (retry next tick)
   ├──────► expired                          (deadline passed)
   └──────► cancelled                        (user cancelled)
```

Still, type the union with all eight and degrade unknown values to a generic
label — the states exist in the enum and could start being written.

- `cancel` succeeds only from `active`, `evaluating`, `payment_required`,
  `failed`; anything else is `409`. So **cancelling a `purchased` or already
  `cancelled` monitor returns 409, not a no-op** — handle it as "already
  settled", not as an error worth alarming the user about.
- Expiry is swept by the worker (`deadline <= now` and status in
  `active`/`evaluating`/`failed`), so an expired monitor may read `active` for up
  to one worker tick after its deadline.

### 5.2 `evaluate()` — the whole gate, deterministic, no model

`rule-engine` collects **all** failing reasons rather than short-circuiting, then
returns `Qualified` only if the list is empty. Checks, in order:

1. status must be `active`/`evaluating`/`executing` → `monitor_not_active`
2. `now >= deadline` → `deadline_expired`
3. product identity: any matching identifier **or** model match (case-insensitive);
   falls back to comparing `name` when either model is absent → `product_mismatch`
4. every constraint variant must be present and equal → `variant_mismatch`
5. `bundles_allowed == false` and `variants["bundle"]` is set to anything other
   than `"none"`/`"false"` → `bundle_not_allowed`
6. condition equality when constrained → `condition_mismatch`
7. `approved_retailers` non-empty and no case-insensitive match → `retailer_not_approved`
8. `available == false` → `out_of_stock`
9. currency missing → `currency_unknown`; mismatched → `currency_mismatch`
10. `item_price_minor == null` → `item_price_unknown`
11. `shipping_minor == null` → `shipping_unknown`
12. `total_minor == null` → `total_unknown`; `total > maximum` → `total_above_maximum`

`total == maximum` **qualifies** (boundary is inclusive; there is a test for it).

This is the same spirit as CONTRACTS.md's "the gate": code decides, never a model.
Note it is one function, applied identically by the worker and by the demo
endpoint, and applied **twice** on the buy path (once on the observed offer, once
on the re-read).

### 5.3 `EvaluationDecision` JSON — mind the struct variants

Internally tagged on `result`:

```json
{ "result": "qualified" }
```

```json
{
  "result": "rejected",
  "reasons": [
    "out_of_stock",
    { "total_above_maximum": { "maximum": 45000, "actual": 47500 } },
    { "variant_mismatch": { "key": "edition", "expected": "digital", "actual": "disc" } }
  ]
}
```

**A reason is either a string or a single-key object.** `API.md` lists them all
as flat strings, which is wrong for the two data-carrying variants
(`total_above_maximum`, `variant_mismatch`). Parse defensively:

```ts
type RejectionReason =
  | 'monitor_not_active' | 'deadline_expired' | 'product_mismatch'
  | 'bundle_not_allowed' | 'condition_mismatch' | 'retailer_not_approved'
  | 'out_of_stock' | 'currency_unknown' | 'currency_mismatch'
  | 'item_price_unknown' | 'shipping_unknown' | 'total_unknown'
  | { total_above_maximum: { maximum: number; actual: number } }
  | { variant_mismatch: { key: string; expected: string; actual: string | null } };
```

`variant_mismatch.actual` is `null` when the offer simply lacks that axis.

### 5.4 Execution path (`ExecutionEngine::execute`)

Reached only when the worker sees `Qualified`:

1. `find_order(key)` first — if an order already exists for this idempotency key,
   return it and buy nothing.
2. `merchant.supports(offer)` → else `UnsupportedMerchant`. **`DemoMerchant`
   supports exactly `retailer == "demo"` (case-insensitive).**
3. Requires a payment authorization with `maximum_minor >= offer.total_minor`
   and the same currency → else `MissingPaymentAuthorization`.
4. `claim_execution` atomically moves `active|evaluating → executing` and inserts
   an attempt row. A unique partial index enforces **one successful execution per
   monitor** at the database level.
5. **Re-reads the page** (`source.revalidate`) and re-evaluates against the
   *freshly loaded* monitor. A price that moved above the ceiling in between
   fails here, not at capture — this is CONTRACTS.md's mandatory re-read,
   already implemented.
6. `merchant.checkout(..., key)` where `key = "monitor:<uuid>"` — derived from
   the monitor, stable across retries, exactly the shape CONTRACTS.md demands.
7. Outcome: `Confirmed` → `purchased` + `purchase_confirmed`, job row deleted;
   `PaymentRequired` → `payment_required`; `Declined` → back to `active`;
   `Unknown` → **queries the merchant for the order before deciding**, so a
   checkout that timed out after the order landed is recovered instead of retried.

### 5.5 Scheduling

- Worker loop: claim one due job with a **45 s lease**, else sleep 500 ms.
- Success → next check in `check_interval_seconds`.
- Failure → `interval * 2^min(consecutive_failures,6)`, capped at **3600 s**.
- Purchase or cancel deletes the job row; monitoring stops.

---

## 6. Event kinds (the audit log you can render today)

Every kind emitted anywhere in the codebase, with its payload:

| `kind` | Payload | Emitted when |
| --- | --- | --- |
| `monitor_created` | `{ url }` | monitor created |
| `initial_offer_observed` | `{ offer }` | first scrape on a monitor with no `product` |
| `product_baseline_established` | `{ product }` | baseline written |
| `offer_evaluated` | `{ offer_id, decision }` | **every** evaluation, qualified or rejected |
| `monitor_check_failed` | `{ error }` | fetch/extraction threw |
| `payment_authorized` | `{ authorization_id, maximum_minor, currency }` | authorization created |
| `execution_started` | `{ attempt_id }` | `claim_execution` |
| `purchase_confirmed` | `{ order_id }` | order confirmed |
| `payment_required` | `{ error }` | checkout needs authentication |
| `execution_failed` | `{ error }` | declined / revalidation failed / unknown result |
| `qualified_offer_not_executed` | `{ error }` | engine refused before attempting — e.g. `"no payment authorization covers this purchase"`, `"retailer does not support automatic checkout"` |
| `monitor_cancelled` | `{}` | cancel |
| `monitor_expired` | `{}` | deadline swept |

Two notes for the decision-log UI:

- `offer_evaluated.decision` carries the **full reason list**, so the rejected
  offers in the demo narrative are all recoverable from the event log — you do
  not need an offers endpoint.
- The `offer_id` in the payload refers to a row in the `offers` table that **no
  HTTP route exposes**. Treat it as an opaque correlation id; the offer body
  itself is only in `initial_offer_observed`.

### SSE

`GET /v1/monitors/{id}/events/stream` — SSE `id` = event id, SSE `event` =
`kind`, `data` = the whole event object. Implemented as a 1-second poll of the
events table behind the stream, with keep-alive.

Because it is `EventSource`-shaped, the side panel can replace the planned 5 s
polling with a stream per open monitor. Caveat: **it never terminates**, even
after a terminal status — close it yourself on `purchase_confirmed` /
`monitor_cancelled` / `monitor_expired`. `EventSource` works in an MV3 side
panel; it does not work in a service worker you expect to be suspended.

---

## 7. Demo endpoints — the useful lever

### `POST /v1/demo/offers/{monitor_id}`

Body is a full `NormalizedOffer`; returns the `EvaluationDecision` and records an
`offer_evaluated` event. **It does not execute checkout** — it is pure
evaluate-and-log.

This is the cleanest way to drive the whole UI without scraping: create a
monitor, then POST the four `fixtures/offers.json` offers at it and watch the
audit log and SSE stream fill in with real backend verdicts.

### `POST /v1/demo/scenarios/{scenario}`

`success` · `payment_required` · `declined` · `timeout_before_order` ·
`timeout_after_order`.

Two constraints worth designing around: the selection is **process-global, not
per monitor** (it changes the outcome for every monitor at once), and it **resets
to `success` on restart**. If a settings screen exposes it, present it as a
global demo switch.

---

## 8. Gap map: CONTRACTS.md / the P2 plan vs. this backend

The extension is being written against CONTRACTS.md. Almost none of that surface
exists in this service. Endpoint by endpoint:

| CONTRACTS.md | This backend | Notes |
| --- | --- | --- |
| `POST /auth/login`, `GET /auth/me`, `Bearer` on everything | **absent** | no auth, no users table, no per-user scoping. `GET /v1/monitors` returns *all* monitors globally. The 401 interceptor will never fire |
| `POST /understand` (screenshot → canonical + `constraint_schema` + confidence) | **absent** | no screenshot input anywhere. Extraction is server-side HTML parsing of a URL. **There is no `constraint_schema`, so nothing feeds the generic renderer** |
| `POST /discover` (Exa cross-retailer candidates) | **absent** | no `candidates` concept at all. One monitor watches exactly one URL |
| `POST /adjudicate` (verdict + reason prose + `alternative`) | `rule-engine` internally; `POST /v1/demo/offers/{id}` externally | returns machine reasons, **no human-readable `reason` string, no `alternative`, no confidence** |
| `POST /instructions` | `POST /v1/monitors` | closest match. No `quantity`, no `retailers[]` at top level (it is `constraints.approved_retailers`), no `funds` block in the response |
| `GET /instructions` | `GET /v1/monitors` | maps well, minus `last_checked_at` (tracked in `monitor_jobs`, **not exposed**) |
| `GET /instructions/:id` | `GET /v1/monitors/{id}` + `/events` | two calls. No `mandate`/`funds`/`offers`/`purchase` aggregate — you assemble it from the event log |
| `POST /instructions/:id/cancel` | `POST /v1/monitors/{id}/cancel` | `204` empty, not `{status, released_cents}` |
| `POST /instructions/:id/substitute` | **absent** | no `AWAITING_APPROVAL` state, no `pending_alternative`. **A1 is unimplementable against this backend** |
| `POST /offers` | `POST /v1/demo/offers/{id}` | demo-namespaced, returns the decision synchronously instead of `{offer_id, queued}` |
| `POST /funds/commit` / `/release` | `POST /v1/monitors/{id}/payment-authorizations` | records a row and emits an event. **No Stripe, no `client_secret`, no `expires`, no release route.** `provider_reference` is the literal string `demo-<uuid>` |
| `POST /checkout` | internal only | never reachable over HTTP; the worker triggers it |
| `DECLINED` / `amount_too_large` from Stripe | `DemoMerchant` scenario `declined` → `"demo payment declined"` | **A2's literal Stripe reason does not exist.** The over-ceiling case is refused by `evaluate()` as `total_above_maximum` — i.e. by application code, which is exactly what CONTRACTS.md says must *not* happen for fixture 4 |

Naming and shape differences that will bite on every field:

| CONTRACTS.md | Backend |
| --- | --- |
| `*_cents` | `*_minor` |
| `total_cents` (delivered, all-in) | `total_minor`, **nullable**, and only computed when *both* price and shipping were found |
| `max_total_cents` | `constraints.maximum_total_minor` |
| `ARMED`, `EVALUATING`, `PURCHASED` (SCREAMING) | `active`, `executing`, `purchased` (snake_case) |
| `verdict: "QUALIFIES" \| "REJECTED"` | `result: "qualified" \| "rejected"` |
| `instruction_id` | `monitor.id` |
| `candidate_id`, `offer_id` as client-visible handles | no candidates; `offer_id` only inside an event payload |
| `retailer: "amazon"` | `retailer` = **hostname minus `www.`**, e.g. `"amazon.es"` |

### Three behavioural traps

1. **`total_minor` is usually `null` on a real page.** It is only set when JSON-LD
   yields *both* `offers.price` and `offers.shippingDetails.shippingRate`. Most
   pages omit shipping, so a live monitor on a real store typically logs
   `["shipping_unknown","total_unknown"]` forever. The pipeline is honest —
   "a price without shipping is not a price" — but a demo driven by real URLs
   will show rejections, not purchases.
2. **Automatic checkout only ever fires for `retailer == "demo"`**, and `retailer`
   is derived from the hostname. No real store URL can reach `purchased`; it
   stops at `qualified_offer_not_executed` with
   `"retailer does not support automatic checkout"`. Say this plainly in the UI
   rather than implying a merchant order happened.
3. **Extraction has no AI.** `ProductInterpreter::new()` registers zero retailer
   extractors and no AI provider, so the chain is JSON-LD → OpenGraph/meta →
   `InsufficientData`. Pages that render price in JS extract nothing, which
   surfaces as `monitor_check_failed`.

---

## 9. What I'd suggest for the frontend session

Nothing above says to change course — the P2 plan targets CONTRACTS.md and that
is still the agreed target. It does say **keep `VITE_MOCK=1` as the default and
do not treat a live backend as the near-term integration path**, because
`/understand`, `/discover`, `/adjudicate`, auth, substitution and Stripe have no
server behind them at all. The generic renderer in particular is driven by
`constraint_schema`, which nothing currently emits; it has to stay mock-fed.

Where a real backend *is* worth wiring, it is one thin adapter, not a rewrite:

- **Watch list + audit log + cancel** map onto `/v1/monitors`, `/events` and
  `/cancel` today. That is the whole of `WatchListView` and `DecisionAudit`.
- **Arming** maps onto `POST /v1/monitors` if the mandate form can emit
  `constraints.maximum_total_minor` — the ceiling is genuinely enforced, twice.
- **Live updates** are better served by the SSE stream than by 5 s polling.

Concretely: put the translation in one module (`services/monitorsAdapter.ts`)
behind the existing `VITE_MOCK` switch — `cents ↔ minor`, status upcasing,
`decision → verdict`, event-log → `offers[]` — so `api.types.ts` keeps mirroring
CONTRACTS.md verbatim and the divergence lives in exactly one file. Then build
the demo beats on `POST /v1/demo/offers/{id}`, which gives real backend verdicts
with real reason codes and needs no scraping.

Four things need a human decision, not an adapter — worth raising with P1
rather than guessing:

1. Does `main` adopt the Rust service (merge `rusty`), or does P1 build the
   CONTRACTS.md surface separately and leave `rusty` as a parallel prototype?
2. Who serves `/understand` and `constraint_schema`? Without it, Beat 2 of the
   demo has no source.
3. Fixture 4 is supposed to be refused by the payment layer, not by our code.
   This backend refuses it in `evaluate()` as `total_above_maximum`. Either the
   demo narrative changes or a real payment layer has to exist.
4. `AWAITING_APPROVAL` / substitution has no backend counterpart and no place to
   come from — the rule engine emits no `alternative`.
