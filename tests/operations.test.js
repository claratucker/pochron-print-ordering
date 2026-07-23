// Operational safety: tax status recording, disk headroom, and backups.
// These protect the business rather than the customer experience — an
// uncollected tax liability or a lost database is worse than a broken button.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp } from './helpers/app.js';

let app;
beforeAll(async () => { app = await startApp(); });
afterAll(() => stopApp());

describe('tax', () => {
  it('records how tax was determined on every order', async () => {
    const f = await app.uploadImage('tax.png', 3000, 2400);
    const order = await app.api('/api/orders', { method: 'POST', body: app.orderBody(f.fileId) });
    expect(order.status).toBe(201);

    const queue = await app.api('/api/studio/queue', { studio: true });
    const found = queue.json.queue.find((o) => o.ref === order.json.ref);
    // In tests TAX_DRIVER is unset, so 'none' — the point is that the status is
    // recorded at all, so a provider failure can never look like "no tax owed".
    expect(found.taxStatus).toBeDefined();
    expect(['none', 'ok', 'estimated', 'failed']).toContain(found.taxStatus);
  });

  it('flags orders whose tax calculation failed so they can be reconciled', async () => {
    const queue = await app.api('/api/studio/queue', { studio: true });
    for (const o of queue.json.queue) {
      expect(o.taxNeedsReview).toBe(o.taxStatus === 'failed');
    }
  });

  it('quotes report their tax status to the customer-facing page', async () => {
    const f = await app.uploadImage('taxq.png', 3000, 2400);
    const q = await app.api('/api/price/quote', { method: 'POST', body: {
      items: [{ fileId: f.fileId, paper: 'pg-baryta', size: '8×10', border: 'none', qty: 1, colorPath: 'none' }],
      shipMethod: 'standard',
    }});
    expect(q.json.taxStatus).toBeDefined();
    expect(q.json.total).toBeGreaterThan(0);
  });
});

describe('disk headroom', () => {
  it('health reports disk usage so it can be monitored', async () => {
    const { json } = await app.api('/api/health');
    expect(json.disk).toBeDefined();
    if (json.disk.available) {
      expect(json.disk.freeBytes).toBeGreaterThan(0);
      expect(json.disk.usedPct).toBeGreaterThanOrEqual(0);
    }
  });

  it('uploads still work while there is headroom', async () => {
    const f = await app.uploadImage('room.png', 1200, 900);
    expect(f.fileId).toBeTruthy();
  });
});
