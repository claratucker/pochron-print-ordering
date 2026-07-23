// Test harness. Each test FILE gets its own server, on its own port, backed by
// its own throwaway database — so tests never see each other's orders and can
// run in any order. Vitest isolates files into separate workers, which is what
// makes this safe (ES module state is per-worker).
//
// Call startApp() once per file, inside beforeAll.

import { rmSync } from 'node:fs';


export async function startApp(env = {}) {
  // Environment is prepared in tests/setup.js (it must be set before any module
  // that reads it is imported). Only per-file overrides land here.
  for (const [k, v] of Object.entries(env)) process.env[k] = String(v);

  await import('../../src/db/seed.js');     // seeds the catalog (side effect)
  await import('../../src/server.js');      // binds the port (side effect)
  await new Promise((r) => setTimeout(r, 500));

  return makeClient(`http://127.0.0.1:${process.env.PORT}`);
}

export function stopApp() {
  const dir = process.env.DATA_DIR;
  if (dir && dir.includes('pochron-test-')) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}


function makeClient(base) {
  let cookie = '';   // the guest draft cookie, so uploads belong to one "browser"

  async function api(path, { method = 'GET', body, studio, admin, headers = {} } = {}) {
    const h = { 'Content-Type': 'application/json', ...headers };
    if (cookie) h.Cookie = cookie;
    if (studio) h['X-Studio-Password'] = studio === true ? 'test-studio-pw' : studio;
    if (admin) h['X-Studio-Password'] = admin === true ? 'test-admin-pw' : admin;
    const res = await fetch(base + path, {
      method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, ok: res.ok, json: json ?? {}, headers: res.headers };
  }

  // Upload a synthetic image of exact dimensions and run it through validation,
  // exactly as the browser does. Returns the completed file record.
  async function uploadImage(name, width, height) {
    const { default: sharp } = await import('sharp');
    const png = await sharp({
      create: { width, height, channels: 3, background: { r: 90, g: 110, b: 140 } },
    }).png().toBuffer();

    const init = await api('/api/uploads/init', {
      method: 'POST',
      body: { filename: name, sizeBytes: png.length, mime: 'image/png' },
    });
    if (!init.ok) return { error: init.json, status: init.status };

    const u = init.json.upload;
    if (u.mode === 'multipart') {
      const parts = [];
      for (let i = 1; i <= u.partCount; i++) {
        const sign = await api(`/api/uploads/${init.json.fileId}/part`, { method: 'POST', body: { partNumber: i } });
        const chunk = png.subarray((i - 1) * u.partSize, Math.min(i * u.partSize, png.length));
        const put = await fetch(base + sign.json.url, {
          method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', Cookie: cookie }, body: chunk,
        });
        parts.push({ PartNumber: i, ETag: (put.headers.get('etag') || '').replace(/"/g, '') });
      }
      await api(`/api/uploads/${init.json.fileId}/complete-multipart`, { method: 'POST', body: { parts } });
    } else {
      await fetch(base + u.uploadUrl, {
        method: 'PUT', headers: { 'Content-Type': 'image/png', Cookie: cookie }, body: png,
      });
    }
    const done = await api(`/api/uploads/${init.json.fileId}/complete`, { method: 'POST' });
    return { fileId: init.json.fileId, ...done.json, rawBytes: png.length };
  }

  // A valid order body, so each test only states what it's actually testing.
  function orderBody(fileId, overrides = {}) {
    return {
      items: [{ fileId, paper: 'pg-baryta', size: '8×10', border: 'none', qty: 1, colorPath: 'none' }],
      contact: { name: 'Test Customer', email: 'customer@example.com' },
      shipping: { addr1: '117 9th St', city: 'Brooklyn', state: 'NY', zip: '11215', country: 'US', method: 'standard' },
      ...overrides,
    };
  }

  function resetCookie() { cookie = ''; }   // simulate a different visitor

  return { base, api, uploadImage, orderBody, resetCookie };
}
