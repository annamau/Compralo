// Compralo — P4 Money.
//
// Three endpoints from CONTRACTS.md § P4. The mandate hold:
//
//   commit   authorize max_total_cents          -> the ceiling now lives at Stripe
//   checkout capture  true_total_cents          -> pay the real price, release the rest
//   release  cancel                             -> user made whole
//
// The ceiling is NOT enforced here. Read checkout() before you change it.

import express from 'express'
import Stripe from 'stripe'

const KEY = process.env.STRIPE_SECRET_KEY
if (!KEY?.startsWith('sk_test_')) {
  console.error('Refusing to boot without a TEST key. Nobody runs live today.')
  process.exit(1)
}

const stripe = new Stripe(KEY)
const app = express()
app.use(express.json())

// Swap both for P1's `holds` and `purchases` tables the moment the schema is up.
// Until then this keeps three other lanes unblocked.
const holds = new Map()
const purchases = new Map()

// Stripe holds an uncaptured authorization ~7 days; some issuers release sooner.
// This is a real deadline, not decoration — P1's checker must release when it passes.
const HOLD_TTL_MS = 7 * 24 * 60 * 60 * 1000

// POST /funds/commit — ONE TAP. The user is present here, so this is where 3DS belongs.
app.post('/funds/commit', async (req, res) => {
  const { instruction_id, amount_cents, currency = 'eur', payment_method = 'pm_card_visa' } = req.body

  try {
    const pi = await stripe.paymentIntents.create({
      amount: amount_cents,          // the mandate ceiling, held by Stripe
      currency,
      capture_method: 'manual',
      payment_method,
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      metadata: { instruction_id },
    }, { idempotencyKey: `commit_${instruction_id}` })

    const expires = new Date(pi.created * 1000 + HOLD_TTL_MS).toISOString()
    holds.set(pi.id, { instruction_id, amount_cents, currency, expires, status: 'committed' })

    res.json({
      hold_id: pi.id,
      status: 'committed',
      expires,
      // P2 confirms with the Payment Element instead of a test PM when there's time.
      client_secret: pi.client_secret,
    })
  } catch (e) {
    res.status(402).json({ error: e.code, message: e.message })
  }
})

// POST /checkout — spend the committed funds.
app.post('/checkout', async (req, res) => {
  const { instruction_id, offer_id, hold_id, idempotency_key, total_cents } = req.body

  // Same key twice returns the first result. It never buys twice.
  if (purchases.has(idempotency_key)) return res.json(purchases.get(idempotency_key))

  try {
    // Do NOT compare total_cents to the hold amount before this call.
    //
    // Letting Stripe refuse an over-mandate capture is the strongest technical
    // claim in the demo: the ceiling is enforced outside our process. An `if`
    // here would be faster, and would throw away the entire point.
    const pi = await stripe.paymentIntents.capture(hold_id, {
      amount_to_capture: total_cents,
    }, { idempotencyKey: idempotency_key })

    const result = {
      status: 'PURCHASED',
      order_ref: pi.latest_charge,
      total_cents: pi.amount_received,
      released_cents: pi.amount - pi.amount_received, // the difference, straight back
    }
    purchases.set(idempotency_key, result)
    holds.get(hold_id) && (holds.get(hold_id).status = 'spent')
    res.json(result)
  } catch (e) {
    res.json(mapFailure(e, { instruction_id, offer_id }))
  }
})

// POST /funds/release — every terminal state lands here. No lingering hold, ever.
app.post('/funds/release', async (req, res) => {
  const { hold_id, reason } = req.body
  try {
    const pi = await stripe.paymentIntents.cancel(hold_id, { cancellation_reason: 'abandoned' })
    holds.get(hold_id) && (holds.get(hold_id).status = 'released')
    res.json({ status: 'released', amount_cents: pi.amount, reason })
  } catch (e) {
    res.status(400).json({ error: e.code, message: e.message })
  }
})

// GET /funds/:hold_id — what the dashboard renders.
app.get('/funds/:hold_id', (req, res) => {
  const h = holds.get(req.params.hold_id)
  h ? res.json({ hold_id: req.params.hold_id, ...h }) : res.status(404).json({ error: 'no such hold' })
})

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
    default:
      // Unknown failure after a capture attempt: verify with the merchant before
      // any retry. A double purchase is the one bug that turns a demo into an apology.
      return { status: 'FAILED', decline_reason: e.code ?? 'unknown', message: e.message, ...ctx }
  }
}

app.get('/health', (_, res) => res.json({ ok: true, mode: 'test' }))
app.listen(4242, () => console.log('P4 money on :4242 (test mode)'))
