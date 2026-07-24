// Adobe Lightroom connector — OAuth 2.0 authorization-code flow (§ Phase 2).
//
// Unlike Dropbox (a client-side picker needing no secret), Lightroom requires a
// full server-side OAuth handshake: the customer consents at Adobe, we exchange
// the returned code for an access token using the client secret, and we then
// call Lightroom on their behalf. That means holding a credential that can read
// someone's photo catalogue, so tokens are scoped to the guest's own draft
// session and expire on their own.
//
// ENTITLEMENT CAVEAT: Adobe documents these APIs as available to "entitled
// partner applications". The authorize endpoint accepts the scopes and redirects
// to sign-in regardless, and only reveals whether they are granted at token
// exchange. If the exchange returns invalid_scope, the integration has not been
// approved — that is an Adobe account question, not a bug here.

import { Router } from 'express';
import crypto from 'node:crypto';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { getOrSetDraftToken } from '../lib/auth.js';
import { storage } from '../adapters/storage.js';

export const lightroomRouter = Router();

const IMS = 'https://ims-na1.adobelogin.com/ims';
const SCOPES = ['openid', 'lr_partner_apis', 'lr_partner_rendition_apis', 'offline_access'];

function configured() {
  return !!(config.connectors.lightroom.clientId && config.connectors.lightroom.clientSecret);
}

// GET /api/connectors/lightroom/start — send the customer to Adobe to consent.
lightroomRouter.get('/start', (req, res) => {
  if (!configured()) {
    return res.status(503).json({ error: 'Lightroom is not configured on this server.', code: 'NOT_CONFIGURED' });
  }
  const token = getOrSetDraftToken(req, res);

  // CSRF: a random state, bound to this guest, checked on the way back.
  const state = crypto.randomBytes(24).toString('hex');
  db.prepare(
    `INSERT INTO connector_tokens (owner_token, provider, state, created_at)
     VALUES (?, 'lightroom', ?, datetime('now'))
     ON CONFLICT(owner_token, provider) DO UPDATE SET state=excluded.state, created_at=datetime('now')`
  ).run(token, state);

  const url = new URL(`${IMS}/authorize/v2`);
  url.searchParams.set('client_id', config.connectors.lightroom.clientId);
  url.searchParams.set('redirect_uri', config.connectors.lightroom.redirectUri);
  url.searchParams.set('scope', SCOPES.join(','));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  res.redirect(url.toString());
});

// GET /api/connectors/lightroom/callback — Adobe returns here with a code.
lightroomRouter.get('/callback', async (req, res) => {
  const { code, state, error, error_description: desc } = req.query;
  if (error) return finish(res, false, `Adobe returned: ${error}${desc ? ` — ${desc}` : ''}`);
  if (!code || !state) return finish(res, false, 'Adobe did not return an authorization code.');

  const row = db.prepare(
    `SELECT owner_token FROM connector_tokens WHERE provider='lightroom' AND state=?`
  ).get(String(state));
  if (!row) return finish(res, false, 'That sign-in link has expired. Please try connecting again.');

  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: config.connectors.lightroom.clientId,
      client_secret: config.connectors.lightroom.clientSecret,
      code: String(code),
      redirect_uri: config.connectors.lightroom.redirectUri,
    });
    const r = await fetch(`${IMS}/token/v3`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const j = await r.json();

    if (!r.ok) {
      // invalid_scope here is the entitlement answer: the app is not approved
      // for the Lightroom partner APIs.
      const detail = j.error === 'invalid_scope'
        ? 'This Adobe application is not entitled to the Lightroom APIs. Adobe grants these to approved partner applications.'
        : (j.error_description || j.error || 'Token exchange failed.');
      console.error('Lightroom token exchange failed:', JSON.stringify(j));
      return finish(res, false, detail);
    }

    db.prepare(
      `UPDATE connector_tokens
          SET access_token=?, refresh_token=?, expires_at=datetime('now', ?), state=NULL
        WHERE owner_token=? AND provider='lightroom'`
    ).run(
      j.access_token,
      j.refresh_token || null,
      `+${Math.max(60, Number(j.expires_in || 3600) - 60)} seconds`,
      row.owner_token
    );
    finish(res, true, 'Lightroom connected.');
  } catch (e) {
    console.error('Lightroom callback error:', e.message);
    finish(res, false, 'Could not complete the Adobe sign-in.');
  }
});

