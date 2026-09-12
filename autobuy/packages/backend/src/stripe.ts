// Stripe test mode, manual capture. With no STRIPE_SECRET_KEY this is a stub that returns the
// same shapes, so the whole pipeline runs offline; the log says STUB on every call.
import Stripe from "stripe";
import type { CanonicalProduct, Constraints } from "../../shared/types.js";

// Only a well-formed TEST key switches the real client on. A placeholder, a malformed value or a
// live key falls back to the stub with a loud warning: this demo must never charge a real card.
const RAW_KEY = process.env.STRIPE_SECRET_KEY?.trim() ?? "";
const KEY = /^sk_test_[A-Za-z0-9]{16,}$/.test(RAW_KEY) ? RAW_KEY : "";
if (RAW_KEY && !KEY) console.warn(`[stripe] STRIPE_SECRET_KEY is ${RAW_KEY.startsWith("sk_live_") ? "a LIVE key — refused" : "not a well-formed sk_test_ key"}; using the stub`);
export const STRIPE_MODE: "test" | "stub" = KEY ? "test" : "stub";
const stripe = KEY ? new Stripe(KEY) : null;

export type Authorisation = { id: string; status: string; amount: number; currency: string };

/** Place a hold for the mandate ceiling. Returns the PaymentIntent id and status. */
export async function authorise(product: CanonicalProduct, constraints: Constraints, payment_method = "pm_card_visa"): Promise<Authorisation> {
  const amount = Math.round(constraints.max_total * 100);
  const currency = constraints.currency.toLowerCase();
  if (!stripe) {
    const status = payment_method === "pm_card_authenticationRequired" ? "requires_action" : "requires_capture";
    console.log(`[stripe STUB] authorise ${amount} ${currency} on ${payment_method} → ${status}`);
    return { id: `pi_stub_${Date.now().toString(36)}`, status, amount, currency };
  }
  const pi = await stripe.paymentIntents.create({
    amount, currency, payment_method, payment_method_types: ["card"],
    confirm: true, capture_method: "manual",
    description: `AutoBuy mandate: ${product.name}`,
  });
  console.log(`[stripe] authorised ${pi.id} ${pi.amount} ${pi.currency} status=${pi.status}`);
  return { id: pi.id, status: pi.status, amount: pi.amount, currency: pi.currency };
}

/** Capture the actual total — never more than authorised; Stripe releases the rest. */
export async function capture(paymentIntentId: string, total: number): Promise<{ id: string; amount_received: number; status: string }> {
  const amount_to_capture = Math.round(total * 100);
  if (!stripe) {
    console.log(`[stripe STUB] capture ${amount_to_capture} on ${paymentIntentId} → succeeded`);
    return { id: paymentIntentId, amount_received: amount_to_capture, status: "succeeded" };
  }
  const pi = await stripe.paymentIntents.capture(paymentIntentId, { amount_to_capture });
  console.log(`[stripe] captured ${pi.amount_received} on ${pi.id} status=${pi.status}`);
  return { id: pi.id, amount_received: pi.amount_received, status: pi.status };
}
