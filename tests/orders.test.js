// Order submission: the gates that protect the studio from unprintable or
// unreachable orders, and the promises made to the customer.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp } from './helpers/app.js';

let app;
beforeAll(async () => { app = await startApp(); });
afterAll(() => stopApp());

describe('order submission', () => {
  it('creates an order with a PS- reference', async () => {
    const f = await app.uploadImage('a.png', 3000, 2400);
    const res = await app.api('/api/orders', { method: 'POST', body: app.orderBody(f.fileId) });
    expect(res.status).toBe(201);
    expect(res.json.ref).toMatch(/^PS-\d{6}$/);
  });

  it('requires contact and shipping details', async () => {
    const f = await app.uploadImage('b.png', 3000, 2400);
    const res = await app.api('/api/orders', { method: 'POST', body: {
      items: [{ fileId: f.fileId, paper: 'pg-baryta', size: '8×10', border: 'none', qty: 1, colorPath: 'none' }],
      contact: { name: 'No Email' },   // missing email
      shipping: { city: 'Brooklyn' },  // missing address
    }});
    expect(res.status).toBe(400);
  });

  it('rejects a malformed email address', async () => {
    const f = await app.uploadImage('c.png', 3000, 2400);
    const res = await app.api('/api/orders', { method: 'POST',
      body: app.orderBody(f.fileId, { contact: { name: 'X', email: 'not-an-email' } }) });
    expect(res.status).toBe(400);
  });

  it('blocks a low-resolution order until the customer acknowledges it', async () => {
    app.resetCookie();
    const tiny = await app.uploadImage('tiny.png', 300, 200);
    const blocked = await app.api('/api/orders', { method: 'POST', body: app.orderBody(tiny.fileId) });
    expect(blocked.status).toBe(422);
    expect(blocked.json.code).toBe('NEEDS_LOWRES_ACK');

    const allowed = await app.api('/api/orders', { method: 'POST',
      body: app.orderBody(tiny.fileId, { lowResAck: true }) });
    expect(allowed.status).toBe(201);
  });

  it('requires a sender name for white-label packaging', async () => {
    app.resetCookie();
    const f = await app.uploadImage('wl.png', 3000, 2400);
    const missing = await app.api('/api/orders', { method: 'POST',
      body: app.orderBody(f.fileId, { whiteLabel: true }) });
    expect(missing.status).toBe(422);
    expect(missing.json.code).toBe('NEEDS_WHITE_LABEL_NAME');

    const ok = await app.api('/api/orders', { method: 'POST',
      body: app.orderBody(f.fileId, { whiteLabel: true, whiteLabelName: 'Ana Ruiz Photography' }) });
    expect(ok.status).toBe(201);
  });

  it('rejects an order referencing a file that does not exist', async () => {
    const res = await app.api('/api/orders', { method: 'POST',
      body: app.orderBody('00000000-0000-0000-0000-000000000000') });
    expect(res.ok).toBe(false);
  });

  it('lets the customer look up their order with their email', async () => {
    app.resetCookie();
    const f = await app.uploadImage('look.png', 3000, 2400);
    const order = await app.api('/api/orders', { method: 'POST', body: app.orderBody(f.fileId) });
    const ref = order.json.ref;

    const ok = await app.api(`/api/orders/${ref}?email=customer@example.com`);
    expect(ok.status).toBe(200);
    expect(ok.json.ref).toBe(ref);

    const wrong = await app.api(`/api/orders/${ref}?email=someone-else@example.com`);
    expect(wrong.status).toBe(403);
  });
});
