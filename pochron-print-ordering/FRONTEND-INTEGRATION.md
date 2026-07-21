# Wiring the mockup to the backend

`photo-upload-mockupV2.html` is a static front end: it hardcodes the catalog,
computes prices in the browser, and fakes upload/submit. To make it live, four
things move from the browser to the API. Nothing about the *look* or the *step
flow* changes — only where the data comes from and where it goes.

Set an API base once:

```js
const API = 'https://order.pochronstudios.com/api'; // or http://localhost:4000/api in dev
const req = (path, opts = {}) => fetch(API + path, {
  credentials: 'include',                    // carries the guest-draft cookie
  headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  ...opts,
}).then(r => r.json().then(j => ({ ok: r.ok, status: r.status, j })));
```

## 1. Catalog — replace the hardcoded constants

Today `PAPERS`, `SIZES`, `PRICES`, `BORDERS`, `SHIP_METHODS`, `VOLUME`, `CC_ADD`,
`DPI_GOOD`, `DPI_MIN` are literals near the top of the `<script>`. Fetch them
instead so a price change in the admin page shows up without redeploying:

```js
const cat = (await req('/catalog')).j;
// cat.papers, cat.sizes, cat.prices, cat.borders, cat.shipping,
// cat.volume, cat.ccAdd, cat.dpi.good, cat.dpi.min, cat.limits ...
```

The client keeps its local pricing helpers for *instant display feedback* — but
they're now a convenience, not the truth.

## 2. Upload — small (single PUT) and large (resumable multipart)

`addPhoto()` currently just reads the file locally. Replace with init → transfer →
complete. `init` returns one of two modes depending on file size:

```js
async function uploadPhoto(file) {
  const init = await req('/uploads/init', {
    method: 'POST',
    body: JSON.stringify({ filename: file.name, sizeBytes: file.size, mime: file.type }),
  });
  if (!init.ok) return handleUploadError(init);          // MAX_FILES / TOO_LARGE / BAD_TYPE

  const u = init.j.upload;
  if (u.mode === 'single') {
    // small file: one PUT (local receiver in dev, presigned S3/R2 URL in prod)
    const url = u.driver === 'local' ? location.origin + u.uploadUrl : u.uploadUrl;
    await fetch(url, { method: 'PUT', credentials: u.driver==='local'?'include':'omit',
      headers: u.headers, body: file });
  } else {
    // large file (multi-GB scans): resumable multipart — see below.
    await uploadMultipart(file, init.j.fileId, u);
  }

  const done = await req(`/uploads/${init.j.fileId}/complete`, { method: 'POST' });
  // done.j = { fileId, width, height, bestDpi, tooSmallEverywhere, scanPending, metadataDeferred, url }
  return done.j;
}
```

For the multipart path, **don't hand-roll it** — use Uppy's `@uppy/aws-s3`
plugin, which handles chunking, retries, resume, and progress against these exact
endpoints. The full wiring (and why Cloudflare R2 is the right store for a scan
studio) is in `LARGE-FILES.md`. `TOO_LARGE` only fires above the hard cap
(`MAX_BYTES`, default 20 GB); the old WeTransfer/large-file-link fallback is now
just a last resort for files beyond that.

## 3. Pricing + DPI — quote from the server

Wherever the mockup calls `updateTotals()` / `grandTotal()`, also ask the server
for the authoritative quote (debounced). Use the returned per-line `dpiFlag`
(`ok` / `soft` / `too_small`) to drive the same warning badges — now computed
from real pixels, not the browser:

```js
const quote = (await req('/price/quote', {
  method: 'POST',
  body: JSON.stringify({ items: toItems(state.photos), shipMethod: state.shipMethod }),
})).j;
// quote.subtotal, quote.discountAmount, quote.tier.label,
// quote.shippingCost, quote.total, quote.lines[i].dpiFlag, quote.anyTooSmall
```

where each item is `{ fileId, paper, size, border, qty, colorPath }` and
`colorPath` is `'studio'` when the Hand Color Correction box is checked,
`'self'` when the customer used the editor, else `'none'`.

## 3b. Self-edit — swap the CSS stand-in for Filerobot

The mockup's self-edit panel is a CSS stand-in (its own comment says so). Replace
it with the real editor via the drop-in module `public/order/filerobot-adjust.js`
(load Filerobot from its CDN first). Open it on the uploaded original, locked to
the ordered print ratio:

```js
import { openAdjustEditor } from './filerobot-adjust.js';

openAdjustEditor({
  source: uploadedOriginalUrl,     // the file's URL from step 2's /complete
  ratio: 8 / 10,                   // lock crop to the ordered size
  sourceDims: { width, height },   // from /complete, for exact crop scaling
  onApply: (recipe) => {
    photo.colorPath = 'self';
    photo.adjust = recipe;         // goes straight into the order item's `adjust`
    rerender();
  },
});
```

`onApply` hands back the normalized recipe (`crop`, `rotate`, `straighten`,
`flip`, `brightness`, `contrast`, `saturation`, `warmth`). You don't upload the
edited pixels — the studio re-renders from the original at approval. A working
example is at `/order/edit-demo.html`.

## 4. Autosave + submit

Autosave on each meaningful change (the mockup already debounces UI updates):

```js
req('/draft', { method: 'PUT', body: JSON.stringify({
  items: toItems(state.photos), whiteLabel: state.whiteLabel, shipMethod: state.shipMethod,
}) });
```

`placeOrderBtn` posts the order. The server repeats the required-field and
email-format checks and adds the low-res gate, so keep the client checks for fast
feedback but treat the API response as final:

```js
const res = await req('/orders', { method: 'POST', body: JSON.stringify({
  items: toItems(state.photos),
  contact:  { name: coName, email: coEmail, phone: coPhone },
  shipping: { name: shipName, addr1: shipAddr1, addr2: shipAddr2, city: shipCity,
              state: shipState, zip: shipZip, country: shipCountry, method: state.shipMethod },
  whiteLabel: state.whiteLabel,
  lowResAck: state.dpiAck,          // the mockup's "print as-is" acknowledgment
  paymentMethodId,                  // from Stripe.js in production
}) });
if (res.status === 422 && res.j.code === 'NEEDS_LOWRES_ACK') showDpiGate();
else if (res.ok) showConfirm(res.j.ref, coEmail);   // res.j.ref is the PS-###### reference
```

In production the mockup's payment stand-in is replaced by **Stripe Elements**:
collect the card with Stripe.js, create a PaymentMethod, and pass its id as
`paymentMethodId`. The backend authorizes now and captures on studio approval.

## 5. Studio queue

The mockup's studio view currently reads an in-memory `queue` array. Point it at
the live queue (behind the studio password) and wire the two buttons:

```js
const H = { 'X-Studio-Password': STUDIO_PW };
const { queue } = (await req('/studio/queue', { headers: H })).j;

// "Approve & print" / "Correct & print"  → captures payment:
await req(`/studio/orders/${id}/approve`, { method: 'POST', headers: H, body: '{}' });

// "Hold / message"  → emails the customer and records the thread:
await req(`/studio/orders/${id}/hold`, { method: 'POST', headers: H,
  body: JSON.stringify({ message: 'Could you send a higher-resolution file?' }) });
```

Each queue item already carries the DPI flag, the white-label flag, the
color-correction path, and the original-file URL — everything the mockup's cards
render today.
