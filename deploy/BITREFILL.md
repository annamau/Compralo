# Bitrefill first vertical slice

Status: implemented for local/pilot validation. This does not replace Stripe/Zinc or turn gift cards into physical-product checkout.

## What ships

The extension reads the current article and displays its matched gift card directly in the side panel. `/bitrefill` remains a developer diagnostic page; it is no longer linked from the extension. One-time OAuth setup still opens the provider authorization page. OAuth credentials remain encrypted in SQLite; the browser receives only an HttpOnly, SameSite session cookie and a CSRF token. The existing restock UI is retained.

- OAuth discovery, S256 PKCE, single-use state, encrypted access/refresh tokens, refresh rotation and disconnect.
- MCP discovery for the current credential; required tool fields checked at connection and before invoice creation. Actual hosted tool names and `package_value` are used, including the required search `intent`.
- TOON/JSON/SSE decoding. Live catalog responses are filtered again by country; Bitrefill search was observed returning other countries despite the country argument.
- Country-specific gift cards only, a fixed package, one item, Bitcoin payment link. No sending gifts to others, recipient phone/email collection, balance, cashback, saved-card debit, bills or retailer redemption in this slice.
- EUR catalog-price cap of 10 per invoice request; conservative global 50 EUR rolling-24-hour catalog budget, including uncertain requests. These limits are not a guarantee about final exchange rates, wallet/network fees or what a user independently pays on Bitrefill.
- Persisted 5-minute approvals bound to canonical product, country, package, quantity, price, payment method, instructions and restrictions. Product details re-fetched immediately before mutation.
- Atomic database claim before `buy-products`. The quote UUID is the server-generated local idempotency key. Hosted MCP has no advertised provider idempotency argument, so it is never invented or sent. Concurrent/repeated requests cannot resubmit the same quote, even across worker restarts.
- Uncertain invoice creation remains `reconciliation_required`. If no invoice ID came back, stop for manual reconciliation; `list-invoices` omits unpaid invoices and cannot safely prove absence. No blind retry.
- Invoice polling at most every 15 seconds while the page is open; reopening a saved request resumes polling. Errors remain pending/reconciliation, not a claim of refund or cancellation.
- Delivery encrypted at rest, omitted from regular order responses, explicitly revealed with a CSRF-protected audited action. The browser masks the revealed delivery again after 60 seconds.
- No generic provider responses, tokens, codes or payment links in application events. CSP and no-store/no-referrer headers on this entire route group.

## Necessary refinement to the proposal

`get-product-details(currency=EUR)` returns a catalog price, not an exact all-in Bitcoin invoice quote. This release therefore separates **approval to create an invoice** from **approval to pay**. It prominently labels the EUR amount as an estimate. The user reviews the actual crypto total, exchange rate, fees and expiry on Bitrefill and approves payment in their wallet. Compralo never signs or sends a wallet transaction. Automatic payment remains disabled in code, including test products.

The existing `execution::Merchant` trait represents automatic physical-product checkout after a Stripe hold. This slice deliberately has its own explicitly approved API and is not registered with the monitor worker. It must not inherit that worker's automatic purchase authority. A general-purpose merchant adapter, stable cross-device Compralo identities, SSE/background poller and product categories beyond gift cards are later work.

## Configuration

Set these only in the Rust server environment (`deploy/.env` when using the full Compose stack):

```dotenv
BITREFILL_PUBLIC_ORIGIN=https://34-175-42-226.sslip.io
BITREFILL_ENCRYPTION_KEY=<32 random bytes, base64url encoded without padding>
BITREFILL_PURCHASES_ENABLED=false
# Optional pre-registered public OAuth client ID; normally leave unset.
BITREFILL_CLIENT_ID=
```

Generate an encryption key locally, store it in the server's secret configuration, and keep it out of Git. Keep the same key across deployments and backups; losing it makes existing encrypted sessions and delivery data unreadable. This environment encryption key is server configuration, not a Bitrefill API key.

The public HTTPS deployment publishes its OAuth Client ID Metadata Document at `/bitrefill/oauth-client.json`. Bitrefill must be able to retrieve that document publicly. Loopback development uses dynamic registration once and persists the client ID; no user Bitrefill API key is required. OAuth redirect URI is exactly `<BITREFILL_PUBLIC_ORIGIN>/v1/integrations/bitrefill/oauth/callback`.

