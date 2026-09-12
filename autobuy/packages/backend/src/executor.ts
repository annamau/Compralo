// The executor: lock → revalidate → merchant checkout → Stripe capture → PURCHASED.
// Checkout comes before capture on purpose: a merchant 409 (price changed) then costs
// nothing and the authorisation hold survives, so the agent keeps monitoring.
import type { Instruction, NormalisedOffer } from "../../shared/types.js";
import { evaluate } from "./rules.js";
import { checkout, fetchOffers } from "./market.js";
import { capture } from "./stripe.js";
import { emit } from "./events.js";
import { setStatus } from "./state.js";
import { notify } from "./notify.js";
import { money, round2, summary } from "./util.js";

const locks = new Map<string, string>(); // instruction id → offer id being executed

export type ExecuteResult = "LOCK_HELD" | "REVALIDATION_FAILED" | "PRICE_MISMATCH" | "CHECKOUT_FAILED" | "CAPTURE_FAILED" | "PURCHASED";

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

    // 2. Merchant checkout at the exact total we evaluated. No money has moved yet.
    const co = await checkout(live.id, live.total);
    if (!co.ok) {
      setStatus(instruction, "ACTIVE");
      if (co.status === 409) {
        emit(id, "CHECKOUT_PRICE_MISMATCH",
          `${live.retailer} listed ${money(live.total)} but wants ${co.actual_total !== undefined ? money(co.actual_total) : "?"} at checkout — aborted, nothing captured, lock released, still monitoring`,
          { offer: summary(live), expected_total: live.total, actual_total: co.actual_total });
        return "PRICE_MISMATCH";
      }
      emit(id, "FAILED", `merchant checkout failed (${co.status} ${co.error ?? ""}) — nothing captured, still monitoring`, { offer: summary(live), status: co.status });
      return "CHECKOUT_FAILED";
    }
    emit(id, "CHECKOUT_OK", `${live.retailer} accepted order ${co.merchant_order_id} at ${money(live.total)} ${live.currency}`, { merchant_order_id: co.merchant_order_id, total: live.total });

    // 3. Capture the actual total against the hold — never more than authorised.
    let cap: Awaited<ReturnType<typeof capture>>;
    try {
      cap = await capture(instruction.stripe_payment_intent ?? "", live.total);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      emit(id, "FAILED", `Stripe capture failed after merchant order ${co.merchant_order_id}: ${msg}`, { merchant_order_id: co.merchant_order_id, error: msg });
      setStatus(instruction, "FAILED");
      return "CAPTURE_FAILED";
    }
    emit(id, "PAYMENT_CAPTURED", `captured ${money(cap.amount_received / 100)} ${live.currency.toUpperCase()} on ${cap.id} (${cap.status})`, { payment_intent: cap.id, amount_received: cap.amount_received, status: cap.status });

    // 4. Fulfil.
    instruction.order = { retailer: live.retailer, total: live.total, merchant_order_id: co.merchant_order_id, at: new Date().toISOString() };
    setStatus(instruction, "PURCHASED");
    emit(id, "PURCHASED", `${instruction.product.name} from ${live.retailer} for ${money(live.total)} ${live.currency} — order ${co.merchant_order_id}`, { order: instruction.order });
    notify("AutoBuy: purchased", `${instruction.product.name} — ${live.retailer} ${money(live.total)} ${live.currency}`);
    return "PURCHASED";
  } finally {
    locks.delete(id);
  }
}
