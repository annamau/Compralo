# P3 — Intelligence

Everything derived from the screenshot: understanding, metadata, and Exa discovery of the same product elsewhere.

**Your lane is the reason this is not a price tracker.** Remove it and the product loses page-agnostic perception, semantic product identity, and true-cost resolution. That is the answer when a judge asks why the AI is not an add-on.

---

## Owns

- `POST /understand` — screenshot → canonical product, listing economics, `constraint_schema`
- `POST /discover` — Exa semantic search → the same product at other retailers
- `POST /adjudicate` — the verdict on a single offer
- Prompt design and structured-output validation
- Identifier extraction (EAN / GTIN / MPN / model)
- Canonical product cache
- Screenshot preprocessing and cost control
- Demo fixtures in `fixtures/offers.json`

## Does NOT own

- **The mandate.** You never read `max_total_cents` to make a decision.
- **The gate.** Qualifying an offer against a mandate is P1's deterministic code.
- **Any spend.** You never call a payment API.
- **The UI.** You emit a schema; P2 renders it.

> **Boundary rule: you return facts and confidence, never "buy".** If the word *should* appears in any response field of yours, it is in the wrong lane.

---

## Consumes

| From | What | Contract |
|------|------|----------|
| P2 | url, screenshot_b64, dom_hints | agreed T+0:45 |
| P1 | normalized offers to adjudicate | `POST /offers` |

## Produces

| For | What | Due |
|-----|------|-----|
| P2 | Mock `/understand` response | **T+0:20** |
| P2 | `constraint_schema` that drives the whole UI | T+1:15 |
| P1 | canonical + identifiers | T+1:15 |
| P1 | candidate listings + match confidence | T+2:00 |
| P1 | verdict + resolved facts | T+2:30 |

---

## Tasks

- [ ] T+0:20 — Mock responses for all three endpoints. P2 is blocked until these exist.
- [ ] T+0:45 — Capture payload and screenshot size agreed with P2.
- [ ] T+1:15 — `/understand` returning valid structured output from a real screenshot. **Validate the schema before returning it** — a malformed `constraint_schema` takes P2 down with it.
- [ ] T+1:45 — Identifier extraction. **Prefer identifiers over inference**: when an EAN matches, confidence is 1.0 and the model is not consulted.
- [ ] T+2:00 — `/discover` via Exa → candidates with a match confidence and a one-phrase `why`.
- [ ] T+2:30 — `/adjudicate`: same product or not, true all-in total, hidden costs, condition, seller.
- [ ] T+2:45 — `fixtures/offers.json` with the four demo offers, so anyone can replay the sequence without a real restock.
- [ ] T+3:00 — Tune the rejection sentences against real offers. Read them aloud; if one sounds like a form error, rewrite it.
- [ ] T+3:30 — Cache canonical products so repeat offers do not re-call the model. "One expensive call supports many cheap checks" is a claim in the pitch — make it true.

---

## The rejection sentences are the pitch

Judges will spend more time reading these three lines than watching anything else built today.

| Offer | Verdict | Reason |
|-------|---------|--------|
| €219 | REJECTED | Previous generation under a near-identical title |
| €244 | REJECTED | Mandatory add-on at checkout — true total €282 |
| €248 | QUALIFIES | Correct variant, approved seller, delivered within limit |

They must read like a sharp friend catching a near-miss, not a validation error.

---

## Done when

The rejection reasons are ones no price tracker could have written, and Exa surfaces at least one retailer the user never visited.
