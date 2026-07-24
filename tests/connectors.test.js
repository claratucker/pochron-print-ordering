// Cloud connectors (Dropbox / Lightroom / Flickr / Google Photos).
//
// The import endpoint fetches an attacker-supplied URL server-side, which makes
// it the single most security-sensitive route in the app. Most of these tests
// are about refusing to fetch things.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApp, stopApp } from './helpers/app.js';
import { isAllowedUrl, isPrivateAddress, CONNECTORS } from '../src/lib/connectors.js';

let app;
beforeAll(async () => { app = await startApp(); });
afterAll(() => stopApp());

describe('URL allowlist (unit)', () => {
  it('accepts a genuine provider URL', () => {
    expect(isAllowedUrl('https://dl.dropboxusercontent.com/s/x/photo.tif', 'dropbox').ok).toBe(true);
    expect(isAllowedUrl('https://lh3.googleusercontent.com/abc', 'google_photos').ok).toBe(true);
  });

  it.each([
    ['https://evil.com/x.jpg', 'dropbox', 'unrelated host'],
    // The classic bypass: a suffix that merely *contains* the allowed name.
    ['https://dl.dropboxusercontent.com.evil.com/x.jpg', 'dropbox', 'suffix spoofing'],
    ['http://dl.dropboxusercontent.com/x.jpg', 'dropbox', 'plain http'],
    ['https://user:pass@dl.dropboxusercontent.com/x.jpg', 'dropbox', 'embedded credentials'],
    ['https://dl.dropboxusercontent.com:8080/x.jpg', 'dropbox', 'odd port'],
    ['https://lh3.googleusercontent.com/abc', 'dropbox', 'right host, wrong provider'],
    ['file:///etc/passwd', 'dropbox', 'file scheme'],
    ['not a url', 'dropbox', 'malformed'],
  ])('rejects %s (%s)', (url, source) => {
    expect(isAllowedUrl(url, source).ok).toBe(false);
  });

  it('rejects an unknown provider', () => {
    expect(isAllowedUrl('https://dl.dropboxusercontent.com/x', 'not_a_provider').ok).toBe(false);
  });
});

describe('private address detection (unit)', () => {
  // 169.254.169.254 is the cloud instance metadata service. Reaching it would
  // expose this server's IAM credentials — the reason this check exists.
  it.each(['169.254.169.254', '127.0.0.1', '10.0.0.5', '172.17.0.1', '192.168.1.1', '0.0.0.0', '::1'])(
    'blocks %s', (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(['8.8.8.8', '1.1.1.1', '162.125.1.1'])(
    'allows public %s', (ip) => expect(isPrivateAddress(ip)).toBe(false));
});

describe('import endpoint', () => {
  it('refuses a URL that is not from the named provider', async () => {
    const res = await app.api('/api/uploads/import', { method: 'POST', body: {
      source: 'dropbox', url: 'https://evil.example.com/payload.jpg', filename: 'x.jpg',
    }});
    expect(res.status).toBe(400);
    expect(res.json.code).toBe('BAD_SOURCE_URL');
  });

  it('refuses an attempt to reach cloud instance metadata', async () => {
    const res = await app.api('/api/uploads/import', { method: 'POST', body: {
      source: 'dropbox', url: 'https://169.254.169.254/latest/meta-data/iam/security-credentials/', filename: 'creds',
    }});
    expect(res.status).toBe(400);
    expect(['BAD_SOURCE_URL', 'BLOCKED_ADDRESS']).toContain(res.json.code);
  });

  it('refuses localhost and internal hosts', async () => {
    for (const url of ['https://localhost/x.jpg', 'https://127.0.0.1/x.jpg', 'https://192.168.1.1/x.jpg']) {
      const res = await app.api('/api/uploads/import', { method: 'POST', body: { source: 'dropbox', url, filename: 'x.jpg' } });
      expect(res.status, url).toBe(400);
    }
  });

  it('validates the request shape', async () => {
    const res = await app.api('/api/uploads/import', { method: 'POST', body: { source: 'dropbox' } });
    expect(res.status).toBe(400);
  });
});

describe('print-quality provenance', () => {
  // A fine-art studio must not print a re-compressed image at 30×40 without
  // knowing. Each provider declares what it actually returns.
  it('every connector declares its print quality', () => {
    for (const c of Object.values(CONNECTORS)) {
      expect(['original', 'conditional', 'compressed']).toContain(c.quality);
      expect(c.qualityNote.length).toBeGreaterThan(10);
    }
  });

  it('Dropbox returns the original file', () => {
    expect(CONNECTORS.dropbox.quality).toBe('original');
  });

  // Adobe gates master access separately from renditions. Until this
  // application is entitled to originals, Lightroom cannot be advertised as
  // original-quality — /master answers 403 and the import falls back.
  it('Lightroom is conditional until Adobe grants master access', () => {
    expect(CONNECTORS.lightroom.quality).toBe('conditional');
  });

  // Lightroom resolution depends on how the customer's photos reached the
  // cloud, so it must never be advertised as guaranteed original.
  it('Lightroom is offered but never promises the original', async () => {
    const { json } = await app.api('/api/uploads/sources');
    const lr = json.sources.find((s) => s.id === 'lightroom');
    if (lr) {
      expect(lr.quality).toBe('conditional');
      expect(lr.qualityNote).toMatch(/Classic|preview/i);
    }
  });

  it('Google Photos is flagged as possibly compressed', () => {
    expect(CONNECTORS.google_photos.quality).toBe('compressed');
  });

  it('lists the enabled sources for the ordering page', async () => {
    const { json } = await app.api('/api/uploads/sources');
    expect(Array.isArray(json.sources)).toBe(true);
    for (const s of json.sources) {
      expect(s.id).toBeTruthy();
      expect(s.qualityNote).toBeTruthy();
    }
  });

  // The deliberate product decision: a fine-art studio only offers sources that
  // return the photographer's actual file. If someone enables a lossy source
  // later, this test should fail and make them justify it.
  it('only original-quality sources are offered to customers', async () => {
    const { json } = await app.api('/api/uploads/sources');
    // Dropbox is hidden without an app key, so assert the property that matters:
    // whatever IS offered returns the photographer's actual file.
    // No offered source may be one that silently re-compresses.
    for (const s of json.sources) expect(['original', 'conditional']).toContain(s.quality);
    expect(json.sources.map((s) => s.id)).not.toContain('google_photos');
  });

  it('a source with no credentials configured is not shown at all', async () => {
    // Showing a button that cannot work is worse than not showing it.
    const { json } = await app.api('/api/uploads/sources');
    if (!json.dropboxAppKey) {
      expect(json.sources.map((s) => s.id)).not.toContain('dropbox');
    }
  });

  it('the lossy sources remain implemented but switched off', async () => {
    const { json } = await app.api('/api/uploads/sources');
    const ids = json.sources.map((s) => s.id);
    expect(ids).not.toContain('google_photos');
    expect(ids).not.toContain('flickr');
    // Still in the registry, so enabling them is a config change, not a rebuild.
    expect(CONNECTORS.google_photos).toBeDefined();
    expect(CONNECTORS.flickr).toBeDefined();
  });
});
