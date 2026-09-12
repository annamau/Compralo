# Compralo Rust API

Compralo monitors public product pages, normalizes observed offers, evaluates them against deterministic purchase constraints, and records a durable event history. The current checkout adapter is a demo implementation; it does not place real merchant orders.

## Base URL and conventions

Local Docker base URL:

```text
http://localhost:8080
```

Current GCP Madrid deployment:

```text
https://34-175-42-226.sslip.io
```

Requests and responses use JSON unless noted otherwise. Timestamps use RFC 3339 UTC strings, IDs are UUIDs, currencies use uppercase ISO 4217 codes, and monetary values are integers in the currency's minor unit. For example, `45000` EUR means EUR 450.00.

The API currently has permissive CORS and no authentication. Put authentication and TLS in front of it before exposing it to untrusted clients.

Error responses have this shape:

```json
{
  "error": "human-readable message"
}
```

Common statuses are `400` for invalid input, `404` when a monitor does not exist, `409` for an invalid state transition, and `500` for a storage failure.

## Data types

### Monitor

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

`product` may be `null` at creation. In that case, the first successfully extracted offer establishes the canonical product baseline and cannot trigger checkout. Monitor status is one of `active`, `evaluating`, `executing`, `purchased`, `payment_required`, `failed`, `expired`, or `cancelled`. Product condition is `new`, `refurbished`, `used`, `unknown`, or `null`.

### Normalized offer

```json
{
  "product": {
    "name": "Example Console",
    "brand": "Example",
    "model": "X1",
    "identifiers": { "sku": "X1-001" }
  },
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

Price, currency, condition, and shipping fields can be `null` when a page does not expose them.

## Endpoints

### Health check

`GET /health`

Returns `200 OK`:

```json
{ "status": "ok" }
```

### Create a monitor

`POST /v1/monitors`

```bash
curl -X POST "$BASE_URL/v1/monitors" \
  -H 'content-type: application/json' \
  -d '{
    "url": "https://shop.example/products/console",
    "product": null,
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

Returns `201 Created` with the new `Monitor`. `product` is optional. `check_interval_seconds` defaults to `60` and must be between `10` and `86400`. The deadline must be in the future, the maximum must be positive, and the URL must be public HTTP(S) without embedded credentials.

### List monitors

`GET /v1/monitors`

Returns `200 OK` with an array of `Monitor` objects.

### Get a monitor

`GET /v1/monitors/{id}`

Returns `200 OK` with one `Monitor`, or `404 Not Found`.

### Cancel a monitor

`POST /v1/monitors/{id}/cancel`

Returns `204 No Content`. A completed or otherwise incompatible state transition can return `409 Conflict`.

### List monitor events

`GET /v1/monitors/{id}/events`

Returns `200 OK` with events ordered by their integer ID:

```json
[
  {
    "id": 1,
    "monitor_id": "89fc47a5-17e5-4ea4-959d-2fbdb639dbdc",
    "kind": "monitor_created",
    "payload": {},
    "created_at": "2026-09-12T12:00:00Z"
  }
]
```

The exact `payload` depends on `kind`.

### Stream monitor events

`GET /v1/monitors/{id}/events/stream`

Returns a `text/event-stream` Server-Sent Events response. Each event uses the database event ID as the SSE `id`, its kind as the SSE `event`, and the complete event object as JSON `data`.

```bash
curl -N "$BASE_URL/v1/monitors/$MONITOR_ID/events/stream"
```

### Create a payment authorization

`POST /v1/monitors/{id}/payment-authorizations`

```bash
curl -X POST "$BASE_URL/v1/monitors/$MONITOR_ID/payment-authorizations" \
  -H 'content-type: application/json' \
  -d '{ "maximum_minor": 45000, "currency": "EUR" }'
```

Returns `201 Created`:

```json
{ "id": "ab51a4e3-f837-4675-8313-991adff6a215" }
```

The authorization must cover the monitor maximum and use the same currency. This endpoint records an authorization for the demo workflow; it does not collect real payment credentials.

## Demo-only endpoints

These endpoints exercise deterministic evaluation and simulated checkout behavior.

### Submit a normalized offer

`POST /v1/demo/offers/{monitor_id}`

The body is a `Normalized offer`. Returns `200 OK` with an evaluation decision, such as:

```json
{ "result": "qualified" }
```

or a rejected decision carrying one or more reasons:

```json
{
  "result": "rejected",
  "reasons": [
    "out_of_stock",
    { "total_above_maximum": { "maximum": 45000, "actual": 47500 } }
  ]
}
```

Possible rejection reasons are `monitor_not_active`, `deadline_expired`, `product_mismatch`, `variant_mismatch`, `bundle_not_allowed`, `condition_mismatch`, `retailer_not_approved`, `out_of_stock`, `currency_unknown`, `currency_mismatch`, `item_price_unknown`, `shipping_unknown`, `total_unknown`, and `total_above_maximum`.

### Select checkout scenario

`POST /v1/demo/scenarios/{scenario}`

Supported scenarios are `success`, `payment_required`, `declined`, `timeout_before_order`, and `timeout_after_order`. Returns `204 No Content`. The selected scenario is process-local and resets when the server restarts.

## OpenAPI

`GET /openapi.json` returns the service's current OpenAPI 3.1 document. At version 0.1.0 it is only a route summary; this Markdown file is the more complete reference.

## Runtime configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `SPIDER_CLOUD_API_KEY` | Yes | none | Spider Cloud fallback for blocked or failed direct crawls |
| `DATABASE_URL` | No | `sqlite://buy-agent.sqlite?mode=rwc` | SQLite connection URL |
| `BIND_ADDR` | No | `127.0.0.1:3000` | HTTP listen address |
| `RUST_LOG` | No | library default | Tracing filter |

For Docker, the supplied image defaults to port `8080` and stores SQLite at `/data/buy-agent.sqlite`. Mount `/data` on durable storage.