Set `BITREFILL_PURCHASES_ENABLED=true` only when ready to let explicitly approved users create invoices. `false` blocks new invoice requests, but still permits reading/reconciling previous orders. Restart to change this switch. Default is disabled. Removing `BITREFILL_PUBLIC_ORIGIN` disables the integration routes without affecting the old monitor flow.

Deploy one Rust replica for this first slice: token refresh is serialized within the process, while invoice claiming is atomic in SQLite. Keep the existing persistent `/data` volume. Caddy already routes these paths to Rust. Do not enable access logs that record OAuth callback query parameters or payment URLs. Audit events contain only local order IDs, fixed event names and timestamps.

Build/check:

```sh
cargo test -p bitrefill --lib
cargo test -p server --lib
cargo build --locked -p server
```

For isolated local development, set `BITREFILL_PUBLIC_ORIGIN=http://127.0.0.1:8082`, `BIND_ADDR=127.0.0.1:8082`, the encryption key and a SQLite `DATABASE_URL`, then:

```sh
cargo run -p bitrefill --example serve
```

The same routes run inside the main Rust binary. The standalone example just avoids requiring Spider/Stripe/Zinc while developing this independent slice. A separate loopback origin is intentional so the already-running demo services remain untouched.

## Provider test prerequisites and evidence

Local tests exercise approval/hash/expiry, country/cap checks, CSRF/session isolation, concurrent requests, restart-safe uncertainty, encryption/tampering, masked delivery, cancellation, kill switch and tool-schema compatibility against a mock provider. The TOON product fixture and tool discovery fixture were captured from the live authenticated read-only API on 2026-09-12. No credential is in those fixtures.

Live discovery, Spain gift card details, OAuth authorization and an authenticated gift-card search using the connected account have been exercised. The Amazon.es fixture distinguishes a 5 EUR face value from its 5.12 EUR catalog price. Thirteen automated tests pass, including rejection of eSIM details and pre-migration unclassified searches. Provider invoice/payment/delivery testing is pending: the user's account does not yet have Bitrefill test products enabled. Do not describe the mock-provider tests as a real Bitrefill purchase.

Ask Bitrefill to enable `delos-syldavia` on the user's account. Test country is `KN`. Use Bitcoin/payment-link mode, not account balance: Bitrefill warns that balance payment can debit real funds even for test products. Once enabled:

1. Connect through `/bitrefill` using that account.
2. Search country `KN`, select the enabled test gift card and a denomination within the pilot limit.
3. Review and approve invoice creation; test-only provider invoices should confirm without sending funds.
4. Observe delivery, reveal the result, reload and verify the same invoice remains.
5. Repeat the local request ID and verify no second invoice is created.

If Bitrefill exposes different schemas/prices for that test product, fail closed and update the normalization with recorded provider evidence. Do not substitute a production gift card silently. Any real wallet payment stays with the user.

Sources: [Partner integration guide](https://docs.bitrefill.com/docs/mcp-partner-integration-guide), [hosted eCommerce MCP](https://docs.bitrefill.com/docs/ecommerce-mcp).

## Article matching in the extension

`POST /v1/bitrefill/match` binds the article URL, name, listed price, currency and country into a persisted review. The first verified mapping is Amazon Spain → `amazon_es-spain`. The smallest denomination covering the article's listed price is selected; a card below that amount is never substituted. Shipping and item-specific eligibility are not guaranteed. Unknown retailers, mismatched currencies/regions and amounts exceeding the pilot cap fail closed.

Set `BITREFILL_EXTENSION_ORIGIN=chrome-extension://<your exact installed extension ID>` on Rust to accept CSRF-protected mutations from that extension only. Host permissions and an HttpOnly browser session are still required. OAuth credentials never enter extension storage. The same browser profile must complete the one-time connection.

The inline flow currently supports matching and review only: `checkout_enabled` is false. The existing provider adapter requires a separately funded payment link, so enabling `BITREFILL_PURCHASES_ENABLED` does not make inline automatic payment available. No gift card is purchased by matching an article. A funded checkout mechanism is still required before enabling the inline Buy button.
