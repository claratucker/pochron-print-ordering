// Regression tests — one per bug that actually reached a running system.
// Each has a comment saying what broke and how it was found, because the point
// of this file is that these specific failures never happen twice.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp } from './helpers/app.js';

let app;
beforeAll(async () => { app = await startApp(); });
afterAll(() => stopApp());

describe('regressions', () => {
  // BUG: an empty "hold" message threw an unhandled Zod error, which killed the
  // Node process. pm2 restarted it, so the site looked fine while the studio's
  // action silently did nothing. Found via a restart counter of ↺1 in pm2.
  it('malformed studio input returns an error instead of crashing the server', async () => {
    const file = await app.uploadImage('hold.png', 2400, 3000);
    const order = await app.api('/api/orders', { method: 'POST', body: app.orderBody(file.fileId) });
    const queue = await app.api('/api/studio/queue', { studio: true });
    const found = queue.json.queue.find((o) => o.ref === order.json.ref);

    const empty = await app.api(`/api/studio/orders/${found.id}/hold`, {
      method: 'POST', studio: true, body: { message: '' },
    });
    expect(empty.status).toBe(400);

    // The decisive assertion: the server is still answering afterwards.
    const alive = await app.api('/api/studio/queue', { studio: true });
    expect(alive.status).toBe(200);
  });

  it('approve and ship also survive malformed bodies', async () => {
    const file = await app.uploadImage('mal.png', 2400, 3000);
    const order = await app.api('/api/orders', { method: 'POST', body: app.orderBody(file.fileId) });
    const queue = await app.api('/api/studio/queue', { studio: true });
    const id = queue.json.queue.find((o) => o.ref === order.json.ref).id;

    const badApprove = await app.api(`/api/studio/orders/${id}/approve`, {
      method: 'POST', studio: true, body: { itemIds: 'not-an-array' },
    });
    expect(badApprove.status).toBe(400);

    const badShip = await app.api(`/api/studio/orders/${id}/ship`, {
      method: 'POST', studio: true, body: { tracking: { nested: 'object' } },
    });
    expect(badShip.status).toBe(400);

    const alive = await app.api('/api/studio/queue', { studio: true });
    expect(alive.status).toBe(200);
  });

  // BUG: a password containing '#' was silently truncated at the '#', because
  // dotenv treats the rest of an unquoted value as a comment. The studio page
  // then rejected the real password. This asserts the auth path itself is
  // exact-match, so a mismatch is a config problem and not a code problem.
  it('studio auth is an exact match — no partial-password acceptance', async () => {
    const right = await app.api('/api/studio/queue', { studio: 'test-studio-pw' });
    expect(right.status).toBe(200);

    // Note: surrounding whitespace is stripped by the HTTP layer (RFC 7230)
    // before the app sees the header, so it isn't tested here. What matters is
    // that a prefix, a different case, or an empty value never authenticates.
    for (const wrong of ['test-studio', 'test-studio-p', 'TEST-STUDIO-PW', 'test-studio-pw-extra', '']) {
      const res = await app.api('/api/studio/queue', { studio: wrong });
      expect(res.status, `"${wrong}" must not authenticate`).toBe(401);
    }
  });

  // BUG: the studio queue SELECT didn't include a newly added column, so the
  // white-label business name came back undefined and the parcel label fell
  // back to a generic "Sender". Schema changes must reach the read path too.
  it('columns added to a table are actually selected by the queue', async () => {
    const file = await app.uploadImage('wl.png', 2400, 3000);
    const order = await app.api('/api/orders', {
      method: 'POST',
      body: app.orderBody(file.fileId, { whiteLabel: true, whiteLabelName: 'Ana Ruiz Photography' }),
    });
    const queue = await app.api('/api/studio/queue', { studio: true });
    const found = queue.json.queue.find((o) => o.ref === order.json.ref);

    expect(found.whiteLabelName).toBe('Ana Ruiz Photography');
    expect(found.returnAddress).toContain('Ana Ruiz Photography');
    expect(found.returnAddress).not.toContain('Pochron');
  });

  // BUG: adding a column to the INSERT without adding a matching placeholder
  // produced "23 values for 24 columns" at runtime. Placing an order exercises
  // the widest INSERT in the app, so this catches the whole class.
  it('the order INSERT matches its column list', async () => {
    const file = await app.uploadImage('ins.png', 2400, 3000);
    const res = await app.api('/api/orders', {
      method: 'POST',
      body: app.orderBody(file.fileId, { whiteLabel: true, whiteLabelName: 'Studio X', lowResAck: true }),
    });
    expect(res.status).toBe(201);
    expect(res.json.ref).toMatch(/^PS-/);
  });

  // BUG: mockupV4 was still a standalone mockup — orders went into an in-page
  // array and prices were hardcoded, so submitted orders never reached the
  // studio queue. The contract that matters: a submitted order IS queryable.
  it('a submitted order appears in the studio queue', async () => {
    const file = await app.uploadImage('queue.png', 2400, 3000);
    const order = await app.api('/api/orders', { method: 'POST', body: app.orderBody(file.fileId) });
    const queue = await app.api('/api/studio/queue', { studio: true });
    expect(queue.json.queue.some((o) => o.ref === order.json.ref)).toBe(true);
  });

  // BUG: metadata came back null for larger images because the file hadn't
  // finished flushing to disk before it was read back.
  it('image dimensions are read correctly at a range of sizes', async () => {
    for (const [w, h] of [[300, 200], [3000, 2400], [3600, 4500]]) {
      app.resetCookie();
      const f = await app.uploadImage(`dim-${w}.png`, w, h);
      expect(f.width, `${w}×${h} width`).toBe(w);
      expect(f.height, `${w}×${h} height`).toBe(h);
    }
  });
});
