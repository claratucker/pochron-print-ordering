// The upload path is the highest-risk surface: it must enforce its own limits
// regardless of what the browser claims.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp } from './helpers/app.js';

let app;
beforeAll(async () => { app = await startApp(); });
afterAll(() => stopApp());

describe('upload validation', () => {
  it('extracts real pixel dimensions and computes best DPI', async () => {
    const f = await app.uploadImage('ok.png', 3000, 2400);
    expect(f.width).toBe(3000);
    expect(f.height).toBe(2400);
    expect(f.bestDpi).toBeGreaterThan(0);
    expect(f.tooSmallEverywhere).toBe(false);
  });

  it('flags an image too small to print at any size', async () => {
    app.resetCookie();
    const f = await app.uploadImage('tiny.png', 300, 200);
    expect(f.tooSmallEverywhere).toBe(true);
  });

  it('rejects an unsupported file type', async () => {
    const res = await app.api('/api/uploads/init', { method: 'POST',
      body: { filename: 'doc.pdf', sizeBytes: 1000, mime: 'application/pdf' } });
    expect(res.status).toBe(415);
    expect(res.json.code).toBe('BAD_TYPE');
  });

  it('rejects a file over the size cap', async () => {
    const res = await app.api('/api/uploads/init', { method: 'POST',
      body: { filename: 'huge.tif', sizeBytes: 999 * 1024 * 1024 * 1024, mime: 'image/tiff' } });
    expect(res.status).toBe(413);
    expect(res.json.code).toBe('TOO_LARGE');
  });

  it('enforces the per-order file limit', async () => {
    app.resetCookie();
    for (let i = 0; i < 12; i++) {
      const r = await app.api('/api/uploads/init', { method: 'POST',
        body: { filename: `f${i}.png`, sizeBytes: 1000, mime: 'image/png' } });
      expect(r.ok).toBe(true);
    }
    const over = await app.api('/api/uploads/init', { method: 'POST',
      body: { filename: 'thirteenth.png', sizeBytes: 1000, mime: 'image/png' } });
    expect(over.status).toBe(409);
    expect(over.json.code).toBe('MAX_FILES');
  });

  it("one visitor's files are not counted against another's limit", async () => {
    app.resetCookie();
    const fresh = await app.api('/api/uploads/init', { method: 'POST',
      body: { filename: 'new-visitor.png', sizeBytes: 1000, mime: 'image/png' } });
    expect(fresh.ok).toBe(true);
  });
});
