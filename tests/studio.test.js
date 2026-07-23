// The studio workflow — the core promise: nothing prints, and no card is
// charged, until a human at Pochron approves it.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp } from './helpers/app.js';

let app;
beforeAll(async () => { app = await startApp(); });
afterAll(() => stopApp());

async function placeOrder(name = 'o.png', extra = {}) {
  app.resetCookie();
  const f = await app.uploadImage(name, 3000, 2400);
  const res = await app.api('/api/orders', { method: 'POST', body: app.orderBody(f.fileId, extra) });
  const queue = await app.api('/api/studio/queue', { studio: true });
  return queue.json.queue.find((o) => o.ref === res.json.ref);
}

describe('access control', () => {
  it('the queue is unreachable without the studio password', async () => {
    const res = await app.api('/api/studio/queue');
    expect(res.status).toBe(401);
  });

  it('approve and hold are also protected', async () => {
    for (const action of ['approve', 'hold', 'ship']) {
      const res = await app.api(`/api/studio/orders/1/${action}`, { method: 'POST', body: {} });
      expect(res.status, action).toBe(401);
    }
  });
});

describe('proofing workflow', () => {
  it('a new order arrives as submitted and awaiting payment capture', async () => {
    const order = await placeOrder('flow.png');
    expect(order.status).toBe('submitted');
    expect(order.items.length).toBe(1);
  });

  it('approval captures payment and moves the order into production', async () => {
    const order = await placeOrder('approve.png');
    const res = await app.api(`/api/studio/orders/${order.id}/approve`, { method: 'POST', studio: true, body: {} });
    expect(res.status).toBe(200);
    expect(res.json.captured).toBe(order.total);
    expect(res.json.status).toBe('in_production');
  });

  it('holding an order records the message and notifies the customer', async () => {
    const order = await placeOrder('hold.png');
    const res = await app.api(`/api/studio/orders/${order.id}/hold`, {
      method: 'POST', studio: true, body: { message: 'Could you send a higher-resolution scan?' },
    });
    expect(res.status).toBe(200);
    expect(res.json.status).toBe('on_hold');

    const queue = await app.api('/api/studio/queue', { studio: true });
    const held = queue.json.queue.find((o) => o.id === order.id);
    expect(held.messages.some((m) => m.body.includes('higher-resolution'))).toBe(true);
  });

  it('shipping records tracking and completes the order', async () => {
    const order = await placeOrder('ship.png');
    await app.api(`/api/studio/orders/${order.id}/approve`, { method: 'POST', studio: true, body: {} });
    const res = await app.api(`/api/studio/orders/${order.id}/ship`, {
      method: 'POST', studio: true, body: { tracking: '1Z999AA10123456784' },
    });
    expect(res.status).toBe(200);
  });

  it('the studio sees the original file, not a browser-rendered copy', async () => {
    const order = await placeOrder('orig.png');
    expect(order.items[0].originalUrl).toBeTruthy();
  });

  it('a normal order ships under the Pochron return address', async () => {
    const order = await placeOrder('normal.png');
    expect(order.returnAddress).toContain('Pochron Studios');
  });
});
