// Authorization expiry (§9).
//
// The studio's promise — nothing charged until a human approves — has a cost:
// a card hold is temporary. Issuers release it after about a week. An order
// that waits longer than that cannot be captured, and the failure is silent
// unless it is surfaced deliberately.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp } from './helpers/app.js';
import { authWindow, authLabel } from '../src/lib/authwindow.js';

let app;
beforeAll(async () => { app = await startApp(); });
afterAll(() => stopApp());

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 19).replace('T', ' ');

describe('authorization window (unit)', () => {
  it('a fresh authorization is healthy', () => {
    const w = authWindow({ payment_ref: 'pi_1', payment_status: 'authorized', authorized_at: daysAgo(1) });
    expect(w.status).toBe('ok');
    expect(authLabel(w)).toBeNull();
  });

  it('warns BEFORE it lapses, not after', () => {
    const w = authWindow({ payment_ref: 'pi_1', payment_status: 'authorized', authorized_at: daysAgo(6) });
    expect(w.status).toBe('expiring');
    expect(authLabel(w)).toMatch(/expires in/i);
  });

  it('reports an expired hold', () => {
    const w = authWindow({ payment_ref: 'pi_1', payment_status: 'authorized', authorized_at: daysAgo(9) });
    expect(w.status).toBe('expired');
    expect(authLabel(w)).toMatch(/expired/i);
  });

  it('an already-captured order has no clock left to run', () => {
    const w = authWindow({ payment_ref: 'pi_1', payment_status: 'captured', authorized_at: daysAgo(30) });
    expect(w.status).toBe('settled');
  });
});

describe('expiry in the studio queue', () => {
  let order;
  beforeAll(async () => {
    const f = await app.uploadImage('auth.png', 3000, 2400);
    const res = await app.api('/api/orders', { method: 'POST', body: app.orderBody(f.fileId) });
    const q = await app.api('/api/studio/queue', { studio: true });
    order = q.json.queue.find((o) => o.ref === res.json.ref);
  });

  it('every queued order carries its authorization state', () => {
    expect(order.auth).toBeDefined();
    expect(['ok', 'expiring', 'expired', 'settled', 'none']).toContain(order.auth.status);
  });

  it('refuses to capture a lapsed hold, and says what to do instead', async () => {
    const { default: Database } = await import('better-sqlite3');
    const { join } = await import('node:path');
    const db = new Database(join(process.env.DATA_DIR, 'pochron.db'));
    db.prepare('UPDATE orders SET authorized_at=? WHERE id=?').run(daysAgo(9), order.id);
    db.close();

    const res = await app.api(`/api/studio/orders/${order.id}/approve`, { method: 'POST', studio: true, body: {} });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('AUTH_EXPIRED');
    // The message has to tell the studio the remedy, not just the problem.
    expect(res.json.error).toMatch(/re-authoriz/i);
  });

  it('re-authorizing opens a new hold and restarts the clock', async () => {
    const before = await app.api('/api/studio/queue', { studio: true });
    const stale = before.json.queue.find((o) => o.id === order.id);
    expect(stale.auth.status).toBe('expired');

    const res = await app.api(`/api/studio/orders/${order.id}/reauthorize`, { method: 'POST', studio: true, body: {} });
    expect(res.status).toBe(200);
    expect(res.json.status).toBe('reauth_pending');

    const after = await app.api('/api/studio/queue', { studio: true });
    const fresh = after.json.queue.find((o) => o.id === order.id);
    expect(fresh.auth.status).toBe('ok');          // clock restarted
    expect(fresh.auth.reauthCount).toBe(1);        // and the attempt is recorded
  });

  it('the customer can retrieve what they need to re-confirm', async () => {
    const ok = await app.api(`/api/orders/${order.ref}/reauth?email=customer@example.com`);
    expect(ok.status).toBe(200);
    expect(ok.json.total).toBeGreaterThan(0);

    // Same guard as every other customer lookup.
    const wrong = await app.api(`/api/orders/${order.ref}/reauth?email=someone@else.com`);
    expect(wrong.status).toBe(403);
  });

  it('completing re-authorization returns the order to the studio queue', async () => {
    const res = await app.api(`/api/orders/${order.ref}/reauth-complete`, {
      method: 'POST', body: { email: 'customer@example.com' },
    });
    expect(res.status).toBe(200);
    expect(res.json.authorized).toBe(true);

    const q = await app.api('/api/studio/queue', { studio: true });
    const back = q.json.queue.find((o) => o.id === order.id);
    expect(back.status).toBe('submitted');
    expect(back.auth.status).toBe('ok');
  });

  it('and then it can be captured normally', async () => {
    const res = await app.api(`/api/studio/orders/${order.id}/approve`, { method: 'POST', studio: true, body: {} });
    expect(res.status).toBe(200);
    expect(res.json.status).toBe('in_production');
  });

  it('an order already paid cannot be re-authorized', async () => {
    const res = await app.api(`/api/studio/orders/${order.id}/reauthorize`, { method: 'POST', studio: true, body: {} });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('ALREADY_CAPTURED');
  });
});
