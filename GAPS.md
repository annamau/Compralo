# Gaps — what is not being built

Everything the [brief](readme.md) describes, checked against what the four lanes actually cover. Three categories: plumbing nobody owned, product surface nobody is building, and things deliberately left out so nobody builds them by accident.

---

## A. Plumbing nobody owned

These do not appear in anyone's idea of their job, and each one can end the demo. All four are now assigned in [scopes/](scopes/) — listed here so the team lead can see them in one place.

| # | Gap | Why it bites | Owner |
|---|-----|--------------|-------|
| A1 | **Where the backend runs** | If the extension calls `localhost`, the demo works on exactly one machine. Decide by T+0:30 and point every client at a deployed URL from the start. | P1 |
| A2 | **CORS + `host_permissions`** | MV3 extension → backend is a classic two-hour bug discovered at hour three. Ten minutes now. | P1 + P2 |
| A3 | **Shared secrets** | Four people need model, Exa and payment keys. One `.env.example` with every key named, no values. | P1 |
| A4 | **Logging on state transitions** | At T+3:30 something breaks. Structured logs are the difference between five minutes and forty-five. | P1 |
| A5 | **Screenshot size** | Full-resolution captures are slow to upload and expensive to process — the most likely reason a four-second panel feels like ten. | P2 + P3 |
| A6 | **Demo fixtures** | Nobody can rehearse if the sequence needs a real restock to fire. | P3 |

---

## B. Product surface nobody is building

Present in the brief, absent from all four lanes. Ranked by what they would add to the demo.

### B1 — Substitution approval · *the one I would build*

The brief calls for it (§7, *Alternative discovery*) and nobody has it:

> "The exact product is gone. The newer model is €12 more from an approved seller. Want me to widen the mandate?"

**Why it matters more than it looks:** every other beat shows the agent executing rules it was given. This is the only beat where it comes *back* to the user, unprompted, with a question it could not have anticipated at setup time — and then acts on the answer. That is the difference between a delegate and a trigger, and it is the single clearest answer to "is this actually an agent or just automation?"

**Cost:** one extra state (`AWAITING_APPROVAL`), one notification, one approve/decline endpoint, one card in the watch list. Perhaps 40 minutes across P1 and P2.

### B2 — Price moved during checkout

The brief flags it as an open question (§36) and it is unresolved. The gate revalidates that an offer is *live*, but not that the price is still what qualified it. A retailer changing the price between qualify and buy is the most realistic way to overspend inside a correct system.

**Fix:** re-read the total immediately before charging, and abort if it moved by more than a tolerance you choose. Ten minutes, and it closes the most credible hole a technical judge can poke.

### B3 — Spend safety beyond the per-order cap

The brief lists five limits (§24). You have one — max per order. Missing: maximum total active exposure across all instructions, maximum purchases per day, and a global kill switch.

**Why it is worth 20 minutes:** "what stops this from draining my account" is the first question a sceptical judge asks, and right now the answer is "each order has a cap", which does not cover ten orders. A single `max_total_exposure_cents` on the user, checked at arm time, answers it completely.

### B4 — Quantity cap for fairness

The brief's anti-scalper positioning (§18) promises quantity limits. Trivial to enforce — one check at arm time — and it lets you answer the "aren't you just building a scalper bot" question with code rather than intent.

### B5 — First run

Nobody owns what happens the first time someone installs the extension. If the demo starts with a logged-in account and seeded state, say so; if it starts cold, someone has to build the empty state.

### B6 — The silent period

Twenty-nine days of this product is nothing happening. The watch list currently shows a card that says `ARMED` and no more. A "last checked 4 minutes ago · 23 offers seen · 23 rejected" line costs almost nothing and turns silence into visible work.

### B7 — Natural-language mandates

In the brief (§7, §20.3): *"Buy this below €450, new only, no bundles."* Genuinely nice, and genuinely skippable — the generated controls already demonstrate the model understands the category. Build only if a lane finishes early.

---

## C. Deliberately out of scope

So nobody builds these by accident:

Universal retailer support · production payments · price prediction · mobile app · merchant dashboard · scalper detection · multi-item bundles · a second product category with full execution · revenue and fees · social features · reseller marketplace.

One product. One category. One end-to-end purchase. Everything else is a slide.

---

## If time appears

In order: **B1** (substitution approval — buys the most demo value per minute), then **B2** (price moved — closes the most credible technical hole), then **B3** (exposure cap — answers the trust question).

Everything below those is polish. Nothing below those beats rehearsing.
