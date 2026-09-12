# Compralo — Build Board

> **Limit orders for everyday products.** The user points at a product, names a price and conditions, and leaves. The agent watches, judges, and buys once — inside a mandate it cannot exceed.
>
> **AI decides what counts as the product. Deterministic code decides what counts as the money.**

Contracts everyone codes against: **[CONTRACTS.md](CONTRACTS.md)** — read it before writing a line.
Per-person scope and boundaries: **[scopes/](scopes/)** — what you own, and what you must not build.

---

## The spine

Six beats. If a beat is at risk, everything else stops. Anything not serving one of these is out of scope.

| # | Beat | Owner |
|---|------|-------|
| 1 | AI reads the rendered product page | P3 |
| 2 | Controls appear that nobody hardcoded | P2 + P3 |
| 3 | User arms it — the ceiling is authorized, held by Stripe | P4 |
| 4 | **Browser closes. The agent keeps working.** | P1 — state is server-side, the extension is a thin client |
| 5 | Offers arrive, the agent rejects the wrong ones with reasons | P1 + P3 |
| 6 | One qualifies. It buys exactly once. | P1 + P4 |

---

## Team

| | Person | Owns | Surface |
|---|--------|------|---------|
| **P1** | Core | Backend, queue, checker worker, notification events, **the contracts** | Rust API + workers |
| **P2** | Extension | Capture, product view, user's watch list, login | Chrome MV3 |
| **P3** | Intelligence | Screenshot → understanding → metadata → Exa discovery | Model calls + search |
| **P4** | Money | Pre-charge, balance, low-friction authorization, checkout | Payments |

**P1 defines the endpoints. Every other lane adapts to them.** P1's first deliverable is not code — it is the frozen contract plus mock responses, so three people can build in parallel against something real.

---

## P1 — Core

Backend, the per-user check queue, the checker worker, notifications. Owns `CONTRACTS.md`.

- [ ] **T+0:15 — Publish the contract and mock responses.** Static JSON is fine. Unblocking three people is the first job; real endpoints come after.
- [ ] **T+0:30 — Auth shape agreed with P2.** Token format, where it rides, how a queue item is attributed to a user. This is the single most common integration failure — settle it in writing.
- [ ] T+0:45 — DB schema live (see CONTRACTS.md § Schema). Owned here; P3 and P4 write into it.
- [ ] T+1:00 — `POST /instructions` creates an instruction and puts it in the queue, status `ARMED`.
- [ ] T+1:00 — `GET /instructions` and `GET /instructions/:id` so P2 can render the watch list.
- [ ] T+1:30 — Checker worker: walks the queue, fetches each candidate listing, writes normalized offers.
- [ ] T+2:00 — `POST /offers` ingest, normalized. Retailer-specific mess stops here; everything downstream sees one shape.
- [ ] **T+2:30 — The deterministic gate.** Mandate vs resolved facts → qualify or reject. ~40 lines, no model, and you should be happy to show a judge the source.
- [ ] T+3:00 — Execution lock + idempotency. Fire the same qualifying offer twice on purpose and prove one purchase.
- [ ] T+3:15 — Emit a notification event on every state change. P2 renders it.
- [ ] T+3:30 — Terminal states clean up: cancel monitors, release funds, revoke spend authority.

**Done when:** an instruction can be armed by one call, watched by the worker with no browser open, judged against its mandate, and executed exactly once — with every rejection on the record.

---

## P2 — Extension

The view, the capture, the user's watch list, login.

- [ ] T+0:30 — MV3 shell: icon opens the side panel on any page, nothing else.
- [ ] **T+0:30 — Auth shape agreed with P1.** Blocking for both of you.
- [ ] T+1:00 — Login flow, token stored, attached to every call.
- [ ] T+1:00 — `captureVisibleTab()` + JSON-LD/OpenGraph read → **skeleton on screen in 200ms**, before any network call returns. A spinner on an empty panel is where this demo dies emotionally.
- [ ] T+1:45 — Render P3's `constraint_schema` as live controls. Generic renderer: enum → segmented control, bool → toggle, money → input. **Never special-case a category** — the whole point is that nobody wrote the form.
- [ ] T+2:15 — Cross-retailer results from P3's Exa discovery, with a per-retailer approve toggle.
- [ ] T+2:30 — Mandate form → arm → confirmation showing exactly what was committed and what its ceiling is.
- [ ] T+3:00 — Watch list: the user's active instructions and their states, polled or realtime.
- [ ] T+3:15 — Low-confidence and error states. Below ~0.7 confidence, ask rather than assume — an agent that asks reads smarter than one that guesses.
- [ ] T+3:45 — The skeleton → AI-result upgrade animation. This is Beat 2 and it is worth 20 minutes.

