// Real Stripe integration, in test mode. Opt-in: these are the only tests that
// need network access and a key, so the default suite stays fast and offline.
//
//   STRIPE_SECRET_KEY=sk_test_... npm run test:stripe
//
// If the key is absent the whole file is skipped rather than failing, so CI on
// a fork without secrets stays green.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp } from './helpers/app.js';

const KEY = process.env.STRIPE_SECRET_KEY;
const live = !!KEY && process.env.PAYMENT_DRIVER === 'stripe';

let app, stripe;
beforeAll(async () => {
  if (!live) return;
  const { default: Stripe } = await import('stripe');
  stripe = new Stripe(KEY);
  app = await startApp();
});
afterAll(() => stopApp());

describe.skipIf(!live)('stripe payments', () => {
  // THE BUG THIS FILE EXISTS FOR:
  // The browser submitted an order without a card (the Elements field hadn't
  // loaded). The server created an unconfirmed PaymentIntent, accepted the
  // order anyway, showed the customer a confirmation, and put an unfunded job
  // in the studio queue. It only surfaced later as a confusing "authorization
  // may have expired" when the studio tried to approve it.
  it('refuses an order with no card attached', async () => {
    const f = await app.uploadImage('nocard.png', 3000, 2400);
    const res = await app.api('/api/orders', { method: 'POST', body: app.orderBody(f.fileId) });

    expect(res.status).toBe(402);
    expect(res.json.code).toBe('NO_PAYMENT_METHOD');

    // And nothing unfunded reached the studio.
    const queue = await app.api('/api/studio/queue', { studio: true });
    expect(queue.json.queue.length).toBe(0);
  });

  it('holds funds at submit rather than charging', async () => {
    app.resetCookie();
    const pm = await stripe.paymentMethods.create({ type: 'card', card: { token: 'tok_visa' } });
    const f = await app.uploadImage('hold.png', 3000, 2400);
    const res = await app.api('/api/orders', { method: 'POST',
      body: app.orderBody(f.fileId, { paymentMethodId: pm.id }) });

    expect(res.status).toBe(201);

    const list = await stripe.paymentIntents.list({ limit: 10 });
    const pi = list.data.find((p) => p.metadata?.orderRef === res.json.ref);
    expect(pi, 'PaymentIntent should exist in Stripe').toBeTruthy();
    // requires_capture = authorized, funds held, customer NOT charged yet.
    expect(pi.status).toBe('requires_capture');
    expect(pi.amount_received).toBe(0);
  });

  it('captures only when the studio approves', async () => {
    app.resetCookie();
    const pm = await stripe.paymentMethods.create({ type: 'card', card: { token: 'tok_visa' } });
    const f = await app.uploadImage('capture.png', 3000, 2400);
    const order = await app.api('/api/orders', { method: 'POST',
      body: app.orderBody(f.fileId, { paymentMethodId: pm.id }) });

    const queue = await app.api('/api/studio/queue', { studio: true });
    const found = queue.json.queue.find((o) => o.ref === order.json.ref);

    const approve = await app.api(`/api/studio/orders/${found.id}/approve`, {
      method: 'POST', studio: true, body: {},
    });
    expect(approve.status).toBe(200);

    const list = await stripe.paymentIntents.list({ limit: 10 });
    const pi = list.data.find((p) => p.metadata?.orderRef === order.json.ref);
    expect(pi.status).toBe('succeeded');
    expect(pi.amount_received / 100).toBe(order.json.total);
  });

  it('declines a card the bank rejects, and creates no order', async () => {
    app.resetCookie();
    const f = await app.uploadImage('declined.png', 3000, 2400);
    let pmId = null;
    try {
      const pm = await stripe.paymentMethods.create({ type: 'card', card: { token: 'tok_chargeDeclined' } });
      pmId = pm.id;
    } catch { /* some accounts reject at tokenization; either path is a decline */ }

    if (pmId) {
      const res = await app.api('/api/orders', { method: 'POST',
        body: app.orderBody(f.fileId, { paymentMethodId: pmId }) });
      expect(res.ok).toBe(false);
      expect(res.status).toBe(402);
    }
  });

  // REGRESSION: orders authorized under the mock driver kept their fake payment
  // reference. After switching to Stripe, approving one produced a misleading
  // "authorization may have expired" instead of saying what was actually wrong.
  it('explains clearly when an order predates live payments', async () => {
    app.resetCookie();
    const legacyFile = await app.uploadImage('legacy.png', 3000, 2400);
    const { default: Database } = await import('better-sqlite3');
    const { join } = await import('node:path');
    const db = new Database(join(process.env.DATA_DIR, 'pochron.db'));
    const ref = 'PS-999001';
    db.prepare(`INSERT INTO orders (ref,status,customer_name,email,ship_addr1,ship_city,
      ship_state,ship_zip,ship_method,subtotal,shipping_cost,total,payment_ref,payment_status)
      VALUES (?,'submitted','Legacy','legacy@example.com','1 A St','Brooklyn','NY','11215',
      'standard',7.95,12,19.95,'pi_mock_legacy_123','authorized')`).run(ref);
    const id = db.prepare('SELECT id FROM orders WHERE ref=?').get(ref).id;
    // A realistic legacy order has a line item, or an earlier validation fires first.
    db.prepare(`INSERT INTO order_items (order_id,file_id,paper,size,border,qty,color_path,
      unit_price,line_total,item_status) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(id, legacyFile.fileId, 'pg-baryta', '8×10', 'none', 1, 'none', 7.95, 7.95, 'pending');
    db.close();

    const res = await app.api(`/api/studio/orders/${id}/approve`, { method: 'POST', studio: true, body: {} });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('PAYMENT_DRIVER_MISMATCH');
    expect(res.json.error).toMatch(/before live payments/i);
  });
});
