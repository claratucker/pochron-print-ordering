// Large-file path: resumable multipart upload (init → sign parts → PUT chunks →
// resume/list → complete → header-only validation with deferred scan). Runs on
// the local driver with a small part size so it exercises the exact flow S3/R2
// use in production, without cloud creds. Run: node scripts/smoke-large.js
process.env.PORT = process.env.PORT || '4993';
process.env.UPLOAD_PART_SIZE = '1048576';       // 1 MB parts
process.env.INLINE_PROCESS_MAX_BYTES = '1';     // force the large-file path

import sharp from 'sharp';
import crypto from 'node:crypto';
await import('../src/server.js');
await new Promise((r) => setTimeout(r, 1200));

const BASE = `http://localhost:${process.env.PORT}`;
let COOKIE = '';
let pass = 0, fail = 0;
const assert = (n, c, x = '') => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n} ${x}`)); };
async function api(p, { method = 'GET', body } = {}) {
  const h = { 'Content-Type': 'application/json' }; if (COOKIE) h.Cookie = COOKIE;
  const r = await fetch(BASE + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) COOKIE = sc.split(';')[0];
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

async function main() {
  console.log('Resumable multipart upload (large scans)');
  const w = 1500, h = 1200, rawpx = Buffer.alloc(w * h * 3); crypto.randomFillSync(rawpx);
  const png = await sharp(rawpx, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
  console.log(`  test file: ${(png.length / 1048576).toFixed(2)} MB incompressible`);

  const init = await api('/api/uploads/init', { method: 'POST', body: { filename: 'bigscan.png', sizeBytes: png.length, mime: 'image/png' } });
  assert('init returns a multipart session', init.json.upload?.mode === 'multipart', JSON.stringify(init.json).slice(0, 140));
  const { fileId, upload } = init.json;
  const partSize = upload.partSize, nParts = Math.ceil(png.length / partSize);
  assert('server computed the part count', upload.partCount === nParts, `${upload.partCount} vs ${nParts}`);

  const done = [];
  async function putPart(i) {
    const sign = await api(`/api/uploads/${fileId}/part`, { method: 'POST', body: { partNumber: i } });
    const chunk = png.subarray((i - 1) * partSize, Math.min(i * partSize, png.length));
    const put = await fetch(BASE + sign.json.url, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', Cookie: COOKIE }, body: chunk });
    done.push({ PartNumber: i, ETag: (put.headers.get('etag') || '').replace(/"/g, '') });
  }

  // Upload part 1, then simulate an interruption + resume by listing parts.
  await putPart(1);
  const resume = await api(`/api/uploads/${fileId}/parts`);
  assert('resume lists the uploaded part', resume.json.parts.length === 1 && resume.json.parts[0].PartNumber === 1, JSON.stringify(resume.json.parts));
  for (let i = 2; i <= nParts; i++) await putPart(i);
  const all = await api(`/api/uploads/${fileId}/parts`);
  assert('all parts present before finalize', all.json.parts.length === nParts, `${all.json.parts.length}/${nParts}`);

  const comp = await api(`/api/uploads/${fileId}/complete-multipart`, { method: 'POST', body: { parts: done } });
  assert('complete-multipart assembles the object', comp.status === 200 && comp.json.ok, JSON.stringify(comp.json));

  const val = await api(`/api/uploads/${fileId}/complete`, { method: 'POST' });
  assert('validation reads dimensions header-only', val.json.width === w && val.json.height === h, `${val.json.width}×${val.json.height}`);
  assert('large-file scan deferred to background', val.json.scanPending === true);
  assert('full assembled size reported', val.json.sizeBytes === png.length, `${val.json.sizeBytes} vs ${png.length}`);

  // Abort path on a fresh session.
  const init2 = await api('/api/uploads/init', { method: 'POST', body: { filename: 'cancel.png', sizeBytes: png.length, mime: 'image/png' } });
  const ab = await api(`/api/uploads/${init2.json.fileId}/multipart`, { method: 'DELETE' });
  assert('abort cancels an in-progress upload', ab.status === 200 && ab.json.aborted === true, JSON.stringify(ab.json));

  console.log(`\n──────── large-file: ${pass} passed, ${fail} failed ────────\n`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
