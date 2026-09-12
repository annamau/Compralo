# P2 — Extension

The view, the capture, the user's watch list, login.

You own everything the user touches. If the panel feels slow or generic, no amount of backend brilliance rescues the demo.

---

## Owns

- Chrome MV3 shell, side panel, icon behaviour
- Login and token storage; token attached to every call
- `captureVisibleTab()` and DOM hint extraction (JSON-LD, OpenGraph)
- **The generic schema → controls renderer**
- Mandate form and the arm confirmation
- Watch list: the user's instructions and their live states
- Empty, loading, low-confidence and error states
- `host_permissions` and the client half of CORS
- The notification surface — rendering the events P1 emits

## Does NOT own

- **Which controls exist.** That comes from P3's `constraint_schema`. You render what arrives.
- Any product logic, any pricing maths, any judgment about offers
- Backend state — you read it, you never compute it

> **Boundary rule: never branch on a schema `key`.** The moment you write `if (key === "generation")`, the claim that nobody hardcoded the form is dead — and that claim is Beat 2 of the demo. Render by `type`, always.

---

## Consumes

| From | What | Contract |
|------|------|----------|
| P1 | Auth, instruction list, instruction detail | `§ Auth`, `GET /instructions` |
| P3 | `constraint_schema` → your controls | `POST /understand` |
| P3 | candidate retailers → approve toggles | `POST /discover` |
| P4 | committed amount to show on the arm screen | `POST /funds/commit` |

## Produces

| For | What | Due |
|-----|------|-----|
| P1 | Auth shape agreed in writing | **T+0:30** |
| P3 | Capture payload: url, screenshot_b64, dom_hints | **T+0:45** |
| P1 | Mandate payload on arm | T+2:30 |

---

## Tasks

- [ ] T+0:30 — MV3 shell: icon opens the side panel on any page. Nothing else.
- [ ] T+0:30 — Auth shape settled with P1. Blocking for both of you.
- [ ] T+0:45 — Capture payload shape agreed with P3, so they can build against it.
- [ ] T+1:00 — Login, token stored, attached to every request. Handle 401 by re-prompting, never by failing silently.
- [ ] T+1:00 — **Skeleton on screen in 200ms** from JSON-LD, before any network call returns. A spinner on an empty panel is where this demo dies emotionally.
- [ ] T+1:45 — Generic renderer against P3's mock: `enum` → segmented control, `bool` → toggle, `money` → input, `date` → picker, `int` → stepper.
- [ ] T+2:15 — Cross-retailer results with a per-retailer approve toggle.
- [ ] T+2:30 — Mandate form → arm → confirmation stating exactly what was committed and its ceiling. That sentence is doing trust work; write it carefully.
- [ ] T+3:00 — Watch list with live states.
- [ ] T+3:15 — Low-confidence path: below ~0.7, ask rather than assume. An agent that asks reads smarter than one that guesses.
- [ ] T+3:45 — Skeleton → AI-result upgrade animation. This is Beat 2 and it is worth twenty minutes.

---

## Screenshot budget

Downscale before sending. A full-resolution page screenshot is slow to upload and expensive to process, and it is the most likely cause of a four-second panel feeling like ten. Agree the target size with P3 at T+0:45.

---

## Done when

On a retailer page nobody tested, clicking the icon produces correct, category-appropriate controls in under four seconds, with something readable on screen the entire time.
