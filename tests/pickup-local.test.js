// Studio pickup and Stanfordville local delivery. What matters to a customer:
// pickup costs nothing and needs no address, local delivery costs the flat fee
// only inside 12581, and nobody outside 12581 can buy the cheap rate. What
// matters to Julie: the queue says pickup/local plainly, and shown == captured.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp } from './helpers/app.js';
import { shippingForZone } from '../src/lib/pricing.js';

const cat = {
  shipping: [], shipZones: [{ key: 'ne', label: 'Northeast', standard: 15, expedited: 26 }],
  freeShipOver: 0, localDeliveryFee: 5, localZips: ['12581'],
};

describe('shippingForZone: pickup and local delivery', () => {
  it('prices pickup at zero, with or without an address', () => {
    expect(shippingForZone(cat, {}, 'pickup', 50)).toMatchObject({ cost: 0, pickup: true });
  });
  it('charges the flat local fee inside 12581 (ZIP+4 too)', () => {
    expect(shippingForZone(cat, { zip: '12581', country: 'US' }, 'local', 50).cost).toBe(5);
    expect(shippingForZone(cat, { zip: '12581-1234', country: 'US' }, 'local', 50).cost).toBe(5);
  });
  it('fails closed outside 12581: never a cheaper rate, never a silent fallback', () => {
    for (const a of [{ zip: '12580', country: 'US' }, { zip: '11215', country: 'US' }, { zip: '', country: 'US' }, { zip: '12581', country: 'Canada' }]) {
      expect(shippingForZone(cat, a, 'local', 50)).toMatchObject({ notLocal: true });
    }
  });
  it('makes local delivery free whenever standard shipping would be free', () => {
    const c = { ...cat, freeShipOver: 100 };
    expect(shippingForZone(c, { zip: '12581', country: 'US' }, 'local', 150).cost).toBe(0);
    expect(shippingForZone(c, { zip: '12581', country: 'US' }, 'local', 50).cost).toBe(5);
  });
});

let app;
beforeAll(async () => { app = await startApp(); });
afterAll(() => stopApp());

const queueEntry = async (ref) => (await app.api('/api/studio/queue', { studio: true })).json.queue.find((o) => o.ref === ref);

describe('placing pickup and local orders', () => {
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

  it('local delivery inside 12581 charges the fee, and approval captures exactly the shown total', async () => {
    const f = await app.uploadImage('l.png', 3000, 2400);
    const res = await app.api('/api/orders', { method: 'POST', body: app.orderBody(f.fileId, {
      shipping: { addr1: '1 Main St', city: 'Stanfordville', state: 'NY', zip: '12581', country: 'US', method: 'local' },
    }) });
    expect(res.status).toBe(201);
    const o = await queueEntry(res.json.ref);
    expect(o.shipMethod).toBe('local');
    expect(o.shippingCost).toBe(5);
    const ap = await app.api(`/api/studio/orders/${o.id}/approve`, { method: 'POST', studio: true, body: {} });
    expect(ap.status).toBe(200);
    expect(ap.json.captured).toBe(o.total);
  });

  it('refuses local delivery outside 12581 before authorizing anything', async () => {
    const f = await app.uploadImage('m.png', 3000, 2400);
    const res = await app.api('/api/orders', { method: 'POST', body: app.orderBody(f.fileId, {
      shipping: { addr1: '117 9th St', city: 'Brooklyn', state: 'NY', zip: '11215', country: 'US', method: 'local' },
    }) });
    expect(res.status).toBe(422);
    expect(res.json.code).toBe('LOCAL_ONLY');
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
