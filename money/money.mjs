// Compralo — P4 Money.
//
// Three endpoints from CONTRACTS.md § P4, plus what P1's execution engine needs. The mandate hold:
//
//   commit   authorize max_total_cents          -> the ceiling now lives at Stripe
//   checkout capture true_total_cents, then buy  -> Stripe is one ceiling, the merchant's the other
//   release  cancel                             -> user made whole
//
// The ceiling is NOT enforced here. Read checkout() before you change it.
//
// Two merchants, two orders of operations, one rule:
//   market   (store-*)  can quote a price without committing → verify FIRST, capture second.
//                       A 409 costs nothing and the hold survives, so the agent keeps watching.
//   zinc     (amazon…)  commits on contact, with its own max_price ceiling → capture FIRST,
//                       so an over-mandate order can never reach the aggregator. Refund on failure.
//
// P1 speaks monitors and minor units; the contract speaks instructions and cents; AutoBuy speaks
// major units and converts at its edge. Every endpoint accepts both spellings. P1's Merchant trait:
//   checkout()   -> POST /checkout            (PURCHASED | NEEDS_ATTENTION | DECLINED | FAILED | UNKNOWN)
//   find_order() -> GET  /purchases/:idempotency_key
//   supports()   -> GET  /coverage

import express from 'express'
import Stripe from 'stripe'
import * as zinc from './zinc.mjs'

const KEY = process.env.STRIPE_SECRET_KEY
if (!KEY?.startsWith('sk_test_')) {
  console.error('Refusing to boot without a TEST key. Nobody runs live today.')
  process.exit(1)
}
const MARKET_URL = process.env.MARKET_URL ?? 'http://localhost:4000'
// Explicit fixture hosts for end-to-end sandbox tests; provider keys are test-only.
const SANDBOX_RETAILERS = (process.env.SANDBOX_RETAILERS ?? '').split(',').map(s => s.trim()).filter(Boolean)

const stripe = new Stripe(KEY)
const app = express()
app.use(express.json())

// P2's panel and P1's server call from other origins. Permissive today, same as P1.
app.use((req, res, next) => {
  res.set({
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  })
  req.method === 'OPTIONS' ? res.sendStatus(204) : next()
})

// Swap for P1's `payment_authorizations` and `merchant_orders` the moment the wiring lands.
// Until then this keeps three other lanes unblocked.
const holds = new Map()              // hold_id → hold
const holdsByInstruction = new Map() // instruction_id → latest hold_id
const purchases = new Map()          // idempotency_key → PURCHASED result only
const pending = new Map()            // idempotency_key → UNKNOWN result while a merchant order is unresolved

// Stripe holds an uncaptured authorization ~7 days; some issuers release sooner.
// This is a real deadline, not decoration — P1's checker must release when it passes.
const HOLD_TTL_MS = 7 * 24 * 60 * 60 * 1000

const pick = (...vals) => vals.find(v => v !== undefined && v !== null)
const resolveHold = (hold_id, instruction_id) => hold_id ?? holdsByInstruction.get(instruction_id)
const merchantFor = (retailer, explicit) => explicit ?? (/^store-/.test(retailer ?? '') ? 'market' : 'zinc')

// Until P1 puts shipping on the instruction, orders ship here. Zinc's sandbox is US-only.
const DEMO_SHIPPING = {
  first_name: 'Compralo', last_name: 'Demo', address_line1: '101 Market St',
  city: 'San Francisco', state: 'CA', postal_code: '94105', phone_number: '4155552671', country: 'US',
}

