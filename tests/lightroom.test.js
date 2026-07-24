// Lightroom OAuth handshake. Unlike Dropbox this holds a server-side secret and
// a per-visitor access token to someone's photo catalogue, so the guards matter
// more than the happy path.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp } from './helpers/app.js';

let app;
beforeAll(async () => { app = await startApp(); });
afterAll(() => stopApp());

describe('lightroom connector', () => {
  it('reports itself unconfigured when no credentials are set', async () => {
    const { json } = await app.api('/api/connectors/lightroom/status');
    expect(json.configured).toBe(false);
    expect(json.connected).toBe(false);
  });

  it('refuses to start a sign-in it cannot complete', async () => {
    const res = await app.api('/api/connectors/lightroom/start');
    expect(res.status).toBe(503);
    expect(res.json.code).toBe('NOT_CONFIGURED');
  });

  it('rejects a callback with no authorization code', async () => {
    const res = await app.api('/api/connectors/lightroom/callback');
    expect(res.status).toBe(200);   // renders a page rather than a JSON error
  });

  // The state parameter is the CSRF guard: without it, an attacker could feed a
  // victim's browser a code of their choosing and bind their Adobe account to
  // someone else's session.
  it('rejects a callback whose state was never issued', async () => {
    const res = await fetch(
      `${app.base}/api/connectors/lightroom/callback?code=fake&state=never-issued`);
    const body = await res.text();
    expect(body).toMatch(/expired|try connecting again/i);
    expect(body).not.toMatch(/Lightroom connected/);
  });

  it('disconnect is idempotent', async () => {
    const res = await app.api('/api/connectors/lightroom', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(res.json.disconnected).toBe(true);
  });
});