// GET /api/connectors/lightroom/status — is this guest connected?
lightroomRouter.get('/status', (req, res) => {
  const token = getOrSetDraftToken(req, res);
  const row = db.prepare(
    `SELECT access_token, expires_at FROM connector_tokens WHERE owner_token=? AND provider='lightroom'`
  ).get(token);
  const connected = !!(row && row.access_token &&
    Date.parse(String(row.expires_at).replace(' ', 'T') + 'Z') > Date.now());
  res.json({ configured: configured(), connected });
});

// DELETE /api/connectors/lightroom — disconnect and forget the token.
lightroomRouter.delete('/', (req, res) => {
  const token = getOrSetDraftToken(req, res);
  db.prepare(`DELETE FROM connector_tokens WHERE owner_token=? AND provider='lightroom'`).run(token);
  res.json({ disconnected: true });
});

// Small self-closing page, since this runs in a popup opened from the order flow.
function finish(res, ok, message) {
  res.set('Content-Type', 'text/html').send(`<!doctype html><meta charset="utf-8">
<title>${ok ? 'Connected' : 'Could not connect'}</title>
<body style="font:15px/1.6 system-ui,Segoe UI,Arial;padding:38px;color:#534270;text-align:center">
  <p style="font-size:17px">${ok ? '✓ ' : ''}${message.replace(/</g, '&lt;')}</p>
  <p style="color:#6B5D83;font-size:13px">You can close this window.</p>
  <script>
    try { window.opener && window.opener.postMessage(
      { source: 'lightroom', ok: ${ok ? 'true' : 'false'} }, '*'); } catch (e) {}
    setTimeout(() => { try { window.close(); } catch (e) {} }, ${ok ? 1200 : 6000});
  </script>
</body>`);
}

// ── Calling Lightroom on the customer's behalf ──────────────────────
//
// Two Adobe quirks are handled here:
//  1. Every JSON response is prefixed with `while (1) {}` as anti-hijacking
//     padding, so it must be stripped before parsing.
//  2. Requests need BOTH the bearer token and the client id as X-API-Key.
const LR = 'https://lr.adobe.io/v2';

async function tokenFor(ownerToken) {
  const row = db.prepare(
    `SELECT access_token, refresh_token, expires_at FROM connector_tokens
      WHERE owner_token=? AND provider='lightroom'`
  ).get(ownerToken);
  if (!row || !row.access_token) return null;

  const expired = Date.parse(String(row.expires_at).replace(' ', 'T') + 'Z') <= Date.now();
  if (!expired) return row.access_token;
  if (!row.refresh_token) return null;

  // Access tokens are short-lived; refresh rather than making the customer
  // sign in again mid-order.
  try {
    const r = await fetch(`${IMS}/token/v3`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: config.connectors.lightroom.clientId,
        client_secret: config.connectors.lightroom.clientSecret,
        refresh_token: row.refresh_token,
      }),
    });
    const j = await r.json();
    if (!r.ok || !j.access_token) return null;
    db.prepare(
      `UPDATE connector_tokens SET access_token=?, expires_at=datetime('now', ?)
        WHERE owner_token=? AND provider='lightroom'`
    ).run(j.access_token, `+${Math.max(60, Number(j.expires_in || 3600) - 60)} seconds`, ownerToken);
    return j.access_token;
  } catch { return null; }
}

