import { config } from '../config.js';

// Model: authorize at submit, capture on approval (§9). Authorizations expire
// (~7 days) so slow proofs may need re-auth; partial capture handles orders
// where only some photos are approved.

const toCents = (n) => Math.round(Number(n) * 100);

// ── MOCK driver (dev) ───────────────────────────────────────────────
const mockDriver = {
  name: 'mock',
  async authorize({ amount, currency = 'usd', email, orderRef }) {
    return {
      paymentRef: `pi_mock_${orderRef}_${Date.now()}`,
      status: 'authorized',
      amount: toCents(amount), currency, email,
    };
  },
  async status({ paymentRef }) {
    return { paymentRef, status: 'authorized' };
  },
  async clientSecret({ paymentRef }) { return `${paymentRef}_secret_mock`; },
  async capture({ paymentRef, amount }) {
    return { paymentRef, status: 'captured', capturedAmount: amount };
  },
  async void({ paymentRef }) {
    return { paymentRef, status: 'voided' };
  },
  async refund({ paymentRef, amount }) {
    return { paymentRef, status: 'refunded', amount };
  },
};

// ── STRIPE driver (production) ──────────────────────────────────────
// authorize = PaymentIntent with capture_method: 'manual'
// capture    = paymentIntents.capture (supports amount_to_capture for partials)
const stripeDriver = {
  name: 'stripe',
  async _stripe() {
    if (!config.payment.stripeSecret) throw new Error('STRIPE_SECRET_KEY is not set.');
    const { default: Stripe } = await import('stripe');
    return new Stripe(config.payment.stripeSecret);
  },
  async authorize({ amount, currency = 'usd', email, orderRef, paymentMethodId }) {
    const stripe = await this._stripe();
    const pi = await stripe.paymentIntents.create({
      amount: toCents(amount), currency,
      capture_method: 'manual',            // authorize now, capture later (§9)
      payment_method_types: ['card'],
      confirm: !!paymentMethodId,
      payment_method: paymentMethodId,
      receipt_email: email,
      metadata: { orderRef },
    });
    // 'requires_capture' is a successful authorization under manual capture.
    // 'requires_action' means the bank wants 3D Secure — the browser must
    // finish it, then we re-check before treating the order as authorized.
    const status = pi.status === 'requires_capture' ? 'authorized' : pi.status;
    return { paymentRef: pi.id, status, clientSecret: pi.client_secret };
  },
  // The secret the browser needs to confirm an existing intent (re-authorization).
  async clientSecret({ paymentRef }) {
    const stripe = await this._stripe();
    const pi = await stripe.paymentIntents.retrieve(paymentRef);
    return pi.client_secret;
  },
  // Re-read a PaymentIntent (used after the customer completes 3D Secure).
  async status({ paymentRef }) {
    const stripe = await this._stripe();
    const pi = await stripe.paymentIntents.retrieve(paymentRef);
    return { paymentRef: pi.id, status: pi.status === 'requires_capture' ? 'authorized' : pi.status };
  },
  async capture({ paymentRef, amount }) {
    const stripe = await this._stripe();
    const opts = amount != null ? { amount_to_capture: toCents(amount) } : {};
    const pi = await stripe.paymentIntents.capture(paymentRef, opts);
    return { paymentRef: pi.id, status: pi.status, capturedAmount: (pi.amount_received || 0) / 100 };
  },
  async void({ paymentRef }) {
    const stripe = await this._stripe();
    const pi = await stripe.paymentIntents.cancel(paymentRef);
    return { paymentRef: pi.id, status: pi.status };
  },
  async refund({ paymentRef, amount }) {
    const stripe = await this._stripe();
    const r = await stripe.refunds.create({
      payment_intent: paymentRef,
      ...(amount != null ? { amount: toCents(amount) } : {}),
    });
    return { paymentRef, status: r.status, amount: (r.amount || 0) / 100 };
  },
};

export const payment = config.payment.driver === 'stripe' ? stripeDriver : mockDriver;