// POST /funds/commit — ONE TAP. The user is present here, so this is where 3DS belongs.
app.post('/funds/commit', async (req, res) => {
  const b = req.body
  const instruction_id = pick(b.instruction_id, b.monitor_id)
  const amount_cents = pick(b.amount_cents, b.maximum_minor, b.maximum_total_minor)
  const currency = (b.currency ?? 'eur').toLowerCase()
  const attempt = b.attempt ?? 1                       // re-arm bumps this; same attempt = same hold
  const payment_method = b.payment_method ?? 'pm_card_visa'
  if (!instruction_id || !amount_cents) return res.status(400).json({ error: 'instruction_id and amount_cents are required' })

  try {
    const pi = await stripe.paymentIntents.create({
      amount: amount_cents,          // the mandate ceiling, held by Stripe
      currency,
      capture_method: 'manual',
      payment_method,
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      metadata: { instruction_id },
    }, { idempotencyKey: `commit_${instruction_id}_${attempt}` })

    const expires = new Date(pi.created * 1000 + HOLD_TTL_MS).toISOString()
    // 3DS at arm time is a prompt, not a failure: the user is right there. P2 finishes it with client_secret.
    const status = pi.status === 'requires_action' ? 'needs_attention' : 'committed'
    holds.set(pi.id, { instruction_id, amount_cents, currency, expires, status, attempt })
    holdsByInstruction.set(instruction_id, pi.id)

    res.json({
      hold_id: pi.id, status, expires, committed_cents: amount_cents, currency,
      client_secret: pi.client_secret,   // P2 confirms with the Payment Element instead of a test PM when there's time
      ...(status === 'needs_attention' && { reason: 'authentication_required', message: 'Your bank wants to confirm this hold. Finish it in the panel.' }),
    })
  } catch (e) {
    res.status(402).json({ error: e.code, message: e.message })
  }
})

