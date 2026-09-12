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

## Verify

```sh
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
```
