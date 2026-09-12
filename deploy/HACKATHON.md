# Cloud demo deployment

This branch contains the tested AI reader, current Rust fixes and the extension dashboard. The implementation lives in `autobuy/packages/backend/src/`, **not** `intelligence/`. `llm.ts` selects OpenRouter/Anthropic; `claude.ts` implements product reading; `audit.ts` records usage. `INTELLIGENCE_ONLY=true` disables the Node monitor loops. Rust owns the buy orders.

## Deploy

1. Obtain this branch on the VM. If integrating it into another Rust branch, merge it and resolve against the current VM code; do not discard your teammate's changes.
2. Preserve the VM's existing SQLite volume, Compose project identity, Spider key and TLS setup. Adapt `deploy/compose.yaml` to the existing deployment if it uses different service/volume names. Never run `down -v`.
3. Create `deploy/.env` from `.env.example` and install the separately shared secrets: `STRIPE_SECRET_KEY`, `ZINC_API_KEY`, `OPENROUTER_API_KEY`, existing `SPIDER_CLOUD_API_KEY`. Keep Anthropic empty to use the tested OpenRouter path. Set `DOMAIN=34-175-42-226.sslip.io` and `SANDBOX_RETAILERS=34-175-42-226.sslip.io` for this demo store. `chmod 600 deploy/.env`.
4. From the repository root, after reconciling the existing deployment:

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml config --quiet
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build
```

Services: Rust `core:8080` with `MERCHANT=p4`, `P4_URL=http://money:4242`; money `money:4242`; AI `backend:3000`; demo store `demo-store:4011`. Only Caddy publishes ports. The existing market simulator remains internal for legacy money fixtures. `/understand` and `/usage` route to AI, `/products/ps5-slim` to the read-only demo store, other API paths to Rust.

All `.env` files and `private-handoff/` stay out of Git and image build contexts. Use one money replica: its payment state is currently in memory. Do not restart it during an active test. These payment services enforce Stripe test and Zinc sandbox keys; no goods ship.

The reported VM SSH rejection is a separate access blocker. Publishing this branch does not repair SSH or install secrets. The VM owner must restore authorized access before running deployment commands.

## Cloud acceptance test

1. Check `https://34-175-42-226.sslip.io/health` and `/usage`. Use an actual `/understand` request with `{url, html}`; an OPTIONS response is insufficient.
2. In AutoBuy settings, set backend to `https://34-175-42-226.sslip.io` and clear the separate AI URL. Open `https://34-175-42-226.sslip.io/products/ps5-slim`.
3. Reset stock using the command below with `in_stock:false`. Re-read the page in the extension; confirm real AI mode/model, out-of-stock, price €248, edition digital and storage 1tb.
4. Authorize a €250 ceiling for one day. Confirm Rust's `payment_authorized` contains a Stripe `pi_...` reference, not `demo-...`. Confirm a real `offer_observed` with `available:false` and an `out_of_stock` rejection before restocking.
5. Restock from the VM; no public admin endpoint is exposed:

```sh
docker compose --env-file deploy/.env -f deploy/compose.yaml exec -T demo-store node -e 'require("node:fs").writeFileSync("/data/restock.json", JSON.stringify({in_stock:true}))'
```

6. Rust must fetch the URL again, observe matching variants and in-stock status, and produce exactly one `purchase_confirmed`. Dashboard must show purchased; separately verify the Stripe test capture (€248), released excess (€2), and Zinc `order_placed`. A demo authorization or dashboard label alone is not proof.

Logs: Rust events `/v1/monitors/{id}/events`, AI `/app/data/audit.jsonl`, demo-store `/data/requests.jsonl`, container logs via `docker compose ... logs core backend money demo-store`. Audit data and Rust DB use persistent volumes; container logs rotate.

## Evidence and local reproduction

`tests/restock/local-chrome-result.json` is a credential-free summary of the successful 2026-09-12 local Chrome test. Cloud was separately checked: it received a monitor but returned demo authorization, missed variants, and lacked `/understand`; its diagnostic monitor was cancelled. Cloud end-to-end acceptance remains pending deployment.

Local test harness: run `node tests/restock/store.mjs` and publish its read-only port 4011 through a public HTTPS tunnel so Rust's public-URL guard can fetch it. Start Rust with `MERCHANT=p4` and local money URL; start AI with `INTELLIGENCE_ONLY=true`. Add the tunnel hostname to money's `SANDBOX_RETAILERS`. Install `money/` dependencies and run:

```sh
PRODUCT_URL=https://YOUR-TUNNEL/products/ps5-slim RUST_URL=http://localhost:8080 MONEY_URL=http://localhost:4243 AI_URL=http://localhost:3002 node --env-file=money/.env tests/restock/verify.mjs
```

The harness calls real AI, authorizes test funds, changes the **local** fixture file, and verifies capture plus sandbox purchase. It generates its own ignored evidence in `private-handoff/`; it does not require private files from another developer. Use the VM command above for the cloud restock; the local harness cannot change the VM's fixture volume.

## Branch validation

Before publishing: `cargo test --workspace --locked`, backend TypeScript typecheck, extension/test JavaScript syntax checks, Compose configuration validation, AI and demo-store Docker builds passed. Container checks confirmed OpenRouter selection, `/usage` HTTP 200, `/understand` input validation, and the demo-store out-of-stock → in-stock transition. The AI image contains no backend `.env` or local probe. These checks do not substitute for the pending cloud purchase acceptance test.

## Luna configuration

Set `OPENROUTER_MODEL=openai/gpt-5.6-luna` with the new separately shared OpenRouter key. Keep `OPENROUTER_MODEL_FALLBACK` empty. This branch forwards both model settings into the AI container. Local extraction with Luna passed on 2026-09-12 in 3.8 seconds, with the correct PS5 product, €248 price, stock and variants. `/usage` must report Luna after redeploy; the old free-model label means the change is not active yet.
