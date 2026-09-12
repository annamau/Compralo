# Deploying Compralo

Four services and an edge proxy, on one small VM in Madrid, from one command.

```
                         ┌─────────────────── caddy ───────────────────┐
   browser / extension ──►  :80  :443   automatic HTTPS when DOMAIN set │
                         └──┬────────┬─────────┬──────────────┬────────┘
                            │ /      │ /money/ │ /market/     │ /core/
                       backend:3000  money:4242 market:4000  core:8080
                       AutoBuy Hono   P4 Stripe  simulator    P1 Rust/Axum
                       3 s poll loop  + Zinc     zero deps    sqlx + SQLite
                       vol /app/data  in-memory  stateless    vol /data
```

Caddy strips the prefix, so `/money/checkout` arrives at money as `/checkout`.
`core` listens on **8080**, not 3000 — that is what the repo-root `Dockerfile` sets as
`BIND_ADDR` and what its own `HEALTHCHECK` curls.

Nothing but Caddy publishes a port. The four services talk to each other by service
name on the private compose network, which is why none of them needs its own TLS.

| compose service | source in this repo | image base |
|---|---|---|
| `backend` | `autobuy/packages/backend` (Hono + tsx) | `node:22-alpine` |
| `money` | `$MONEY_DIR`, default `money/` | `node:22-alpine` |
| `market` | `autobuy/packages/market` | `node:22-alpine` |
| `core` | repo root `Cargo.toml` + `backend/crates/*`, built by the **repo-root `Dockerfile`** | `debian:bookworm-slim` |
| `caddy` | `deploy/Caddyfile` | `caddy:2-alpine` |

---

## 0. Two things to know before you deploy

**`money/` is the real P4 service** — Stripe mandate hold + capture, the Zinc sandbox
order path, the market-simulator path, `GET /coverage`, and a 19-scenario suite that is
green on this branch (`cd money && npm ci && npm test`). `MONEY_DIR` defaults to `money`
and that default is correct; `p4/` is a leftover working copy and is not tracked.

**The AutoBuy backend is being switched from direct Stripe calls to P4** (`P4_URL`, already
in this compose file). Until that commit lands on `join/rust-main`, `backend` still runs its
own Stripe/stub lane; after it, the backend needs no `STRIPE_SECRET_KEY` at all — only
`money` does.

---

## 1. The exact sequence

Once, on your machine:

```bash
# Install the Google Cloud CLI
brew install --cask google-cloud-sdk          # macOS
# or: https://cloud.google.com/sdk/docs/install

gcloud auth login
gcloud config set project YOUR_PROJECT_ID
```

**Billing must be enabled on that project** before anything below works — Compute Engine
refuses to create an instance otherwise. Check at
`https://console.cloud.google.com/billing/linkedaccount?project=YOUR_PROJECT_ID`.
A new account's $300 free trial covers this deployment many times over.

Then, from the repository root:

```bash
cp deploy/.env.example deploy/.env     # fill in the keys — see § 2
./deploy/gcp.sh config                 # read-only: shows what it would do

./deploy/gcp.sh create && ./deploy/gcp.sh push
```

`create` prints the static IP it reserved. To get real HTTPS with no domain to buy,
put that IP into `deploy/.env` with dashes for dots and push again:

```bash
echo 'DOMAIN=34-175-42-226.sslip.io' >> deploy/.env   # sslip.io resolves it to the IP
./deploy/gcp.sh push
```

Afterwards:

| Command | Does |
|---|---|
| `./deploy/gcp.sh push` | re-sync and rebuild — this is the redeploy loop |
| `./deploy/gcp.sh status` | VM state, `compose ps`, a health probe of all four, the URLs |
| `./deploy/gcp.sh logs` / `logs backend` | follow everything, or one service |
| `./deploy/gcp.sh ssh` | a shell on the box |
| `./deploy/gcp.sh destroy` | delete the VM, the firewall rule **and the reserved IP** |
| `./deploy/gcp.sh local` | the same compose file on your laptop, on `http://localhost` |

