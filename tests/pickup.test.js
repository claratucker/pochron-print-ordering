// Studio pickup. What matters to a customer: pickup costs nothing and needs no
// address, and there is no other delivery shortcut to stumble into. What matters
// to Julie: the queue says pickup plainly, and shown == captured.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp } from './helpers/app.js';
import { shippingForZone } from '../src/lib/pricing.js';

const cat = {
  shipping: [], shipZones: [{ key: 'ne', label: 'Northeast', standard: 15, expedited: 26 }],
  freeShipOver: 0,
};

describe('shippingForZone: pickup', () => {
  it('prices pickup at zero, with or without an address', () => {
    expect(shippingForZone(cat, {}, 'pickup', 50)).toMatchObject({ cost: 0, pickup: true });
  });
  it('has no local-delivery rate: an unknown method never prices below shipping', () => {
    const r = shippingForZone(cat, { state: 'NY', zip: '12581', country: 'US' }, 'local', 50);
    expect(r.cost).toBe(15);   // treated as standard shipping, not a cheap local rate
  });
});

let app;
beforeAll(async () => { app = await startApp(); });
afterAll(() => stopApp());

const queueEntry = async (ref) => (await app.api('/api/studio/queue', { studio: true })).json.queue.find((o) => o.ref === ref);

describe('placing pickup orders', () => {
  it('pickup needs no address, charges no shipping, and records the studio as the location', async () => {
    const f = await app.uploadImage('p.png', 3000, 2400);
    const res = await app.api('/api/orders', { method: 'POST', body: app.orderBody(f.fileId, { shipping: { method: 'pickup' } }) });
    expect(res.status).toBe(201);
    const o = await queueEntry(res.json.ref);
    expect(o.shipMethod).toBe('pickup');
    expect(o.shippingCost).toBe(0);
    expect(o.shipTo).toMatch(/Picking up at the studio/);
    expect(o.shipAdjustable).toBe(false);
  });

  it('a non-pickup order still requires an address', async () => {
    const f = await app.uploadImage('q.png', 3000, 2400);
    const res = await app.api('/api/orders', { method: 'POST', body: app.orderBody(f.fileId, { shipping: { method: 'standard' } }) });
    expect(res.status).toBe(400);
  });

  it('approving a pickup order captures exactly the shown total', async () => {
    const f = await app.uploadImage('l.png', 3000, 2400);
    const res = await app.api('/api/orders', { method: 'POST', body: app.orderBody(f.fileId, { shipping: { method: 'pickup' } }) });
    expect(res.status).toBe(201);
    const o = await queueEntry(res.json.ref);
    const ap = await app.api(`/api/studio/orders/${o.id}/approve`, { method: 'POST', studio: true, body: {} });
    expect(ap.status).toBe(200);
    expect(ap.json.captured).toBe(o.total);
  });

  it('the catalog offers pickup as a free option and no local delivery', async () => {
    const c = (await app.api('/api/catalog')).json;
    const ids = c.shipping.map((s) => s.id);
    expect(ids).toContain('pickup');
    expect(ids).not.toContain('local');
    expect(c.shipping.find((s) => s.id === 'pickup').cost).toBe(0);
  });

  it('only international orders expose the shipping-reduction field to Julie', async () => {
    const f = await app.uploadImage('d.png', 3000, 2400);
    const dom = await app.api('/api/orders', { method: 'POST', body: app.orderBody(f.fileId) });
    expect((await queueEntry(dom.json.ref)).shipAdjustable).toBe(false);
    const g = await app.uploadImage('i.png', 3000, 2400);
    const intl = await app.api('/api/orders', { method: 'POST', body: app.orderBody(g.fileId, {
      shipping: { addr1: '1 Rue X', city: 'Paris', state: 'IDF', zip: '75001', country: 'France', method: 'standard' },
    }) });
    expect(intl.status).toBe(201);
    const io = await queueEntry(intl.json.ref);
    expect(io.shipAdjustable).toBe(true);
    expect(io.shippingCost).toBe(50);
  });
});
