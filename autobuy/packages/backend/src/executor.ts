// The executor: lock → revalidate → P4 /checkout → PURCHASED.
//
// Merchant checkout and payment used to be two steps here. They are now one call to P4's money
// service, because the *order* of those two steps depends on the merchant and only P4 knows it:
//   store-*  the market can quote without committing → verify first, capture second. A 409 costs
//            nothing and the hold survives, so the agent keeps watching.
//   amazon…  Zinc commits on contact → capture first, so an over-mandate order can never reach the
//            aggregator; Stripe refuses the capture and Zinc is never called. Refund on failure.
// AutoBuy does not choose. It sends the offer and reads one of five statuses back.
import type { Instruction, NormalisedOffer } from "../../shared/types.js";
import { evaluate } from "./rules.js";
import { fetchOffers } from "./market.js";
import { findPurchase, purchase, type P4CheckoutResult } from "./stripe.js";
import { emit } from "./events.js";
import { setStatus } from "./state.js";
import { notify } from "./notify.js";
import { money, round2, summary } from "./util.js";

const locks = new Map<string, string>(); // instruction id → offer id being executed

// An UNKNOWN from P4 means money moved and an order may yet exist. Never retry, never refund:
// poll the idempotency key until the aggregator settles it.
const UNKNOWN_POLL_MS = 5_000;
const UNKNOWN_TIMEOUT_MS = 10 * 60_000;

export type ExecuteResult =
  | "LOCK_HELD" | "REVALIDATION_FAILED" | "PRICE_MISMATCH" | "CHECKOUT_FAILED"
  | "CAPTURE_FAILED" | "PURCHASED" | "DECLINED" | "NEEDS_ATTENTION" | "UNRESOLVED";

const cents = (n: number | undefined) => (n === undefined ? undefined : n / 100);

