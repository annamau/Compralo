// Compralo — P4 scenario suite. Every money path, asserted, against the real Stripe test
// account and the real Zinc sandbox. Run: npm test
//
// Two dialects are exercised on purpose: the CONTRACTS.md shape (instruction_id, cents, hold_id)
// and P1's execution engine shape (monitor_id, minor units, "EUR", source_url, key `monitor:{id}`,
// no hold_id). Same numbers; both must work or the wiring is a lie.

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import Stripe from 'stripe'

const PORT = 4343
const API = `http://localhost:${PORT}`
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
const Z = 'https://zinc.com/shop/products'
const run = Date.now().toString(36)
const id = s => `${s}_${run}`

let child
before(async () => {
  child = spawn(process.execPath, ['--env-file=.env', 'money.mjs'], { env: { ...process.env, PORT }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stderr.on('data', d => process.stderr.write(d))
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${API}/health`)).ok) return } catch {}
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error('money.mjs did not boot')
})
after(() => child?.kill())

const post = (p, b) => fetch(API + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(async r => ({ code: r.status, body: await r.json() }))
const get = p => fetch(API + p).then(async r => ({ code: r.status, body: await r.json() }))
const arm = (instruction_id, extra = {}) => post('/funds/commit', { instruction_id, amount_cents: 25000, currency: 'eur', ...extra }).then(r => r.body)
const buy = (instruction_id, hold_id, key, url, total_cents, extra = {}) =>
  post('/checkout', { instruction_id, offer_id: 'off', hold_id, idempotency_key: key, offer: { url, retailer: 'amazon', total_cents }, ...extra }).then(r => r.body)

// ───────────────────────────── boot ─────────────────────────────

test('health and coverage', async () => {
  assert.equal((await get('/health')).body.ok, true)
  const { body } = await get('/coverage')
  assert.ok(body.retailers.includes('amazon') && body.retailers.includes('amazon_de'))
})

// ───────────────────────────── commit ─────────────────────────────

test('commit: contract shape → committed hold with a real ~7-day expiry and a client_secret', async () => {
  const h = await arm(id('c1'))
  assert.equal(h.status, 'committed')
  assert.match(h.hold_id, /^pi_/)
  assert.match(h.client_secret, /_secret_/)
  assert.equal(h.committed_cents, 25000)
  const days = (new Date(h.expires) - Date.now()) / 86_400_000
  assert.ok(days > 6.9 && days <= 7.01, `expires in ${days.toFixed(2)} days`)
  const pi = await stripe.paymentIntents.retrieve(h.hold_id)
  assert.equal(pi.status, 'requires_capture')
  assert.equal(pi.amount_capturable, 25000)
})

test('commit: P1 dialect (monitor_id, maximum_minor, "EUR") → same hold', async () => {
  const { body: h } = await post('/funds/commit', { monitor_id: id('c2'), maximum_minor: 25000, currency: 'EUR' })
  assert.equal(h.status, 'committed')
  assert.equal(h.currency, 'eur')
  const { body: byInst } = await get(`/funds/by-instruction/${id('c2')}`)
  assert.equal(byInst.hold_id, h.hold_id)
})

test('commit: same instruction twice → same hold; re-arm with attempt=2 → a new hold', async () => {
  const a = await arm(id('c3'))
  const b = await arm(id('c3'))
  assert.equal(a.hold_id, b.hold_id, 'idempotent commit')
  const c = await arm(id('c3'), { attempt: 2 })
  assert.notEqual(c.hold_id, a.hold_id, 're-arm mints a fresh hold')
  await post('/funds/release', { hold_id: a.hold_id, reason: 'test' })
  await post('/funds/release', { hold_id: c.hold_id, reason: 'test' })
})

test('commit: 3DS card → needs_attention at ARM time, with client_secret for P2 to finish it', async () => {
  const h = await arm(id('c4'), { payment_method: 'pm_card_authenticationRequired' })
  assert.equal(h.status, 'needs_attention')
  assert.equal(h.reason, 'authentication_required')
  assert.match(h.client_secret, /_secret_/)
  const pi = await stripe.paymentIntents.retrieve(h.hold_id)
  assert.equal(pi.status, 'requires_action')
})

test('commit: rejects a body with no instruction or amount', async () => {
  assert.equal((await post('/funds/commit', { currency: 'eur' })).code, 400)
})

// ───────────────────────────── the €465 beat ─────────────────────────────

test('checkout €465 vs €250: DECLINED by Stripe, enforced_by stripe, Zinc never called, hold intact', async () => {
  const inst = id('d1'); const h = await arm(inst)
  const r = await buy(inst, h.hold_id, `purchase_${inst}`, `${Z}/test-success`, 46500)
  assert.equal(r.status, 'DECLINED')
  assert.equal(r.decline_reason, 'amount_too_large')
  assert.equal(r.enforced_by, 'stripe')
  assert.equal(r.zinc_order_id, undefined, 'the aggregator must never hear about an over-mandate offer')
  assert.equal((await get(`/funds/${h.hold_id}`)).body.status, 'committed', 'a decline leaves the hold for the next offer')
  const pi = await stripe.paymentIntents.retrieve(h.hold_id)
  assert.equal(pi.amount_received, 0)
})

// ───────────────────────────── the €248 beat ─────────────────────────────

test('checkout €248: PURCHASED — Stripe captures 24800 of 25000, Zinc places the order, €2 released', async () => {
  const inst = id('p1'); const h = await arm(inst)
  const r = await buy(inst, h.hold_id, `purchase_${inst}`, `${Z}/test-success`, 24800)
  assert.equal(r.status, 'PURCHASED')
  assert.match(r.order_ref, /^W\d+/, 'merchant order id from Zinc')
  assert.equal(r.total_cents, 24800)
  assert.equal(r.currency, 'eur')
  assert.equal(r.released_cents, 200)
  assert.equal(r.retailer, 'amazon')
  assert.ok(r.zinc_order_id)
  const pi = await stripe.paymentIntents.retrieve(h.hold_id)
  assert.equal(pi.status, 'succeeded'); assert.equal(pi.amount_received, 24800); assert.equal(pi.amount_capturable, 0)
  assert.equal((await get(`/funds/${h.hold_id}`)).body.status, 'spent')
})

test('checkout: DECLINED €465 then PURCHASED €248 under the SAME key (P1 reuses one key per monitor)', async () => {
  const inst = id('p2'); const h = await arm(inst); const key = `monitor:${inst}`
  const d = await buy(inst, h.hold_id, key, `${Z}/test-success`, 46500)
  assert.equal(d.status, 'DECLINED')
  const p = await buy(inst, h.hold_id, key, `${Z}/test-success`, 24800)
  assert.equal(p.status, 'PURCHASED', 'a declined attempt must not poison the key for the next offer')
})

test('double-fire: same key again → the same purchase, no second capture, no second order', async () => {
  const inst = id('p3'); const h = await arm(inst); const key = `purchase_${inst}`
  const a = await buy(inst, h.hold_id, key, `${Z}/test-success`, 24800)
  const b = await buy(inst, h.hold_id, key, `${Z}/test-success`, 24800)
  assert.deepEqual(a, b)
  const pi = await stripe.paymentIntents.retrieve(h.hold_id)
  assert.equal(pi.amount_received, 24800)
})

test("find_order: GET /purchases/:key returns the purchase; unknown key → 404 (P1's Unknown path)", async () => {
  const inst = id('p4'); const h = await arm(inst); const key = `monitor:${inst}`
  assert.equal((await get(`/purchases/${encodeURIComponent(key)}`)).code, 404)
  const r = await buy(inst, h.hold_id, key, `${Z}/test-success`, 24800)
  const found = await get(`/purchases/${encodeURIComponent(key)}`)
  assert.equal(found.code, 200); assert.equal(found.body.order_ref, r.order_ref)
})

test('checkout: P1 dialect — no hold_id, monitor_id, offer.total_minor + source_url, key monitor:{id}', async () => {
  const inst = id('p5'); await post('/funds/commit', { monitor_id: inst, maximum_minor: 25000, currency: 'EUR' })
  const { body: r } = await post('/checkout', {
    monitor_id: inst, idempotency_key: `monitor:${inst}`,
    offer: { retailer: 'amazon', total_minor: 24800, currency: 'EUR', source_url: 'https://www.amazon.de/dp/B0CL5KNB9M' },
  })
  assert.equal(r.status, 'PURCHASED')
  assert.equal(r.total_cents, 24800)
  assert.equal(r.listing_url, 'https://www.amazon.de/dp/B0CL5KNB9M')
  assert.equal(r.sandbox_url_substituted, true, 'sandbox swaps a real listing for its success slug and says so')
})

// ───────────────────────────── retailer-side failures ─────────────────────────────

test('checkout: sold out between check and buy → FAILED out_of_stock, capture refunded, hold released', async () => {
  const inst = id('f1'); const h = await arm(inst)
  const r = await buy(inst, h.hold_id, `purchase_${inst}`, `${Z}/test-out-of-stock`, 24800)
  assert.equal(r.status, 'FAILED'); assert.equal(r.decline_reason, 'out_of_stock'); assert.equal(r.refunded_cents, 24800)
  const refunds = await stripe.refunds.list({ payment_intent: h.hold_id })
  assert.equal(refunds.data[0]?.amount, 24800); assert.equal(refunds.data[0]?.status, 'succeeded')
  assert.equal((await get(`/funds/${h.hold_id}`)).body.status, 'released')
})

test("checkout: price jumped after commit → FAILED max_price_exceeded (Zinc's own ceiling), refunded", async () => {
  const inst = id('f2'); const h = await arm(inst)
  const r = await buy(inst, h.hold_id, `purchase_${inst}`, `${Z}/test-price-exceeded`, 24800)
  assert.equal(r.status, 'FAILED'); assert.equal(r.decline_reason, 'max_price_exceeded'); assert.equal(r.refunded_cents, 24800)
})

test('checkout after a FAILED: refuses until re-armed (the refunded hold cannot be captured twice)', async () => {
  const inst = id('f3'); const h = await arm(inst)
  await buy(inst, h.hold_id, `purchase_${inst}`, `${Z}/test-out-of-stock`, 24800)
  const again = await buy(inst, h.hold_id, `purchase_${inst}`, `${Z}/test-success`, 24800)
  assert.equal(again.status, 'FAILED'); assert.equal(again.decline_reason, 'hold_released')
  const h2 = await arm(inst, { attempt: 2 })
  const ok = await buy(inst, h2.hold_id, `purchase_${inst}`, `${Z}/test-success`, 24800)
  assert.equal(ok.status, 'PURCHASED', 're-arm then buy works')
})

test('checkout on a released hold → FAILED hold_released; on an unknown instruction → FAILED no_hold', async () => {
  const inst = id('f4'); const h = await arm(inst)
  await post('/funds/release', { hold_id: h.hold_id, reason: 'cancelled' })
  const r = await buy(inst, h.hold_id, `purchase_${inst}`, `${Z}/test-success`, 24800)
  assert.equal(r.status, 'FAILED'); assert.equal(r.decline_reason, 'hold_released')
  const n = await buy(id('nohold'), undefined, 'k', `${Z}/test-success`, 24800)
  assert.equal(n.status, 'FAILED'); assert.equal(n.decline_reason, 'no_hold')
})

// ───────────────────────────── release ─────────────────────────────

test('release: by hold_id → released and gone at Stripe; again → idempotent; by instruction_id → works', async () => {
  const inst = id('r1'); const h = await arm(inst)
  const a = (await post('/funds/release', { hold_id: h.hold_id, reason: 'deadline_expired' })).body
  assert.equal(a.status, 'released'); assert.equal(a.amount_cents, 25000)
  const pi = await stripe.paymentIntents.retrieve(h.hold_id)
  assert.equal(pi.status, 'canceled'); assert.equal(pi.amount_received, 0)
  const b = (await post('/funds/release', { hold_id: h.hold_id, reason: 'cancelled' })).body
  assert.equal(b.status, 'released'); assert.equal(b.already, true)
  const inst2 = id('r2'); await arm(inst2)
  const c = (await post('/funds/release', { monitor_id: inst2, reason: 'monitor_cancelled' })).body
  assert.equal(c.status, 'released')
})

test('release: a spent hold reports spent, never errors (terminal-state cleanup is safe to call blindly)', async () => {
  const inst = id('r3'); const h = await arm(inst)
  await buy(inst, h.hold_id, `purchase_${inst}`, `${Z}/test-success`, 24800)
  const r = (await post('/funds/release', { hold_id: h.hold_id, reason: 'cleanup' })).body
  assert.equal(r.status, 'spent')
})

test('release: unknown hold → 404', async () => {
  assert.equal((await post('/funds/release', { hold_id: 'pi_nope', reason: 'x' })).code, 404)
})
