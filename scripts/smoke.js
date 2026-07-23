// End-to-end smoke test with the mock/local adapters. Verifies pricing matches
// the mockup to the penny and the full order → proof → capture loop works.
// Run: node scripts/smoke.js   (starts the server in-process on PORT 4999)
process.env.PORT = process.env.PORT || '4999';
process.env.STUDIO_PASSWORD = 'studio-dev';

import sharp from 'sharp';
await import('../src/server.js');   // dynamic: runs AFTER the env vars above are set

const BASE = `http://localhost:${process.env.PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let COOKIE = '';
let pass = 0, fail = 0;

function assert(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}
async function api(path, { method = 'GET', body, studio = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (COOKIE) headers.Cookie = COOKIE;
  if (studio) headers['X-Studio-Password'] = 'studio-dev';
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie');
  if (sc) COOKIE = sc.split(';')[0];
  const json = await r.json().catch(() => ({}));
  return { status: r.status, json };
}

// Upload a generated PNG of given dimensions through init → PUT → complete.
async function uploadImage(name, w, h) {
  const png = await sharp({ create: { width: w, height: h, channels: 3, background: { r: 120, g: 90, b: 140 } } }).png().toBuffer();
  const init = await api('/api/uploads/init', { method: 'POST', body: { filename: name, sizeBytes: png.length, mime: 'image/png' } });
  const put = await fetch(BASE + init.json.upload.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png', Cookie: COOKIE }, body: png });
  if (!put.ok) throw new Error('local PUT failed');
  const done = await api(`/api/uploads/${init.json.fileId}/complete`, { method: 'POST' });
  return done.json;
}

async function main() {
  await sleep(400); // let the server bind

  console.log('\nHealth + catalog');
  const health = await api('/api/health');
  assert('health ok', health.json.ok === true);
  assert('catalog seeded', health.json.seeded === true, JSON.stringify(health.json));
  const cat = await api('/api/catalog');
  assert('pigment 8×10 = 7.95', cat.json.prices.pigment['8×10'] === 7.95);
  assert('cprint 11×14 = 9.95', cat.json.prices.cprint['11×14'] === 9.95);
  assert('cc add = 15', cat.json.ccAdd === 15);

  console.log('\nUpload + server-side metadata/DPI');
  const a = await uploadImage('landscape.png', 3000, 2400);   // sharp at 8×10
  const b = await uploadImage('portrait.png', 3600, 4500);    // sharp at 11×14
  assert('metadata w/h extracted', a.width === 3000 && a.height === 2400, JSON.stringify(a));
  assert('bestDpi computed', typeof a.bestDpi === 'number' && a.bestDpi > 0);

  console.log('\nServer-authoritative quote (must match mockup math)');
  const items = [
    { fileId: a.fileId, paper: 'pg-baryta', size: '8×10', border: 'none', qty: 1, colorPath: 'none' },
    { fileId: b.fileId, paper: 'cp-glossy', size: '11×14', border: 'border', qty: 2, colorPath: 'studio' },
  ];
  const q = await api('/api/price/quote', { method: 'POST', body: { items, shipMethod: 'standard' } });
  // 7.95 + (9.95*2 + 15) = 7.95 + 34.90 = 42.85 subtotal; ship 12; total 54.85
  assert('subtotal = 42.85', q.json.subtotal === 42.85, JSON.stringify(q.json));
  assert('line A total = 7.95', q.json.lines[0].lineTotal === 7.95);
  assert('line B total = 34.90 (cc once, not per copy)', q.json.lines[1].lineTotal === 34.9, JSON.stringify(q.json.lines[1]));
  assert('shipping = 12', q.json.shippingCost === 12);
  assert('grand total = 54.85', q.json.total === 54.85, JSON.stringify(q.json));
  assert('DPI flag ok (from real pixels)', q.json.lines[0].dpiFlag === 'ok', JSON.stringify(q.json.lines[0]));

  console.log('\nVolume tier at 10 prints (Save 10%)');
  const bulk = await api('/api/price/quote', { method: 'POST', body: { items: [{ fileId: a.fileId, paper: 'cp-matte', size: '8×10', qty: 10, colorPath: 'none' }], shipMethod: 'standard' } });
  // 4.95 * 10 = 49.50; 10% off = 44.55; + 12 ship = 56.55
  assert('10 prints → tier Save 10%', bulk.json.tier.label === 'Save 10%', JSON.stringify(bulk.json.tier));
  assert('discount applied 49.50→44.55', bulk.json.printsTotal === 44.55, JSON.stringify(bulk.json));

  console.log('\nPlace order (authorize) + confirmation');
  const place = await api('/api/orders', { method: 'POST', body: {
    items,
    contact: { name: 'M. Alvarez', email: 'm.alvarez@example.com' },
    shipping: { addr1: '20 Jay St', city: 'Brooklyn', state: 'NY', zip: '11201', method: 'standard' },
    whiteLabel: true,
    whiteLabelName: 'Alvarez Studio',
  }});
  assert('order created (201)', place.status === 201, JSON.stringify(place.json));
  assert('has PS- ref', /^PS-/.test(place.json.ref || ''), place.json.ref);
  assert('total authorized 54.85', place.json.total === 54.85);
  const ref = place.json.ref;

  console.log('\nLow-res gate (submit blocked without acknowledgment)');
  COOKIE = ''; // fresh guest so the too-small file is a separate order
  const tiny = await uploadImage('tiny.png', 300, 200);
  assert('tiny flagged too-small everywhere', tiny.tooSmallEverywhere === true, JSON.stringify(tiny));
  const tinyItems = [{ fileId: tiny.fileId, paper: 'cp-matte', size: '8×10', qty: 1, colorPath: 'none' }];
  const blocked = await api('/api/orders', { method: 'POST', body: {
    items: tinyItems, contact: { name: 'R. Okafor', email: 'r.okafor@example.com' },
    shipping: { addr1: '1 Main', city: 'Beacon', state: 'NY', zip: '12508', method: 'standard' },
  }});
  assert('blocked without ack (422)', blocked.status === 422 && blocked.json.code === 'NEEDS_LOWRES_ACK', JSON.stringify(blocked.json));
  const okAck = await api('/api/orders', { method: 'POST', body: {
    items: tinyItems, contact: { name: 'R. Okafor', email: 'r.okafor@example.com' },
    shipping: { addr1: '1 Main', city: 'Beacon', state: 'NY', zip: '12508', method: 'standard' },
    lowResAck: true,
  }});
  assert('allowed with ack (201)', okAck.status === 201, JSON.stringify(okAck.json));

  console.log('\nStudio proofing: queue → approve → capture');
  const queue = await api('/api/studio/queue', { studio: true });
  assert('studio auth works', queue.status === 200, JSON.stringify(queue.json));
  assert('queue has pending', queue.json.pending >= 2, JSON.stringify({ pending: queue.json.pending }));
  const target = queue.json.queue.find((o) => o.ref === ref);
  assert('order visible with white-label flag', target && target.whiteLabel === true);
  assert('studio path shows original (not self-edit)', target.items.some((i) => i.colorPath === 'studio'));
  const approve = await api(`/api/studio/orders/${target.id}/approve`, { method: 'POST', studio: true, body: {} });
  assert('approve captures payment', approve.status === 200 && approve.json.captured === 54.85, JSON.stringify(approve.json));
  assert('order moves to production', approve.json.status === 'in_production', approve.json.status);

  console.log('\nEmail typo protection (§8)');
  COOKIE = '';
  const emFile = await uploadImage('em.png', 2400, 3000);
  const emBody = (email, extra = {}) => ({
    items: [{ fileId: emFile.fileId, paper: 'pg-baryta', size: '8×10', border: 'none', qty: 1, colorPath: 'none' }],
    contact: { name: 'C T', email },
    shipping: { addr1: '1 A St', city: 'Brooklyn', state: 'NY', zip: '11201', method: 'standard' },
    ...extra,
  });
  const typo = await api('/api/orders', { method: 'POST', body: emBody('clarac.tucker@gmial.com') });
  assert('mistyped domain is caught before submit',
    typo.status === 422 && typo.json.code === 'EMAIL_TYPO_SUSPECTED' && typo.json.suggestion === 'clarac.tucker@gmail.com',
    JSON.stringify(typo.json));
  const confirmed = await api('/api/orders', { method: 'POST', body: emBody('clarac.tucker@gmial.com', { emailConfirmed: true }) });
  assert('customer can confirm and proceed anyway', confirmed.status === 201);
  COOKIE = '';
  const bizFile = await uploadImage('biz.png', 2400, 3000);
  const biz = await api('/api/orders', { method: 'POST', body: {
    items: [{ fileId: bizFile.fileId, paper: 'pg-baryta', size: '8×10', border: 'none', qty: 1, colorPath: 'none' }],
    contact: { name: 'Ana', email: 'ana@ana-ruiz-photography.com' },
    shipping: { addr1: '1 A St', city: 'Brooklyn', state: 'NY', zip: '11201', method: 'standard' },
  }});
  assert("a real business domain isn't false-flagged", biz.status === 201, JSON.stringify(biz.json).slice(0, 90));

  console.log('\nWhite-label packaging (§10)');
  const wlQueue = await api('/api/studio/queue', { studio: true });
  const wlOrder = wlQueue.json.queue.find((o) => o.ref === ref);
  assert('white-label order stores the sender business name', wlOrder?.whiteLabelName === 'Alvarez Studio', wlOrder?.whiteLabelName);
  assert('parcel ships under the customer name, not Pochron',
    wlOrder?.returnAddress?.startsWith('Alvarez Studio') && !wlOrder.returnAddress.includes('Pochron'),
    JSON.stringify(wlOrder?.returnAddress));

  console.log('\nStudio auth required');
  const noauth = await api('/api/studio/queue');
  assert('queue rejects without password (401)', noauth.status === 401);

  console.log('\nSelf-edit recipe → full-res print render (§6)');
  COOKIE = '';
  const se = await uploadImage('selfedit.png', 3000, 2400);
  const seRecipe = { crop: { left: 200, top: 150, width: 2400, height: 1800 }, brightness: 1.1, contrast: 1.15, warmth: 30 };
  const sePlace = await api('/api/orders', { method: 'POST', body: {
    items: [{ fileId: se.fileId, paper: 'cp-matte', size: '8×10', border: 'none', qty: 1, colorPath: 'self', adjust: seRecipe }],
    contact: { name: 'T. Self', email: 't.self@example.com' },
    shipping: { addr1: '1 Main St', city: 'Brooklyn', state: 'NY', zip: '11201', method: 'standard' },
  }});
  assert('self-edit order created', sePlace.status === 201, JSON.stringify(sePlace.json));
  const seQueue = await api('/api/studio/queue', { studio: true });
  const seOrder = seQueue.json.queue.find((o) => o.ref === sePlace.json.ref);
  assert('recipe stored with the item', seOrder?.items[0]?.adjust?.warmth === 30);
  const render = await api(`/api/studio/orders/${seOrder.id}/items/${seOrder.items[0].id}/render`, { method: 'POST', studio: true });
  assert('render produces a print file URL', !!render.json.printUrl, JSON.stringify(render.json));
  const printRes = await fetch(BASE + render.json.printUrl, { headers: { 'X-Studio-Password': 'studio-dev' } });
  const printMeta = await sharp(Buffer.from(await printRes.arrayBuffer())).metadata();
  assert('print file cropped from original to recipe (2400×1800 tiff)',
    printMeta.format === 'tiff' && printMeta.width === 2400 && printMeta.height === 1800,
    `${printMeta.format} ${printMeta.width}×${printMeta.height}`);
  const seApprove = await api(`/api/studio/orders/${seOrder.id}/approve`, { method: 'POST', studio: true, body: {} });
  assert('approval auto-renders the print file', Array.isArray(seApprove.json.printFiles) && seApprove.json.printFiles.length === 1);

  console.log(`\n──────── ${pass} passed, ${fail} failed ────────\n`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