export async function execute(instruction: Instruction, offer: NormalisedOffer): Promise<ExecuteResult> {
  const id = instruction.id;
  if (locks.has(id)) {
    console.log(`[executor] LOCK_HELD on ${id.slice(0, 8)} (executing ${locks.get(id)}); ignoring ${offer.id}`);
    return "LOCK_HELD";
  }
  locks.set(id, offer.id);
  try {
    setStatus(instruction, "EXECUTING");
    emit(id, "LOCK_ACQUIRED", `lock held for ${offer.retailer} ${offer.id} at ${money(offer.total)} ${offer.currency}; one order per instruction`, { offer_id: offer.id });

    // 1. Revalidate against a fresh read of the market — the listing may have changed since the tick began.
    const fresh = (await fetchOffers()).find((o) => o.id === offer.id);
    if (!fresh) {
      emit(id, "REVALIDATED", `offer ${offer.id} has vanished from the market — back to monitoring`, { offer: summary(offer), checks: [] });
      setStatus(instruction, "ACTIVE");
      return "REVALIDATION_FAILED";
    }
    const live: NormalisedOffer = { ...fresh, canonical: offer.canonical, is_bundle: offer.is_bundle, total: round2(fresh.price + fresh.shipping) };
    const ev = evaluate(instruction, live);
    const failed = ev.checks.filter((c) => !c.pass);
    emit(id, "REVALIDATED",
      ev.qualified ? `re-fetched and re-checked: still qualifies at ${money(live.total)}` : `re-fetched: no longer qualifies — ${failed.map((c) => `${c.name} (${c.detail})`).join("; ")}`,
      { offer: summary(live), checks: ev.checks });
    if (!ev.qualified) { setStatus(instruction, "ACTIVE"); return "REVALIDATION_FAILED"; }

    // 2. One call to the money service: merchant checkout and payment, in whichever order
    //    the merchant demands. Same idempotency key for the life of the instruction — P4
    //    caches only PURCHASED under it, so this can never buy twice.
    const idempotency_key = `purchase_${instruction.id}`;
    let r: P4CheckoutResult;
    try {
      r = await purchase({
        instruction_id: instruction.id,
        offer_id: live.id,
        idempotency_key,
        hold_id: instruction.stripe_payment_intent,
        offer: { id: live.id, url: live.url, retailer: live.retailer, total_cents: Math.round(live.total * 100), currency: live.currency },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      emit(id, "FAILED", `money service unreachable: ${msg} — nothing captured, still monitoring`, { offer: summary(live), error: msg });
      setStatus(instruction, "ACTIVE");
      return "CHECKOUT_FAILED";
    }

    return await settle(instruction, live, r, idempotency_key);
  } finally {
    locks.delete(id);
  }
}

/** Map P4's five statuses onto the instruction's state machine and the event log. */
async function settle(instruction: Instruction, live: NormalisedOffer, r: P4CheckoutResult, idempotency_key: string): Promise<ExecuteResult> {
  const id = instruction.id;

  switch (r.status) {
    // ── bought ────────────────────────────────────────────────────────────────────────────
    case "PURCHASED": {
      const order_ref = r.order_ref ?? "unknown";
      const paid = cents(r.total_cents) ?? live.total;
      const released = cents(r.released_cents);
      emit(id, "CHECKOUT_OK", `${live.retailer} accepted order ${order_ref} at ${money(paid)} ${live.currency}${r.zinc_order_id ? ` (zinc ${r.zinc_order_id}${r.sandbox_url_substituted ? ", sandbox slug substituted" : ""})` : ""}`,
        { merchant_order_id: order_ref, total: paid, zinc_order_id: r.zinc_order_id, listing_url: r.listing_url, sandbox_url_substituted: r.sandbox_url_substituted });
      emit(id, "PAYMENT_CAPTURED", `captured ${money(paid)} ${live.currency.toUpperCase()} against the hold${released !== undefined ? `, ${money(released)} released back` : ""} — order ${order_ref}`,
        { order_ref, total_cents: r.total_cents, released_cents: r.released_cents, currency: r.currency, hold_id: instruction.stripe_payment_intent });

      instruction.order = { retailer: live.retailer, total: paid, merchant_order_id: order_ref, at: new Date().toISOString() };
      setStatus(instruction, "PURCHASED");
      emit(id, "PURCHASED", `${instruction.product.name} from ${live.retailer} for ${money(paid)} ${live.currency} — order ${order_ref}`, { order: instruction.order });
      notify("AutoBuy: purchased", `${instruction.product.name} — ${live.retailer} ${money(paid)} ${live.currency}`);
      return "PURCHASED";
    }

    // ── refused ───────────────────────────────────────────────────────────────────────────
    // Two very different refusals, and the demo turns on telling them apart. A merchant that
    // changed its price is a market fact; a payment layer that refused the amount is a ceiling
    // we did not write. Both keep the mandate alive — the hold is untouched either way.
    case "DECLINED": {
      setStatus(instruction, "ACTIVE");
      if (r.decline_reason === "price_mismatch") {
        const actual = cents(r.actual_total_cents);
        emit(id, "CHECKOUT_PRICE_MISMATCH",
          `${live.retailer} listed ${money(live.total)} but wants ${actual !== undefined ? money(actual) : "?"} at checkout — aborted, nothing captured, lock released, still monitoring`,
          { offer: summary(live), expected_total: live.total, actual_total: actual, enforced_by: r.enforced_by });
        return "PRICE_MISMATCH";
      }
      // `decline_reason` is the payment layer's own code, verbatim. It goes on screen unedited:
      // the point is that this sentence was not written by us.
      emit(id, "PAYMENT_DECLINED",
        `${r.decline_reason ?? "declined"}${r.enforced_by ? ` · enforced by ${r.enforced_by}` : ""} — ${r.message ?? "the payment layer refused this purchase"}. Nothing captured, hold intact, still monitoring.`,
        { offer: summary(live), decline_reason: r.decline_reason, enforced_by: r.enforced_by, message: r.message, attempted_total: live.total });
      return "DECLINED";
    }

    // ── the money came back ───────────────────────────────────────────────────────────────
    // out_of_stock, max_price_exceeded, zinc_error: the hold has been refunded, so the
    // instruction cannot buy again until the user re-arms it.
    case "FAILED": {
      emit(id, "FAILED",
        `${r.decline_reason ?? "failed"} — ${r.message ?? "the purchase did not complete"}${r.refunded_cents !== undefined ? `; ${money(r.refunded_cents / 100)} refunded` : ""}`,
        { offer: summary(live), decline_reason: r.decline_reason, message: r.message, refunded_cents: r.refunded_cents, zinc_order_id: r.zinc_order_id });
      setStatus(instruction, "NEEDS_ATTENTION");
      emit(id, "PAYMENT_ACTION_REQUIRED", `hold refunded — re-arm`, { reason: r.decline_reason, detail: "hold refunded — re-arm" });
      return "CAPTURE_FAILED";
    }

    // ── the customer has to do something ──────────────────────────────────────────────────
    case "NEEDS_ATTENTION": {
      emit(id, "PAYMENT_ACTION_REQUIRED",
        `${r.decline_reason ?? "authentication_required"} — ${r.message ?? "the card needs the customer"}; not monitoring until it is resolved`,
        { offer: summary(live), decline_reason: r.decline_reason, message: r.message });
      setStatus(instruction, "NEEDS_ATTENTION");
      return "NEEDS_ATTENTION";
    }

    // ── nobody knows yet ──────────────────────────────────────────────────────────────────
    // Money is captured and an order may exist. This is NOT a failure and must NOT be retried:
    // stay EXECUTING and ask P4 for the key until it resolves.
    case "UNKNOWN":
    default: {
      emit(id, "FAILED",
        `order still pending at the retailer — ${money((r.captured_cents ?? 0) / 100)} ${live.currency} captured, polling the money service every ${UNKNOWN_POLL_MS / 1000}s for up to ${UNKNOWN_TIMEOUT_MS / 60_000} min before deciding`,
        { offer: summary(live), captured_cents: r.captured_cents, zinc_order_id: r.zinc_order_id, idempotency_key });
      return await pollUnknown(instruction, live, idempotency_key);
    }
  }
}

/** GET /purchases/:key every 5 s for up to 10 min. 200 settles it; 404 means it never landed. */
async function pollUnknown(instruction: Instruction, live: NormalisedOffer, idempotency_key: string): Promise<ExecuteResult> {
  const id = instruction.id;
  const until = Date.now() + UNKNOWN_TIMEOUT_MS;
  while (Date.now() < until) {
    await new Promise((res) => setTimeout(res, UNKNOWN_POLL_MS));
    let found: Awaited<ReturnType<typeof findPurchase>>;
    try { found = await findPurchase(idempotency_key); } catch { continue; }
    if (found.code === 202) continue;                       // still pending at the aggregator
    if (found.code === 200) return await settle(instruction, live, found.body, idempotency_key);
    if (found.code === 404) {                               // the order never landed under this key
      emit(id, "FAILED", `the money service has no purchase under ${idempotency_key} — the order never landed; needs a human before any retry`, { idempotency_key });
      setStatus(instruction, "NEEDS_ATTENTION");
      emit(id, "PAYMENT_ACTION_REQUIRED", `hold refunded — re-arm`, { reason: "unresolved", detail: "hold refunded — re-arm" });
      return "UNRESOLVED";
    }
  }
  emit(id, "FAILED", `order still unresolved after ${UNKNOWN_TIMEOUT_MS / 60_000} min — money may have moved; reconcile with the money service before any retry`, { idempotency_key });
  setStatus(instruction, "NEEDS_ATTENTION");
  return "UNRESOLVED";
}
