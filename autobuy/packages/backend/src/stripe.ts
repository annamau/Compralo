// The money layer. AutoBuy does not touch Stripe directly any more: every movement of money
// goes through P4's money service (`money/money.mjs`), which owns the Stripe keys, the Zinc
// aggregator and the hold ledger. This file is a thin HTTP client for that contract.
//
// Why: three ceilings sit between the model and the money, and none of them is an `if` of ours —
// the rules engine before anything, Stripe at capture, Zinc's `max_price` at placement. Keeping
// the capture out of this process is what makes the second ceiling real.
//
// The names `authorise` / `capture` and the Stripe-flavoured statuses survive so `index.ts` and
// `executor.ts` read the same as before. `committed` maps to `requires_capture`, `needs_attention`
// to `requires_action`.
import { P4_URL } from "./env.js";
import type { CanonicalProduct, Constraints } from "../../shared/types.js";

export const STRIPE_MODE = "p4" as const;
export const MONEY_URL = P4_URL;

export type Authorisation = { id: string; status: string; amount: number; currency: string; client_secret?: string };

/** P4's /checkout response — the one call that spends the hold and places the order. */
export type P4CheckoutStatus = "PURCHASED" | "DECLINED" | "FAILED" | "NEEDS_ATTENTION" | "UNKNOWN";
export type P4CheckoutResult = {
  status: P4CheckoutStatus;
  order_ref?: string;
  total_cents?: number;
  released_cents?: number;
  captured_cents?: number;
  refunded_cents?: number;
  currency?: string;
  decline_reason?: string;
  enforced_by?: string;
  message?: string;
  actual_total_cents?: number;
  merchant_total_cents?: number;
  zinc_order_id?: string;
  listing_url?: string;
  sandbox_url_substituted?: boolean;
  retailer?: string;
  merchant?: string;
};

export type P4Offer = { id: string; url: string; retailer: string; total_cents: number; currency: string };

async function p4<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${P4_URL}${path}`, init);
  const text = await r.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text }; }
  if (!r.ok) {
    const b = body as { error?: string; message?: string };
    throw new Error(`P4 ${path} → ${r.status} ${b.message ?? b.error ?? text}`);
  }
  return body as T;
}

/** Fail loudly at boot rather than at the first purchase: no money service, no AutoBuy. */
export async function assertMoneyUp(): Promise<void> {
  try {
    const h = await p4<{ ok?: boolean; mode?: string; market?: string }>("/health");
    if (!h.ok) throw new Error(`/health returned ${JSON.stringify(h)}`);
    console.log(`[money] P4 up at ${P4_URL} (mode ${h.mode ?? "?"}, market ${h.market ?? "?"})`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`\nFATAL: the P4 money service is unreachable at ${P4_URL} (${msg}).`);
    console.error(`        Start it first:  cd money && npm start`);
    console.error(`        Or point P4_URL at it in packages/backend/.env\n`);
    process.exit(1);
  }
}

/**
 * Arm the mandate: POST /funds/commit places a hold for the ceiling at Stripe.
 * `committed` → requires_capture (ACTIVE); `needs_attention` → requires_action (3DS at arm time).
 */
export async function authorise(
  product: CanonicalProduct,
  constraints: Constraints,
  payment_method = "pm_card_visa",
  instruction_id?: string,
  attempt = 1,
): Promise<Authorisation> {
  const amount_cents = Math.round(constraints.max_total * 100);
  const currency = constraints.currency.toLowerCase();
  const id = instruction_id ?? `autobuy_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const r = await p4<{ hold_id: string; status: "committed" | "needs_attention"; expires: string; committed_cents: number; currency: string; client_secret?: string; message?: string }>(
    "/funds/commit",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ instruction_id: id, amount_cents, currency, payment_method, attempt }) },
  );
  const status = r.status === "committed" ? "requires_capture" : "requires_action";
  console.log(`[money] commit ${amount_cents} ${r.currency} on ${payment_method} → ${r.hold_id} ${r.status} (expires ${r.expires?.slice(0, 10) ?? "?"}) [${status}]`);
  return { id: r.hold_id, status, amount: r.committed_cents, currency: r.currency, client_secret: r.client_secret };
}

/**
 * Buy: one call that does merchant checkout AND payment. P4 routes on retailer —
 * `store-*` verifies at the market first then captures; anything else captures then
 * places the order through Zinc. AutoBuy never sees which; it reads the status.
 */
export async function purchase(args: { instruction_id: string; offer_id: string; idempotency_key: string; hold_id?: string | null; offer: P4Offer }): Promise<P4CheckoutResult> {
  const body = {
    instruction_id: args.instruction_id,
    offer_id: args.offer_id,
    idempotency_key: args.idempotency_key,
    ...(args.hold_id ? { hold_id: args.hold_id } : {}),
    offer: args.offer,
  };
  const r = await p4<P4CheckoutResult>("/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  console.log(`[money] checkout ${args.offer.retailer} ${args.offer.total_cents} ${args.offer.currency} → ${r.status}${r.order_ref ? ` ${r.order_ref}` : ""}${r.decline_reason ? ` (${r.decline_reason}${r.enforced_by ? ` · enforced_by ${r.enforced_by}` : ""})` : ""}`);
  return r;
}

/** Poll a purchase that came back UNKNOWN. 200 = settled purchased, 202 = still pending, 404 = never landed. */
export async function findPurchase(idempotency_key: string): Promise<{ code: number; body: P4CheckoutResult }> {
  const r = await fetch(`${P4_URL}/purchases/${encodeURIComponent(idempotency_key)}`);
  const body = (await r.json().catch(() => ({}))) as P4CheckoutResult;
  return { code: r.status, body };
}

/** Every terminal state lands here. Idempotent at P4, so callers need not check first. */
export async function release(instructionId: string, reason: string): Promise<{ status: "released" | "spent" | "unknown"; message?: string }> {
  try {
    const r = await p4<{ status: "released" | "spent"; message?: string; amount_cents?: number }>(
      "/funds/release",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ instruction_id: instructionId, reason }) },
    );
    console.log(`[money] release ${instructionId.slice(0, 8)} (${reason}) → ${r.status}${r.amount_cents ? ` ${r.amount_cents}` : ""}`);
    return r;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[money] release ${instructionId.slice(0, 8)} (${reason}) failed: ${msg}`);
    return { status: "unknown", message: msg };
  }
}

/** What the dashboard and the runbook read back. */
export async function holdFor(instructionId: string): Promise<{ hold_id: string; status: string; amount_cents: number; currency: string; expires: string } | null> {
  try {
    return await p4(`/funds/by-instruction/${encodeURIComponent(instructionId)}`);
  } catch { return null; }
}