// POST /checkout — spend the committed funds and place the order.
//
// Only PURCHASED is remembered under the key. A DECLINED leaves the hold intact so a later
// offer can try again; a FAILED on the zinc path has refunded the hold, so re-arm first.
app.post('/checkout', async (req, res) => {
  const b = req.body, offer = b.offer ?? {}
  const instruction_id = pick(b.instruction_id, b.monitor_id)
  const offer_id = pick(b.offer_id, offer.id)
  const idempotency_key = b.idempotency_key ?? `purchase_${instruction_id}`
  const hold_id = resolveHold(b.hold_id, instruction_id)
  const total_cents = pick(b.total_cents, offer.total_cents, offer.total_minor, b.total_minor)
  const url = pick(offer.url, offer.source_url, b.url)
  const retailer = pick(offer.retailer, b.retailer)
  const merchant = merchantFor(retailer, b.merchant)
  const shipping = b.shipping ?? DEMO_SHIPPING
  const ctx = { instruction_id, offer_id, hold_id, retailer, merchant }

  // Same key twice returns the first purchase. It never buys twice.
  if (purchases.has(idempotency_key)) return res.json(purchases.get(idempotency_key))
  if (pending.has(idempotency_key)) return res.json(pending.get(idempotency_key))
  if (!total_cents) return res.status(400).json({ error: 'total_cents is required' })

  const hold = holds.get(hold_id)
  if (!hold) return res.json({ status: 'FAILED', decline_reason: 'no_hold', message: 'No committed funds for this instruction — arm it first', ...ctx })
  if (hold.status !== 'committed') return res.json({ status: 'FAILED', decline_reason: `hold_${hold.status}`, message: `Hold is ${hold.status}; re-arm before buying again`, ...ctx })

  // The Stripe key carries the hold and the amount: P1 reuses one key per monitor, and Stripe
  // replays a request under a reused key with different params as an error. Same hold + same
  // amount = a true retry; a re-armed hold or a new price is a new attempt.
  const stripeKey = `${idempotency_key}:${hold_id}:${total_cents}`
  const capture = () => stripe.paymentIntents.capture(hold_id, { amount_to_capture: total_cents }, { idempotencyKey: stripeKey })
  const refund = () => stripe.refunds.create({ payment_intent: hold_id }, { idempotencyKey: `refund_${stripeKey}` })
  const purchased = (pi, extra) => {
    const r = { status: 'PURCHASED', total_cents: pi.amount_received, currency: pi.currency, released_cents: pi.amount - pi.amount_received, ...extra, ...ctx }
    hold.status = 'spent'; purchases.set(idempotency_key, r); pending.delete(idempotency_key); return r
  }

  // ── market: verify first, capture second ────────────────────────────────────────────────
  if (merchant === 'market') {
    let co
    try {
      const r = await fetch(`${MARKET_URL}/checkout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ offer_id, expected_total: total_cents / 100 }) })
      co = { code: r.status, ...(await r.json().catch(() => ({}))) }
    } catch (e) {
      return res.json({ status: 'FAILED', decline_reason: 'merchant_unreachable', message: e.message, ...ctx })
    }
    if (co.code === 409) return res.json({ status: 'DECLINED', decline_reason: 'price_mismatch', enforced_by: 'merchant', message: `${retailer} listed ${(total_cents / 100).toFixed(2)} but wants ${co.actual_total} at checkout — nothing captured, still watching`, actual_total_cents: Math.round(co.actual_total * 100), ...ctx })
    if (co.code !== 200) return res.json({ status: 'FAILED', decline_reason: co.code === 404 ? 'out_of_stock' : 'merchant_error', message: co.error ?? `merchant ${co.code}`, ...ctx })

    // Do NOT compare total_cents to the hold before this call — see the zinc path below for why.
    let pi
    try { pi = await capture() } catch (e) {
      // An order exists and the money didn't move. Only reachable through a bug upstream; say so loudly.
      return res.json({ ...mapFailure(e, ctx), merchant_order_id: co.merchant_order_id, message: `${e.message} — merchant order ${co.merchant_order_id} placed but NOT paid; reconcile` })
    }
    return res.json(purchased(pi, { order_ref: co.merchant_order_id, merchant_total_cents: Math.round(co.total * 100) }))
  }

  // ── zinc: capture first, order second ───────────────────────────────────────────────────
  //
  // Do NOT compare total_cents to the hold amount before this call.
  //
  // Letting Stripe refuse an over-mandate capture is the strongest technical
  // claim in the demo: the ceiling is enforced outside our process. An `if`
  // here would be faster, and would throw away the entire point.
  let pi
  try { pi = await capture() } catch (e) { return res.json(mapFailure(e, ctx)) }

  let placed
  try {
    const zincUrl = zinc.sandboxUrl(url)   // sandbox knows only its rehearsal slugs; the listing URL stays on the record
    placed = await zinc.placeOrder({ url: zincUrl, max_price: total_cents, shipping_address: shipping, idempotency_key: zinc.uuidFrom(stripeKey) })
    ctx.zinc_order_id = placed.id; ctx.listing_url = url; ctx.sandbox_url_substituted = zincUrl !== url
  } catch (e) {
    await refund().catch(() => {}); hold.status = 'released'
    return res.json({ status: 'FAILED', decline_reason: e.zinc?.error_type ?? e.code ?? 'zinc_error', message: e.message, refunded_cents: pi.amount_received, ...ctx })
  }

  const settle = done => {
    if (done.status === 'order_placed') {
      return purchased(pi, { order_ref: done.job_result?.merchant_order_ids?.[0]?.merchant_order_id ?? done.id, merchant_total_cents: done.job_result?.price_components?.total })
    }
    // The retailer said no after we'd taken the money. Give it back, then say why.
    hold.status = 'released'; pending.delete(idempotency_key)
    return refund().catch(() => {}).then(() => ({ status: 'FAILED', decline_reason: done.job_result?.error_type ?? 'order_failed', message: done.job_result?.error ?? 'Retailer did not complete the order', refunded_cents: pi.amount_received, ...ctx }))
  }

  try {
    return res.json(await settle(await zinc.waitForOrder(placed.id)))
  } catch (e) {
    if (!e.pending) { await refund().catch(() => {}); hold.status = 'released'; return res.json({ status: 'FAILED', decline_reason: 'zinc_error', message: e.message, refunded_cents: pi.amount_received, ...ctx }) }
    // Still pending. Money is captured and an order may yet exist: this is NOT a failure and it is
    // NOT refunded. Report UNKNOWN, keep settling in the background, and let find_order() resolve it.
    const unknown = { status: 'UNKNOWN', message: 'Order still pending at the retailer — verify GET /purchases/:key before any retry', captured_cents: pi.amount_received, ...ctx }
    pending.set(idempotency_key, unknown)
    zinc.waitForOrder(placed.id, { timeoutMs: 10 * 60_000, everyMs: 5_000 }).then(settle).catch(() => {})
    return res.json(unknown)
  }
})

// POST /funds/release — every terminal state lands here. No lingering hold, ever.
// Idempotent on purpose: P1 may call it from cancel, expiry and failure without checking first.
app.post('/funds/release', async (req, res) => {
  const b = req.body
  const hold_id = resolveHold(b.hold_id, pick(b.instruction_id, b.monitor_id))
  const hold = holds.get(hold_id)
  if (!hold) return res.status(404).json({ error: 'no such hold' })
  const base = { hold_id, amount_cents: hold.amount_cents, reason: b.reason }
  if (hold.status === 'spent') return res.json({ status: 'spent', message: 'Funds were captured for a purchase; nothing to release', ...base })
  if (hold.status === 'released') return res.json({ status: 'released', already: true, ...base })
  try {
    await stripe.paymentIntents.cancel(hold_id, { cancellation_reason: 'abandoned' })
    hold.status = 'released'
    res.json({ status: 'released', ...base })
  } catch (e) {
    res.status(400).json({ error: e.code, message: e.message })
  }
})

// What the dashboard renders, and what P1's find_order() asks.
app.get('/funds/by-instruction/:id', (req, res) => {
  const hold_id = holdsByInstruction.get(req.params.id)
  hold_id ? res.json({ hold_id, ...holds.get(hold_id) }) : res.status(404).json({ error: 'no hold for instruction' })
})
app.get('/funds/:hold_id', (req, res) => {
  const h = holds.get(req.params.hold_id)
  h ? res.json({ hold_id: req.params.hold_id, ...h }) : res.status(404).json({ error: 'no such hold' })
})
app.get('/purchases/:idempotency_key', (req, res) => {
  const k = req.params.idempotency_key
  purchases.has(k) ? res.json(purchases.get(k))
    : pending.has(k) ? res.status(202).json(pending.get(k))
    : res.status(404).json({ error: 'no purchase under this key' })
})

// GET /coverage — where we can actually buy. P1 filters against it; P3 ranks by it.
app.get('/coverage', (_, res) => res.json({ retailers: [...zinc.COVERAGE, ...SANDBOX_RETAILERS], sandbox_retailers: SANDBOX_RETAILERS, market: ['store-a', 'store-b', 'store-c'] }))

// Stripe's failure -> the four statuses in CONTRACTS.md.
// `decline_reason` is Stripe's own code, verbatim. It goes on screen unedited —
// the demo's whole argument is that this sentence wasn't written by us.
function mapFailure(e, ctx) {
  switch (e.code) {
    case 'amount_too_large':
      return { status: 'DECLINED', decline_reason: e.code, message: e.message, enforced_by: 'stripe', ...ctx }
    case 'authentication_required':
      return { status: 'NEEDS_ATTENTION', decline_reason: e.code, message: e.message, ...ctx }
    case 'card_declined':
      return { status: 'DECLINED', decline_reason: e.decline_code ?? e.code, message: e.message, ...ctx }
    case 'payment_intent_unexpected_state':
      return { status: 'FAILED', decline_reason: 'hold_unavailable', message: e.message, ...ctx }
    default:
      // Unknown failure after a capture attempt: verify with the merchant before
      // any retry. A double purchase is the one bug that turns a demo into an apology.
      return { status: 'FAILED', decline_reason: e.code ?? 'unknown', message: e.message, ...ctx }
  }
}

const PORT = Number(process.env.PORT ?? 4242)
app.get('/health', (_, res) => res.json({ ok: true, mode: 'test', market: MARKET_URL }))
app.listen(PORT, () => console.log(`P4 money on :${PORT} (test mode) — market ${MARKET_URL}`))
