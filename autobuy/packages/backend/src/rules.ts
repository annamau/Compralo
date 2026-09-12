// The rule engine. Pure: no I/O, no imports except types. This is the only thing that
// decides whether an offer qualifies. Every check is always emitted, pass or fail, so the
// dashboard can show the whole decision.
import type { Check, Evaluation, Instruction, NormalisedOffer } from "../../shared/types.js";

const money = (n: number) => n.toFixed(2);
const norm = (s: string) => String(s).trim().toLowerCase();

export function evaluate(instruction: Instruction, offer: NormalisedOffer): Evaluation {
  const c = instruction.constraints;
  const checks: Check[] = [];

  // 1. Instruction is live. EXECUTING is the executor's own revalidation pass.
  const live = instruction.status === "ACTIVE" || instruction.status === "EXECUTING";
  checks.push({ name: "status", pass: live, detail: live ? `instruction ${instruction.status}` : `instruction is ${instruction.status}, not ACTIVE` });

  // 2. Deadline not passed.
  const deadline = Date.parse(c.deadline);
  const inTime = Number.isFinite(deadline) && Date.now() <= deadline;
  checks.push({ name: "deadline", pass: inTime, detail: inTime ? `until ${c.deadline.slice(0, 10)}` : `deadline ${c.deadline.slice(0, 10)} passed` });

  // 3. Retailer approved.
  const retailerOk = c.approved_retailers.includes(offer.retailer);
  checks.push({ name: "retailer", pass: retailerOk, detail: retailerOk ? `${offer.retailer} approved` : `${offer.retailer} not in [${c.approved_retailers.join(", ")}]` });

  // 4. In stock.
  checks.push({ name: "in_stock", pass: offer.in_stock, detail: offer.in_stock ? "in stock" : "out of stock" });

  // 5. Condition allowed.
  const cond = norm(offer.condition);
  const condOk = c.condition === "any" || cond === c.condition;
  checks.push({ name: "condition", pass: condOk, detail: condOk ? `${cond} (want ${c.condition})` : `${cond} ≠ ${c.condition}` });

  // 6. Not a bundle unless allowed.
  const bundleOk = !offer.is_bundle || c.allow_bundles;
  checks.push({ name: "bundle", pass: bundleOk, detail: offer.is_bundle ? (c.allow_bundles ? "bundle, allowed" : "bundle, not allowed") : "not a bundle" });

  // 7. Every mandated attribute equals the offer's normalised attribute (one check per key).
  for (const [key, want] of Object.entries(c.variant)) {
    const got = offer.canonical.attributes[key];
    const wants = (Array.isArray(want) ? want : [want]).map(norm);
    const ok = got !== undefined && wants.includes(norm(got));
    checks.push({ name: `variant:${key}`, pass: ok, detail: ok ? `${key} = ${got}` : `${key} is ${got ?? "unknown"}, want ${wants.join(" | ")}` });
  }

  // 8. Currency matches.
  const curOk = norm(offer.currency) === norm(c.currency);
  checks.push({ name: "currency", pass: curOk, detail: curOk ? offer.currency.toUpperCase() : `${offer.currency} ≠ ${c.currency}` });

  // 9. Delivered total within the ceiling — the arithmetic is the detail.
  const priceOk = offer.total <= c.max_total + 1e-9;
  checks.push({ name: "price", pass: priceOk, detail: `${money(offer.total)} ${priceOk ? "≤" : ">"} ${money(c.max_total)}` });

  return { qualified: checks.every((k) => k.pass), checks };
}
