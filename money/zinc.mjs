// Compralo — Zinc client. The click at the retailer.
//
// Zinc buys with its own accounts and its own money. We never touch a retailer
// checkout, and the user's card is never presented to one. Sandbox and live
// share one shape — only the key differs, and today only a sandbox key boots.

import { createHash } from 'node:crypto'

const BASE = 'https://api.zinc.com'
const KEY = process.env.ZINC_API_KEY
if (!KEY?.startsWith('zn_test_')) {
  console.error('Refusing to boot without a Zinc SANDBOX key (zn_test_…). Nobody buys for real today.')
  process.exit(1)
}
const headers = { Authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }

// What we can actually auto-buy. P1 filters instructions against this; P3 ranks by it.
export const COVERAGE = [
  'amazon', 'amazon_uk', 'amazon_ca', 'amazon_de', 'amazon_fr', 'amazon_mx',
  'bestbuy', 'walmart', 'homedepot',
]

// Sandbox rehearsals. Real URLs in production; these in the demo.
export const TEST_URLS = {
  success:        'https://zinc.com/shop/products/test-success',
  out_of_stock:   'https://zinc.com/shop/products/test-out-of-stock',
  price_exceeded: 'https://zinc.com/shop/products/test-price-exceeded',
}

// The sandbox knows only its rehearsal slugs. A real listing URL from P1's monitor is
// swapped for the success slug and kept on the record. This module boots on sandbox keys
// only, so this can never touch a live order.
export function sandboxUrl(url) {
  return /^https:\/\/zinc\.com\/shop\/products\//.test(url ?? '') ? url : TEST_URLS.success
}

// Zinc wants a UUID; we want the same key on every retry. Derive one from the other.
export function uuidFrom(key) {
  const h = createHash('sha1').update(key).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}

// max_price is Zinc's own ceiling on the order — a second one, independent of Stripe's.
export async function placeOrder({ url, quantity = 1, max_price, shipping_address, idempotency_key }) {
  const r = await fetch(`${BASE}/orders`, {
    method: 'POST', headers,
    body: JSON.stringify({ products: [{ url, quantity }], shipping_address, max_price, idempotency_key }),
  })
  const d = await r.json()
  if (!r.ok) throw Object.assign(new Error(d.message ?? d.error ?? `zinc ${r.status}`), { zinc: d, status: r.status })
  return d
}

// order_placed and order_failed are the only terminal states. Sandbox reaches one in
// seconds; production takes minutes, which is why /checkout must go async before launch.
export async function waitForOrder(id, { timeoutMs = 20_000, everyMs = 1_000 } = {}) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const d = await (await fetch(`${BASE}/orders/${id}`, { headers })).json()
    if (d.status === 'order_placed' || d.status === 'order_failed') return d
    await new Promise(r => setTimeout(r, everyMs))
  }
  throw Object.assign(new Error('zinc order still pending'), { pending: true, order_id: id })
}
