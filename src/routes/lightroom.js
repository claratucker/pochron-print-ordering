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
