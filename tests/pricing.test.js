// Pricing must match the published sheet to the penny, and must be computed
// server-side — a client that lies about the price gets ignored.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp } from './helpers/app.js';

let app;
beforeAll(async () => { app = await startApp(); });
afterAll(() => stopApp());

describe('catalog', () => {
  it('serves the full catalog', async () => {
    const { json } = await app.api('/api/catalog');
    expect(json.papers.length).toBe(4);
    expect(json.sizes.length).toBe(20);
    expect(json.ccAdd).toBe(15);
    expect(json.limits.maxFiles).toBe(12);
  });

  it('matches the sheet prices exactly', async () => {
    const { json } = await app.api('/api/catalog');
    expect(json.prices.pigment['8×10']).toBe(7.95);
    expect(json.prices.cprint['11×14']).toBe(9.95);
    expect(json.prices.pigment['30×40']).toBe(159.95);
  });
});

describe('quotes', () => {
  let file;
  beforeAll(async () => { file = await app.uploadImage('price.png', 3000, 2400); });

  it('prices a single print with shipping', async () => {
    const { json } = await app.api('/api/price/quote', { method: 'POST', body: {
      items: [{ fileId: file.fileId, paper: 'pg-baryta', size: '8×10', border: 'none', qty: 1, colorPath: 'none' }],
      shipMethod: 'standard',
    }});
    expect(json.subtotal).toBe(7.95);
    expect(json.shippingCost).toBe(12);
    expect(json.total).toBe(19.95);
  });

  it('charges hand colour correction once per image, not per copy', async () => {
    const { json } = await app.api('/api/price/quote', { method: 'POST', body: {
      items: [{ fileId: file.fileId, paper: 'cp-glossy', size: '11×14', border: 'none', qty: 2, colorPath: 'studio' }],
      shipMethod: 'standard',
    }});
    // 9.95 x 2 = 19.90, + 15 once = 34.90  (NOT 15 x 2)
    expect(json.subtotal).toBe(34.90);
  });

  it('applies the volume discount at 10 prints', async () => {
    const { json } = await app.api('/api/price/quote', { method: 'POST', body: {
      items: [{ fileId: file.fileId, paper: 'pg-baryta', size: '8×10', border: 'none', qty: 10, colorPath: 'none' }],
      shipMethod: 'standard',
    }});
    expect(json.subtotal).toBe(79.50);
    expect(json.discountRate).toBe(0.10);
    expect(json.total).toBe(+(79.50 * 0.9 + 12).toFixed(2));
  });

  it('routes 100+ prints to a manual quote rather than guessing a price', async () => {
    const { json } = await app.api('/api/price/quote', { method: 'POST', body: {
      items: [{ fileId: file.fileId, paper: 'pg-baryta', size: '8×10', border: 'none', qty: 100, colorPath: 'none' }],
      shipMethod: 'standard',
    }});
    expect(json.tier.rate).toBeNull();
  });

  it('ignores a client-supplied total', async () => {
    const res = await app.api('/api/orders', { method: 'POST',
      body: app.orderBody(file.fileId, { total: 0.01, subtotal: 0.01 }) });
    expect(res.status).toBe(201);
    expect(res.json.total).toBe(19.95);   // server price, not the client's
  });

  it('rejects an unknown paper or size', async () => {
    for (const bad of [{ paper: 'nope' }, { size: '99×99' }]) {
      const res = await app.api('/api/price/quote', { method: 'POST', body: {
        items: [{ fileId: file.fileId, paper: 'pg-baryta', size: '8×10', border: 'none', qty: 1, colorPath: 'none', ...bad }],
        shipMethod: 'standard',
      }});
      expect(res.ok).toBe(false);
    }
  });
});