async function lrFetch(accessToken, path, { raw = false } = {}) {
  const res = await fetch(`${LR}${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'X-API-Key': config.connectors.lightroom.clientId,
    },
  });
  if (!res.ok) {
    const err = new Error(`Lightroom returned ${res.status}`);
    err.status = res.status;
    throw err;
  }
  if (raw) return res;
  const text = await res.text();
  // Strip Adobe's anti-JSON-hijacking prefix before parsing.
  return JSON.parse(text.replace(/^while\s*\(1\)\s*\{\}\s*/, ''));
}

function requireToken() {
  return async (req, res, next) => {
    const owner = getOrSetDraftToken(req, res);
    const token = await tokenFor(owner);
    if (!token) return res.status(401).json({ error: 'Please connect Lightroom first.', code: 'NOT_CONNECTED' });
    req.lrToken = token;
    req.ownerToken = owner;
    next();
  };
}

// GET /albums — the customer's catalogue and its albums.
lightroomRouter.get('/albums', requireToken(), async (req, res) => {
  try {
    const cat = await lrFetch(req.lrToken, '/catalog');
    const albums = await lrFetch(req.lrToken, `/catalogs/${cat.id}/albums?subtype=collection`);
    res.json({
      catalogId: cat.id,
      albums: (albums.resources || []).map((a) => ({ id: a.id, name: a.payload?.name || 'Untitled' })),
    });
  } catch (e) {
    res.status(e.status === 401 ? 401 : 502).json({ error: 'Could not read your Lightroom catalogue.', detail: e.message });
  }
});

// GET /assets?catalogId=&albumId= — photos, newest first, with thumbnails.
lightroomRouter.get('/assets', requireToken(), async (req, res) => {
  const { catalogId, albumId } = req.query;
  if (!catalogId) return res.status(400).json({ error: 'catalogId is required.' });
  const path = albumId
    ? `/catalogs/${catalogId}/albums/${albumId}/assets?limit=60&embed=asset`
    : `/catalogs/${catalogId}/assets?limit=60`;
  try {
    const data = await lrFetch(req.lrToken, path);
    const assets = (data.resources || []).map((r) => {
      const a = r.asset || r;
      return {
        id: a.id,
        name: a.payload?.importSource?.fileName || 'photo',
        captured: a.payload?.captureDate || null,
        // Thumbnails are proxied so the browser never needs the access token.
        thumb: `/api/connectors/lightroom/thumb?catalogId=${encodeURIComponent(catalogId)}&assetId=${encodeURIComponent(a.id)}`,
      };
    });
    res.json({ assets });
  } catch (e) {
    res.status(502).json({ error: 'Could not list your photos.', detail: e.message });
  }
});

// GET /thumb — proxy a small rendition, so the token stays server-side.
lightroomRouter.get('/thumb', requireToken(), async (req, res) => {
  const { catalogId, assetId } = req.query;
  try {
    const r = await lrFetch(req.lrToken, `/catalogs/${catalogId}/assets/${assetId}/renditions/thumbnail2x`, { raw: true });
    res.set('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=600');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch { res.status(404).end(); }
});

// POST /import — pull the MASTER (the photographer's original file, not a
// rendition) into storage and validate it exactly like a direct upload.
lightroomRouter.post('/import', requireToken(), async (req, res) => {
  const { catalogId, assetId, filename } = req.body || {};
  if (!catalogId || !assetId) return res.status(400).json({ error: 'catalogId and assetId are required.' });

  const active = db.prepare(
    `SELECT COUNT(*) c FROM files WHERE owner_token = ? AND status != 'rejected'`
  ).get(req.ownerToken).c;
  if (active >= config.uploads.maxFiles) {
    return res.status(409).json({ error: `Up to ${config.uploads.maxFiles} files per order.`, code: 'MAX_FILES' });
  }

  try {
    // `master` is the original as uploaded. Renditions are derived and would
    // defeat the point of calling Lightroom an original-quality source.
    const r = await lrFetch(req.lrToken, `/catalogs/${catalogId}/assets/${assetId}/master`, { raw: true });
    const declared = Number(r.headers.get('content-length') || 0);
    if (declared && declared > config.uploads.importMaxBytes) {
      return res.status(413).json({
        error: `That file is ${(declared / 1073741824).toFixed(1)} GB. Please export it and upload directly so the transfer can resume if interrupted.`,
        code: 'IMPORT_TOO_LARGE',
      });
    }
    const buffer = Buffer.from(await r.arrayBuffer());
    if (buffer.length > config.uploads.importMaxBytes) {
      return res.status(413).json({ error: 'That file is too large to import.', code: 'IMPORT_TOO_LARGE' });
    }

    const name = String(filename || 'lightroom-photo.jpg').replace(/[^\w.\-]+/g, '_').slice(0, 200);
    const fileId = crypto.randomUUID();
    const key = `${fileId}/${name}`;
    await storage.writeDerived(key, buffer);

    db.prepare(
      `INSERT INTO files (id, owner_token, storage_key, original_name, mime, bytes, status, source, source_quality)
       VALUES (?,?,?,?,?,?, 'uploaded', 'lightroom', 'original')`
    ).run(fileId, req.ownerToken, key, name, r.headers.get('content-type') || null, buffer.length);

    res.json({ fileId, source: 'lightroom', sourceLabel: 'Adobe Lightroom', quality: 'original',
      sizeBytes: buffer.length, validate: `/api/uploads/${fileId}/complete` });
  } catch (e) {
    // Not every asset has a master synced (smart previews only, for instance).
    const msg = e.status === 404
      ? 'The original for that photo is not synced to Lightroom. Export it and upload directly.'
      : 'Could not fetch that photo from Lightroom.';
    res.status(e.status === 404 ? 409 : 502).json({ error: msg, detail: e.message });
  }
});