**Done when:** on a retailer page nobody tested, clicking the icon produces correct category-appropriate controls in under four seconds, with something readable on screen the whole time.

---

## P3 — Intelligence

Everything derived from the screenshot: understanding, metadata, and Exa discovery of the same product elsewhere.

- [ ] T+0:20 — Mock `/understand` and `/discover` responses to P1's contract, so P2 is never blocked.
- [ ] T+1:15 — `POST /understand`: screenshot → canonical product, listing economics, `constraint_schema`. Force structured output; a malformed schema takes P2 down with it.
- [ ] T+1:45 — Identifier extraction (EAN / GTIN / MPN / model). **Prefer identifiers over inference** — the model should only resolve what the identifiers can't.
- [ ] T+2:00 — `POST /discover`: Exa semantic search → same product at other retailers → candidate list with a match confidence per result.
- [ ] T+2:30 — **`POST /adjudicate`: the verdict on a single offer.** Same product or not, true all-in total, hidden costs, condition, seller. Facts only — never "should we buy".
- [ ] T+3:00 — Tune the rejection sentences against the real offers. Read them aloud; if one sounds like a form error, rewrite it.
- [ ] T+3:30 — Cache canonical products so repeat offers don't re-call the model. One expensive call supporting many cheap checks is a claim in the pitch — make it true.

**Done when:** the rejection reasons are ones no price tracker could have written, and Exa surfaces at least one retailer the user never visited.

**Why this lane is the product:** remove the model and you lose page-agnostic perception (you'd need an adapter per retailer), semantic product identity (you could only watch one URL — a stock alert), and true-cost resolution (your limit fires on a fake number). That's the answer when a judge asks why the AI isn't an add-on.

---

## P4 — Money

Pre-charge, balance, and the lowest-friction authorization you can build. **Also owns checkout** — see Gaps.

- [x] **T+0:15 — Kill-switch: done.** Issuing ❌, Connect ❌, manual capture ✅. Decision and build plan in [PAYMENTS.md](PAYMENTS.md): **mandate hold** — authorize the ceiling at arm time, capture the true price at buy time.
- [ ] T+1:00 — `POST /funds/commit`: authorize `max_total_cents`. **One tap.** Every extra field is a user lost.
- [ ] T+1:30 — `POST /checkout`: capture `true_total_cents` with a stable idempotency key. Partial capture auto-releases the difference.
- [ ] T+2:00 — `POST /funds/release`: cancel, wired with P1 to every terminal state.
- [ ] T+2:30 — **Never validate the amount before calling Stripe.** Send the over-mandate capture and let `amount_too_large` come back. That refusal is the beat.
- [ ] T+3:00 — Release funds on every terminal state: expired, cancelled, failed. No lingering hold, ever.
- [ ] T+3:15 — `NEEDS_ATTENTION` path when authentication is required. Even stubbed, showing you planned for it beats pretending it can't happen.

**Done when:** a judge can see the committed amount, see the ceiling enforced by the payment layer, watch an over-budget attempt get refused, and see funds released when nothing qualifies.

---

## Integration seams

Where the parts join. Each is frozen at the stated time; after that a change costs someone else their next hour.

| Seam | Between | What crosses | Frozen |
|------|---------|--------------|--------|
| Auth | P2 → P1 | Token format, user attribution | **T+0:30** |
| Page capture | P2 → P3 | url, screenshot, dom hints | T+0:45 |
| Product understanding | P3 → P1 | canonical + constraint_schema | T+1:00 |
| Watch list | P1 → P2 | instruction states | T+1:00 |
| Mandate → funds | P1 → P4 | user, amount, deadline | T+1:00 |
| Discovery | P3 → P1 | candidate listings + confidence | T+1:30 |
| Offer → verdict | P1 ↔ P3 | offer in, verdict + reason out | T+1:30 |
| Qualified → buy | P1 → P4 | offer + idempotency key | **T+2:00** |

---

## Clock

| Time | Everyone stops for four minutes |
|------|----------------------------------|
| **T+0:30** | Kill-switch report. Payment capability: yes/no. Auth shape: agreed. Replan now if either is bad. |
| **T+1:00** | First contracts frozen. Mocks out where real exists. |
| **T+2:00** | All contracts frozen. A change after this needs all four to agree. |
| **T+3:30** | First full end-to-end attempt. Whatever breaks becomes the team's only task. |
| **T+4:00** | **Feature freeze. Absolute.** Every team ignores this and every team regrets it. |
| **T+4:30** | Backup recording done. Then rehearse until the clock runs out. |

---

## Scope discipline

Not today: universal retailer support, production payments, price prediction, mobile, merchant dashboard, scalper detection, multi-item bundles, second product category with full execution.

One product. One category. One end-to-end purchase. Everything else is a slide.
