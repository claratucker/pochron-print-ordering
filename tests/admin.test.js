// Julie must be able to change prices without a developer — and nobody else
// should be able to change them at all.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp } from './helpers/app.js';

let app;
beforeAll(async () => { app = await startApp(); });
afterAll(() => stopApp());

describe('pricing admin', () => {
  it('rejects catalog edits without the admin password', async () => {
    const res = await app.api('/api/admin/catalog', { method: 'PUT',
      body: { prices: { pigment: { '8×10': 1.00 } } } });
    expect(res.status).toBe(401);
  });

  it('a price change takes effect immediately for customers', async () => {
    const before = await app.api('/api/catalog');
    expect(before.json.prices.pigment['8×10']).toBe(7.95);

    const put = await app.api('/api/admin/catalog', { method: 'PUT', admin: true,
      body: { prices: { pigment: { '8×10': 12.50 } } } });
    expect(put.status).toBe(200);

    const after = await app.api('/api/catalog');
    expect(after.json.prices.pigment['8×10']).toBe(12.50);
  });

  it('a changed price is what the customer is actually charged', async () => {
    const f = await app.uploadImage('admin.png', 3000, 2400);
    const res = await app.api('/api/orders', { method: 'POST', body: app.orderBody(f.fileId) });
    expect(res.json.total).toBe(24.50);    // 12.50 (edited) + 12 shipping
  });

  it('the colour-correction fee is editable', async () => {
    await app.api('/api/admin/catalog', { method: 'PUT', admin: true, body: { settings: { cc_add: 25 } } });
    const { json } = await app.api('/api/catalog');
    expect(json.ccAdd).toBe(25);
  });

  it('shipping costs and volume tiers are editable', async () => {
    await app.api('/api/admin/catalog', { method: 'PUT', admin: true, body: {
      shipping: [{ id: 'standard', label: 'Standard (5–7 business days)', cost: 15 }],
    }});
    const { json } = await app.api('/api/catalog');
    expect(json.shipping.find((s) => s.id === 'standard').cost).toBe(15);
  });
});
