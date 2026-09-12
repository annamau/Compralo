// Guards the money path: the three demo offers must give reject / reject / qualify.
// Run: npm run test:rules   (from repo root)
import assert from "node:assert/strict";
import { evaluate } from "./rules.js";
import type { Instruction, NormalisedOffer } from "../../shared/types.js";
import { PS5 } from "./fixtures.js";

const instruction: Instruction = {
  id: "test", product: PS5.product, status: "ACTIVE", stripe_payment_intent: "pi_test", order: null, created_at: new Date().toISOString(),
  constraints: { max_total: 450, currency: "EUR", quantity: 1, condition: "new", approved_retailers: ["store-a", "store-b", "store-c"], deadline: new Date(Date.now() + 30 * 864e5).toISOString(), variant: { edition: "digital", storage: "1TB" }, allow_bundles: false },
};
const offer = (o: Partial<NormalisedOffer> & { attributes?: Record<string, string> }): NormalisedOffer => ({
  id: "x", retailer: "store-c", listing_title: "PS5", price: 448, shipping: 0, currency: "EUR", condition: "new", in_stock: true, url: "",
  is_bundle: false, total: (o.price ?? 448) + (o.shipping ?? 0), ...o,
  canonical: { ...PS5.product, attributes: { ...PS5.product.attributes, ...(o.attributes ?? {}) } },
});
const failing = (i: Instruction, o: NormalisedOffer) => evaluate(i, o).checks.filter((c) => !c.pass).map((c) => c.name);

// A: disc + bundle, 430 → wrong edition, bundle not allowed
assert.deepEqual(failing(instruction, offer({ retailer: "store-a", price: 430, is_bundle: true, attributes: { edition: "disc" } })), ["bundle", "variant:edition"]);
// B: correct product, 445 + 15 = 460 > 450
assert.deepEqual(failing(instruction, offer({ retailer: "store-b", price: 445, shipping: 15 })), ["price"]);
assert.equal(evaluate(instruction, offer({ retailer: "store-b", price: 445, shipping: 15 })).checks.at(-1)?.detail, "460.00 > 450.00");
// C: correct product, 448 delivered → qualifies
const c = evaluate(instruction, offer({ retailer: "store-c", price: 448 }));
assert.equal(c.qualified, true);
assert.equal(c.checks.length, 10);
assert.equal(c.checks.at(-1)?.detail, "448.00 ≤ 450.00");
// Every check is always emitted, even after an earlier failure
assert.equal(evaluate({ ...instruction, status: "PURCHASED" }, offer({})).checks.length, 10);
// EXECUTING (revalidation) passes the status check; PURCHASED does not
assert.equal(evaluate({ ...instruction, status: "EXECUTING" }, offer({})).qualified, true);
assert.equal(failing({ ...instruction, status: "PURCHASED" }, offer({}))[0], "status");
// Other gates
assert.deepEqual(failing(instruction, offer({ retailer: "store-z" })), ["retailer"]);
assert.deepEqual(failing(instruction, offer({ in_stock: false })), ["in_stock"]);
assert.deepEqual(failing(instruction, offer({ condition: "Refurbished" })), ["condition"]);
assert.deepEqual(failing(instruction, offer({ currency: "GBP" })), ["currency"]);
assert.deepEqual(failing({ ...instruction, constraints: { ...instruction.constraints, condition: "any", allow_bundles: true } }, offer({ condition: "refurbished", is_bundle: true })), []);
assert.deepEqual(failing({ ...instruction, constraints: { ...instruction.constraints, variant: { size: ["42", "43"] } } }, offer({ attributes: { size: "43" } })), []);
assert.deepEqual(failing({ ...instruction, constraints: { ...instruction.constraints, deadline: new Date(Date.now() - 1000).toISOString() } }, offer({})), ["deadline"]);
console.log("rules.test: all assertions passed");
