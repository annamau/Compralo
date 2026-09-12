# P1 — Core

Backend, queue, checker worker, notifications. **Owns [CONTRACTS.md](../CONTRACTS.md).**

You are the critical path. Three lanes converge on you around T+3:00, so your first hour is spent unblocking other people, not writing your best code.

---

## Owns

- The HTTP API surface — every endpoint in `CONTRACTS.md § P1`
- Database schema and migrations
- The per-user check queue and the checker worker that walks it
- Offer normalization — retailer-specific mess stops at your door
- **The deterministic gate** — mandate vs resolved facts
- Execution lock, idempotency, the instruction state machine
- Backend deployment, shared env template, logging
- Emitting a notification event on every state change

## Does NOT own

- **Any model call.** You never prompt anything. Ask P3.
- **Any payment call.** You never touch a card or a balance. Ask P4.
- **Any UI.** You return JSON; P2 decides how it looks — including how notifications are shown.
- **Whether two products are the same.** That is P3's judgment, and you consume it as a fact.

> **Boundary rule: P1 never calls a model. P3 never touches the mandate.**

---

## Consumes

| From | What | Contract |
|------|------|----------|
| P2 | Auth token on every request | `§ Auth` |
| P2 | Mandate payload on arm | `POST /instructions` |
| P3 | canonical + constraint_schema | `POST /understand` |
| P3 | candidate listings | `POST /discover` |
| P3 | verdict + resolved facts per offer | `POST /adjudicate` |
| P4 | hold status before allowing execution | `POST /funds/commit` |

## Produces

| For | What | Due |
|-----|------|-----|
| Everyone | Frozen contract + mock JSON | **T+0:15** |
| P2 | Auth shape agreed in writing | **T+0:30** |
| P3, P4 | DB schema live | T+0:45 |
| P2 | `GET /instructions` watch list | T+1:00 |
| P3 | Normalized offers to adjudicate | T+2:00 |
| P4 | Qualified offer + idempotency key | T+2:00 |

---

## Tasks

- [ ] T+0:15 — Contract frozen, mocks in `mocks/`. Static JSON is fine and correct here.
- [ ] T+0:20 — `.env.example` committed with every key the team needs named. No values.
- [ ] T+0:30 — Auth shape settled with P2, written into `CONTRACTS.md`.
- [ ] T+0:45 — Schema live. P3 and P4 can write.
- [ ] T+0:45 — **CORS + the extension's origin allowed.** This is a classic two-hour bug; spend ten minutes on it now.
- [ ] T+1:00 — `POST /instructions`, `GET /instructions`, `GET /instructions/:id`, cancel.
- [ ] T+1:30 — Checker worker walking the queue on a schedule.
- [ ] T+2:00 — `POST /offers` ingest and normalization.
- [ ] T+2:30 — The gate. ~40 lines, no model, source you would show a judge.
- [ ] T+2:45 — Structured logging on every state transition. When it breaks at T+3:30 this is the difference between five minutes and forty-five.
- [ ] T+3:00 — Execution lock + idempotency. Fire the same offer twice on purpose.
- [ ] T+3:15 — **Re-read the offer total immediately before checkout.** Moved beyond `PRICE_TOLERANCE_CENTS`? Release the lock and re-evaluate. Hand P4 the fresh figure, never a cached one.
- [ ] T+3:30 — **Substitution escalation:** no exact match but a credible alternative exists → `AWAITING_APPROVAL` + notification. `POST /instructions/:id/substitute` applies the answer. This state holds no lock and spends nothing.
- [ ] T+3:30 — Terminal states release funds, revoke authority, cancel checks.

---

## Deployment

**Decide by T+0:30.** The extension must reach the backend from whatever network the demo runs on. If the answer is `localhost`, the demo works only on the machine that built it — that is a real risk, not a theoretical one. Pick a deployed URL early and point every client at it from the start.

---

## Done when

An instruction can be armed by one call, watched by the worker with no browser open, judged against its mandate, and executed exactly once — with every rejection on the record and every state change in the log.
