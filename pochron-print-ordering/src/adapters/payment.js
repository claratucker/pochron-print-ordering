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
      capture_method: 'manual',            // authorize now, capture later
      confirm: !!paymentMethodId,
      payment_method: paymentMethodId,
      receipt_email: email,
      metadata: { orderRef },
    });
    return { paymentRef: pi.id, status: pi.status, clientSecret: pi.client_secret };
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
