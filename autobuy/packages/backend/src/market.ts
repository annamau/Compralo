// Thin client for the market simulator. Swap this file for a Streetmerchant-style adapter later.
import { MARKET_URL } from "./env.js";
import type { RawOffer } from "../../shared/types.js";

export async function fetchOffers(): Promise<RawOffer[]> {
  const r = await fetch(`${MARKET_URL}/offers`);
  if (!r.ok) throw new Error(`market GET /offers → ${r.status}`);
  return (await r.json()) as RawOffer[];
}

export type CheckoutResult =
  | { ok: true; merchant_order_id: string }
  | { ok: false; status: number; actual_total?: number; error?: string };

export async function checkout(offer_id: string, expected_total: number): Promise<CheckoutResult> {
  const r = await fetch(`${MARKET_URL}/checkout`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ offer_id, expected_total }),
  });
  const body = (await r.json().catch(() => ({}))) as { merchant_order_id?: string; actual_total?: number; error?: string };
  if (r.ok && body.merchant_order_id) return { ok: true, merchant_order_id: body.merchant_order_id };
  return { ok: false, status: r.status, actual_total: body.actual_total, error: body.error };
}

export async function fetchRetailers(): Promise<string[]> {
  try {
    const r = await fetch(`${MARKET_URL}/retailers`);
    if (r.ok) return (await r.json()) as string[];
  } catch { /* market down: fall through */ }
  return ["store-a", "store-b", "store-c"];
}
