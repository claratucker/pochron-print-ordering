// Partial approval is disabled while payment capture is one-shot (Stripe manual
// capture can only fire once). A subset approval must be refused so held items
// can never be released-then-stranded — i.e. so nothing can ship unpaid.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp } from './helpers/app.js';

let app;
beforeAll(async () => { app = await startApp(); });
afterAll(() => stopApp());

async function placeTwoItemOrder() {
  app.resetCookie();
  const f1 = await app.uploadImage('a.png', 3000, 2400);
  const f2 = await app.uploadImage('b.png', 3000, 2400);
  const items = [
    { fileId: f1.fileId, paper: 'pg-baryta', size: '8×10', border: 'none', qty: 1, colorPath: 'none' },
    { fileId: f2.fileId, paper: 'pg-baryta', size: '8×10', border: 'none', qty: 1, colorPath: 'none' },
  ];
  const res = await app.api('/api/orders', { method: 'POST', body: app.orderBody(f1.fileId, { items }) });
  const queue = await app.api('/api/studio/queue', { studio: true });
  return queue.json.queue.find((o) => o.ref === res.json.ref);
}

describe('partial approval is refused', () => {
  it('approving a subset of items returns PARTIAL_DISABLED and captures nothing', async () => {
    const order = await placeTwoItemOrder();
    expect(order.items.length).toBe(2);
    const oneId = order.items[0].id;

    const res = await app.api(`/api/studio/orders/${order.id}/approve`, {
      method: 'POST', studio: true, body: { itemIds: [oneId] },
    });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('PARTIAL_DISABLED');

    // The order must be untouched: still awaiting capture, nothing partially charged.
    const q = await app.api('/api/studio/queue', { studio: true });
    const after = q.json.queue.find((o) => o.id === order.id);
    expect(after.paymentStatus).not.toBe('partially_captured');
    expect(after.paymentStatus).not.toBe('captured');
  });

  it('approving the whole order still works (no itemIds)', async () => {
    const order = await placeTwoItemOrder();
    const res = await app.api(`/api/studio/orders/${order.id}/approve`, {
      method: 'POST', studio: true, body: {},
    });
    expect(res.status).toBe(200);
    expect(res.json.partial).toBeFalsy();
  });
});
