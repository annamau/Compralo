# Compralo Rust backend

Persistent product URL monitoring and deterministic buy-order evaluation.

## Run

```sh
cargo run -p server
```

The server listens on `127.0.0.1:3000` and creates `buy-agent.sqlite` by
default. Override these with `BIND_ADDR` and `DATABASE_URL`.

To use a local environment file:

```sh
cp .env.example .env
cargo run -p server
```

`SPIDER_CLOUD_API_KEY` is required. Direct crawling is attempted first and
Spider Cloud is used as a fallback for blocked or failed requests. `RUST_LOG`
is optional. No AI API key is currently required because the AI provider
integration is defined but disabled by default.

## Create a monitor

```sh
curl -X POST http://127.0.0.1:3000/v1/monitors \
  -H 'content-type: application/json' \
  -d '{
    "url": "https://example.com/product",
    "constraints": {
      "maximum_total_minor": 45000,
      "currency": "EUR",
      "condition": "new",
      "variants": {},
      "bundles_allowed": false,
      "approved_retailers": []
    },
    "deadline": "2026-12-31T23:59:59Z",
    "check_interval_seconds": 60
  }'
```

If `product` is omitted, the first successful scrape establishes the canonical
product baseline and cannot trigger checkout. Later offers are evaluated against
that baseline. Generic URLs can be monitored, but automatic checkout is limited
to explicitly supported merchant adapters.

Useful endpoints:

- `GET /health`
- `GET /v1/monitors`
- `GET /v1/monitors/{id}`
- `POST /v1/monitors/{id}/cancel`
- `GET /v1/monitors/{id}/events`
- `GET /v1/monitors/{id}/events/stream`
- `POST /v1/monitors/{id}/payment-authorizations`
- `GET /openapi.json`

## P4 money

`MERCHANT` chooses who holds the money and places the order. The default, `demo`,
is self-contained and spends nothing. `p4` talks to the P4 money service over
HTTP: a Stripe mandate hold at arm time, an aggregator order at buy time.

```sh
cd ../Compralo/money && PORT=4242 npm start   # P4 on :4242, sandbox keys only

MERCHANT=p4 P4_URL=http://localhost:4242 cargo run -p server
```

| Variable | Default | Meaning |
|---|---|---|
| `MERCHANT` | `demo` | `demo` or `p4` |
| `P4_URL` | `http://localhost:4242` | P4's base URL; only read when `MERCHANT=p4` |
| `P4_DEMO_FALLBACK` | `0` | Also treat retailer `demo` as covered under `MERCHANT=p4` |

What changes with `p4`:

- `POST /v1/monitors/{id}/payment-authorizations` calls `POST /funds/commit` and
  stores the returned Stripe `hold_id` as the authorization's
  `provider_reference`. It answers `{ id, hold_id, expires, status }`. A
  `needs_attention` status means the bank wants 3DS: the monitor moves to
  `payment_required` and the checker stops until the user confirms in the panel.
- Checkout goes to `POST /checkout`, keyed `monitor:{id}` so a retry never buys
  twice. `PURCHASED` confirms, `NEEDS_ATTENTION` asks for payment, `DECLINED`
  and `FAILED` decline with the provider's own reason, and `UNKNOWN` — or a
  timeout — stays unknown so the engine verifies with `GET /purchases/{key}`
  before doing anything else.
- `supports()` filters against `GET /coverage`, cached 60 s. A watch on an
  uncovered retailer is a stock alert, not an order.
- Cancelling a monitor and expiring one both call `POST /funds/release`,
  best effort — the state change never waits on the money service.
- `POST /v1/demo/offers/{id}` runs the offer through the gate and, when it
  qualifies, executes it against the selected merchant. Under `MERCHANT=p4`
  that is the only way to drive a purchase over HTTP, because the checker
  cannot crawl a Zinc sandbox slug. It answers the decision plus an
  `execution` object; a rejected offer has no `execution` and buys nothing.

### The demo, end to end

```sh
ID=$(curl -sX POST 127.0.0.1:3000/v1/monitors -H 'content-type: application/json' -d '{
  "url":"https://zinc.com/shop/products/test-success",
  "product":{"name":"PS5 Slim Digital","brand":"Sony","model":"CFI-2016B","identifiers":{}},
  "constraints":{"maximum_total_minor":25000,"currency":"EUR","condition":"new",
    "variants":{},"bundles_allowed":false,"approved_retailers":["amazon"]},
  "deadline":"2026-09-15T12:00:00Z","check_interval_seconds":3600}' | jq -r .id)

# One tap: authorize the €250 ceiling. Answers a real Stripe pi_… hold.
curl -sX POST 127.0.0.1:3000/v1/monitors/$ID/payment-authorizations \
  -H 'content-type: application/json' -d '{"maximum_minor":25000,"currency":"EUR"}'

# €248 qualifies: Stripe captures 24800, Zinc places the order, status -> purchased.
curl -sX POST 127.0.0.1:3000/v1/demo/offers/$ID -H 'content-type: application/json' -d '{
  "product":{"name":"PS5 Slim Digital","brand":"Sony","model":"CFI-2016B","identifiers":{}},
  "retailer":"amazon","available":true,"item_price_minor":24800,"shipping_minor":0,
  "total_minor":24800,"currency":"EUR","condition":"new","variants":{},
  "source_url":"https://zinc.com/shop/products/test-success","checked_at":"2026-09-12T12:00:00Z"}'

curl -s 127.0.0.1:3000/v1/monitors/$ID/events | jq -r '.[] | "\(.kind) \(.payload)"'
```

Swap `total_minor` to `46500` and the gate rejects it on `TotalAboveMaximum`
before P4 is called at all — no `execution_started`, the monitor keeps watching.

**The ceiling is not enforced in this process.** Checkout sends the offer total
to P4 without comparing it to the mandate first, and lets Stripe refuse an
over-mandate capture with `amount_too_large`. Note that P1's gate rejects an
over-mandate offer earlier, on `TotalAboveMaximum`, so that refusal is only
reachable by calling P4 directly.

## Verify

```sh
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```

The P4 wiring tests skip themselves unless the money service is up:

```sh
P4_URL=http://localhost:4242 cargo test -p server --test p4_wiring -- --nocapture
```