Every command the script runs is echoed before it runs. `create` describes each resource
first and only creates what is missing, so running it twice is safe.

**The first `push` is slow.** The Rust release build is cold and an e2-small has two
vCPUs: 5–15 minutes. The startup script adds 6 GB of swap for exactly this reason —
without it `cargo build --release` is killed by the OOM reaper. Later pushes reuse the
layer cache and take seconds. If the build still dies, set `GCP_MACHINE_TYPE=e2-medium`
in `deploy/.env` **before** `create`.

---

## 2. Every credential the system needs

Fill these into `deploy/.env` (gitignored). `deploy/.env.example` is the template and
carries names with empty values only.

| Variable | Service | Where to get it | Required for the demo? |
|---|---|---|---|
| `STRIPE_SECRET_KEY` | **money**, backend | [dashboard.stripe.com/test/apikeys](https://dashboard.stripe.com/test/apikeys) — the **test mode** secret key | **Yes.** Must start with `sk_test_`; `money.mjs` exits on anything else. Without it the backend silently falls back to its Stripe stub and the "Stripe enforced the ceiling" beat is a lie. |
| `ZINC_API_KEY` | **money** | Mint a sandbox key with no account and no personal data: `curl -s -X POST https://api.zinc.com/sandbox/keys \| python3 -m json.tool`. Docs: [Agent sandbox](https://www.zinc.com/docs/v2/agent-sandbox/overview.md). To go live later, claim the key at the `claim_url` the mint call returns and add a payment method at [zinc.com](https://www.zinc.com/docs) | **Yes**, once P4's Zinc lane is back (see § 0) — `zinc.mjs` exits on anything that is not `zn_test_`. `compose.yaml` requires it either way, so a missing key fails loudly at `up` instead of crash-looping later. Sandbox keys **expire after 7 idle days** — mint a fresh one the morning of the demo. |
| `SPIDER_CLOUD_API_KEY` | **core** | [spider.cloud](https://spider.cloud) → API keys | **Yes**, to boot core. It is only the fallback crawler for when a direct fetch is blocked, but core's compose entry requires it and the service will not start without it. |
| `ANTHROPIC_API_KEY` | backend | [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys) | **No, but.** Absent, the backend prints `AI: hardcoded` and every page reads as a PS5 Slim Digital. Present, Claude reads the real page. The demo runs either way; only one of them is impressive. |
| `EXA_API_KEY` | backend | [dashboard.exa.ai/api-keys](https://dashboard.exa.ai/api-keys) | **No.** Absent, the Exa perception lane reports mode `off` and finds no real-web offers; the market simulator still drives the whole demo. Costs ~$0.001 a page, which is why `EXA_POLL_INTERVAL_MS` defaults to 60 s against the simulator's 3 s. |
| GCP **project id** | `gcp.sh` | `gcloud projects list`, or create one at [console.cloud.google.com](https://console.cloud.google.com/projectcreate) | **Yes.** `gcloud config set project …`, or `GCP_PROJECT` in `deploy/.env`. |
| GCP **billing** | — | [Billing → link a billing account](https://console.cloud.google.com/billing/linkedaccount) | **Yes.** Compute Engine will not create an instance on an unbilled project. The $300 free trial is enough. |
| GCP **region / zone** | `gcp.sh` | defaults `europe-southwest1` / `europe-southwest1-a` (Madrid) | No — the defaults are the answer. Override with `GCP_REGION` / `GCP_ZONE`. |
| `DOMAIN` | caddy | optional | **No.** Empty → plain HTTP on the VM's IP. Set → Caddy provisions a certificate over ACME. With no domain, `<dashed-ip>.sslip.io` gives you a real certificate for free. |

Two things that are **not** credentials but bite like them:

- Stripe test cards are the demo's script: `pm_card_visa` authorises,
  `pm_card_authenticationRequired` forces the 3DS beat. Nothing to configure.
- Zinc's sandbox knows only its rehearsal slugs (`test-success`, `test-out-of-stock`,
  `test-price-exceeded`). `zinc.mjs` substitutes them for the real listing URL and keeps
  the real one on the record.

---

## 3. What to change in the Chrome extension

There are **two** extension trees in this repo right now, and which one is on stage
decides which of these you edit. Both point at localhost today.

### `extension/` — P2's MV3 rebuild (Vite + React)

It reads its base URL from Vite env, declared in the repo-root `.env.example`:

```
VITE_MOCK=true
VITE_API_URL=http://127.0.0.1:3000
```

For the deployed system, in the root `.env`:

```
VITE_MOCK=false
VITE_API_URL=https://34-175-42-226.sslip.io
```

Vite inlines that at build time, so rebuild (`cd extension && npm run build`) and reload
the unpacked extension. Whatever `manifest.json` that build emits must also list the
deployed host in `host_permissions` — see the rule below.

### `autobuy/packages/extension` — the working MV3 panel

**`panel.js`, line 3:**

```js
const API = "http://localhost:3000";
```

becomes the deployed base — no trailing slash, and note that **the backend sits at `/`**,
so there is no path to append:

```js
const API = "https://34-175-42-226.sslip.io";   // or http://<VM_IP> with no DOMAIN set
```

**`manifest.json`, `host_permissions`:**

```json
"host_permissions": ["http://localhost:3000/*", "http://*/*", "https://*/*"]
```

The wildcards already cover any deployed host, so this *works* untouched — but a
reviewer will ask why an extension needs every site on the internet. Narrow it to the
two things it actually calls, the product page it reads and your backend:

```json
"host_permissions": [
  "https://34-175-42-226.sslip.io/*",
  "https://*/*"
]
```

Then reload at `chrome://extensions`. Two gotchas that apply to both trees:

- **Plain HTTP breaks the panel on HTTPS product pages.** A side panel loaded over
  `https://` cannot `fetch()` an `http://` origin — Chrome blocks it as mixed content.
  If the demo runs on real retailer pages, `DOMAIN` is not optional, and `sslip.io` is
  the cheapest way to satisfy it.
- CORS needs nothing: every service already sends `access-control-allow-origin: *`.

The money service is at `/money`, the simulator at `/market` and P1's core at `/core` on
that same base, should the panel need them directly.

---

## 4. Why not Cloud Run

Cloud Run is the reflex for "four containers on GCP", and it is the wrong tool for three
of these four. Each reason below is a property of the code as written, not a preference:

- **The backend's clock lives inside the process.** `startMonitor()` runs a 3 s
  `setInterval` and `startExaMonitor()` a 60 s one. Cloud Run only guarantees CPU
  *during a request*; between requests a container is throttled to near zero, so those
  timers fire late, in bursts, or not at all. Fixing it means CPU-always-allocated plus
  `--min-instances=1`, at which point you are paying for a VM with extra steps.
- **State is a file, and SQLite is a file.** The backend rewrites `data/state.json` on
  every change; core opens `buy-agent.sqlite` through sqlx. Cloud Run's filesystem is an
  in-memory tmpfs that dies with the instance. The escape hatches are a GCS FUSE mount
  (SQLite over FUSE corrupts under concurrent writers — a documented footgun) or Cloud
  SQL, which is a rewrite of core's persistence layer and a bigger bill than the VM.
- **money's holds are in-memory Maps.** `holds`, `holdsByInstruction` and `purchases`
  live in the process. Cloud Run autoscales on concurrency, and the moment a second
  instance exists, `/checkout` can land on a box that has never heard of the hold
  `/funds/commit` created. You would have to pin it to exactly one instance — again, a
  VM with extra steps.
- **The cost argument inverts.** Cloud Run's appeal is scale-to-zero. Four services that
  each need `--min-instances=1 --cpu-boost --no-cpu-throttling` never scale to zero, and
  four always-on Cloud Run instances cost *more* than one e2-small — plus a Cloud SQL
  instance, plus egress, plus the engineering to get there.

Cloud Run would suit **market** perfectly. Splitting one service out to save nothing is
not a trade worth making the day before a demo.

The honest summary: this is a stateful, always-on system with a polling loop and two
local databases. That shape is a VM. Revisit Cloud Run when state moves to Postgres and
the loops move to Cloud Scheduler — i.e. not this week.

---

## 5. What it costs

One `e2-small` (2 vCPU burst, 2 GB) in `europe-southwest1`, on-demand, running 24/7:

| Line | ≈ USD / month |
|---|---|
| e2-small instance | ~$16 |
| 30 GB pd-balanced boot disk | ~$3.60 |
| Static external IP (while attached) | ~$3 |
| Egress (a demo's worth) | <$1 |
| **Total** | **≈ $23 / month, ≈ $0.03 / hour** |

Roughly **$0.80 for a day of hackathon**. A new GCP account's $300 free trial swallows it
whole.

Two things to know:

- A reserved IP **that is not attached to a running instance still bills**, at a higher
  rate than an attached one. `./deploy/gcp.sh destroy` deletes the address for that
  reason; stopping the VM without releasing the IP is the way to get a surprise.
- `e2-micro` (~$7/mo) would hold the four services at rest but will not survive the Rust
  release build. If you want micro, build the image elsewhere and push it to Artifact
  Registry — which is what `deploy/gcp-startup.sh`, P1's original single-container
  deploy, already does.

---

## 6. Files

| File | What it is |
|---|---|
| `deploy/compose.yaml` | the five services, the volumes, the routing contract |
| `deploy/Caddyfile` | the edge: prefix stripping, SSE flushing, ACME |
| `deploy/Dockerfile.money` | node:22-alpine, non-root, `npm ci --omit=dev` from the lockfile in `$MONEY_DIR` (default `money/`) |
| `deploy/Dockerfile.backend` | node:22-alpine, non-root, tsx at runtime, `/app/data` volume |
| `deploy/Dockerfile.market` | node:22-alpine, non-root, one file and no dependencies |
| `deploy/Dockerfile.*.dockerignore` | per-build context filters — BuildKit reads `<dockerfile>.dockerignore` in preference to the context root's, so these never disturb the repo-root `.dockerignore` that P1's Rust build relies on |
| `deploy/gcp.sh` | create / push / status / logs / ssh / destroy / config / local |
| `deploy/vm-startup.sh` | GCE startup script: swap, docker engine, compose plugin, rsync |
| `deploy/rsync-exclude.txt` | what never travels to the VM (`deploy/.env` deliberately does) |
| `deploy/.env.example` | every variable, names only |
| `deploy/gcp-startup.sh` | **P1's**, not mine: the earlier single-container Artifact Registry deploy. Left untouched; `vm-startup.sh` is its descendant. |

**core is not rebuilt here.** `compose.yaml` points at the repository-root `Dockerfile`
that P1 maintains, with `context: ..`, so the two can never drift. Its `docker-entrypoint.sh`
can also pull `SPIDER_CLOUD_API_KEY` from Secret Manager when
`SPIDER_CLOUD_API_KEY_SECRET_RESOURCE` is set; this deployment passes the key through
`deploy/.env` instead, so the VM needs no extra IAM scope.

## 7. Local

Same file, same routes, no cloud:

```bash
cp deploy/.env.example deploy/.env    # fill in the three required keys
./deploy/gcp.sh local                 # → http://localhost/dashboard
./deploy/gcp.sh local-down
```

Caddy binds :80 and :443 on your machine, so stop anything already there first.
