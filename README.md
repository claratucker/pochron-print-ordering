# Pochron Studios — Print Ordering Backend (Phase 1)

The backend that turns `photo-upload-mockupV2.html` into a working feature on the
Pochron Studios site. It implements the **Phase 1 "core ordering"** loop from
`backend-planning.md`: direct-to-cloud resumable upload with server-side
validation and metadata, server-authoritative pricing with volume discounts,
checkout capturing contact and shipping, order submission, the studio proofing
queue with approve/hold, Stripe authorize-and-capture, and transactional email.

Two commitments from the plan are enforced in code and don't drift: **nothing
prints without studio approval** (payment is only *authorized* at submit and
*captured* at approval), and the **customer's original file is always retained**
(every order item stores the original file reference plus, for self-edits, the
adjustment recipe).

The guiding principle throughout: **the browser is untrusted.** Every limit,
price, and DPI warning shown to the customer is recomputed server-side as the
real gate.

## Quick start

```bash
npm install
cp .env.example .env        # safe local defaults; edit for production
npm run seed                # loads the catalog (prices from the sheet)
npm start                   # http://localhost:4000
npm run smoke               # optional: end-to-end test on port 4999
```

Out of the box it runs with **mock adapters** — local-disk storage, a mock payment
processor, and emails printed to the server log — so the entire order → proof →
capture loop works with no cloud accounts. Swap in real providers via `.env`
(below) with no code changes.

Verify it's up: `curl localhost:4000/api/health` reports which adapters are live.

## The three pages

Once running, the app serves three browser surfaces:

- **`/order/mockupV4.html`** — the customer ordering app: upload, size/paper,
  self-edit, checkout. Wired to the API (live prices, real uploads, real orders).
- **`/order/edit-demo.html`** — a minimal standalone demo of just the self-edit step, using the
  [Filerobot Image Editor](https://github.com/scaleflex/filerobot-image-editor).
  The customer crops and adjusts their photo; the edit is captured as a small
  recipe and kept with their original.
- **`/studio`** — the studio proofing queue (password: `STUDIO_PASSWORD`). Review
  each order, approve & capture payment (whole or partial), hold & message the
  customer, and mark shipped. Low-res photos are flagged.
- **`/admin`** — the pricing page (password: `ADMIN_PASSWORD`). Edit prices,
  shipping, discount tiers, and fees with no developer.

## Self-edit → full-resolution print (Filerobot)

The editor runs on a downscaled proxy in the browser for responsiveness, so its
rendered output is *not* print-quality — and the plan requires printing from the
original. So instead of trusting the browser render, we capture the editor's
design state, normalize it into a small recipe (`crop`, `rotate`, `straighten`,
`flip`, `brightness`, `contrast`, `saturation`, `warmth`), and store it beside the
retained original. At approval, `src/lib/render.js` re-applies that recipe to the
full-resolution original with sharp and produces the print-ready TIFF. The
client-side mapping lives in `public/order/filerobot-adjust.js`; the render is
covered by the smoke test end-to-end.


## How it maps to the plan

| Plan section | Where it lives |
|---|---|
| §4 Upload subsystem (presign, resumable, validate, scan, metadata) | `routes/uploads.js`, `adapters/storage.js`, `lib/imagemeta.js`, `adapters/misc.js` |
| §5 Draft & autosave persistence | `routes/draft.js` (guest token cookie in `lib/auth.js`) |
| §6 Order & proofing workflow | `routes/orders.js`, `routes/studio.js`, `lib/orders.js`, `public/studio/` |
| §6 Self-edit: recipe + original → full-res print render | `public/order/filerobot-adjust.js`, `lib/render.js`, `routes/studio.js` |
| §7 Pricing engine (server-authoritative, editable catalog) | `lib/pricing.js`, `lib/catalog.js`, `routes/admin.js`, `public/admin/` |
| §8 Checkout (contact/shipping, required fields, email validity) | `routes/orders.js` |
| §9 Payments (auth at submit, capture on approval, partial capture) | `adapters/payment.js`, `routes/studio.js` |
| §10 White-label packaging (order-level flag through to fulfillment) | `orders` table + surfaced in the studio queue |
| §11 Notifications (lifecycle email from info@) | `adapters/email.js` |
| §13 Security & privacy (server-side limits, scan, access control, retention) | throughout; retention window in `.env` |

Pricing note: the catalog in `catalog-defaults.js` is copied **verbatim** from the
mockup, so the server and front end agree to the penny (the smoke test asserts
this). After the first `npm run seed`, prices live in the database and are edited
through the admin page — never in code again (plan §7).

## Configuration (`.env`)

Every value has a working default. The ones that matter for production:

- `STORAGE_DRIVER` — `local` (dev) or `s3` (direct-to-cloud multipart). For S3 also
  set `AWS_REGION`, `S3_BUCKET`, `S3_CDN_BASE`, credentials, and
  `npm i @aws-sdk/client-s3 @aws-sdk/s3-request-presigner`.
- `PAYMENT_DRIVER` — `mock` (dev) or `stripe`. For Stripe set `STRIPE_SECRET_KEY`.
- `EMAIL_DRIVER` — `console` (dev) or `smtp`. For SMTP/SES set `SMTP_*` and
  `npm i nodemailer`.
- `TAX_DRIVER` — `none` (mockup defers tax to the address) or `flat`; wire a real
  provider (TaxJar/Avalara/Stripe Tax) behind `adapters/misc.js` for production.
- `STUDIO_PASSWORD` / `ADMIN_PASSWORD` — gate the proofing queue and pricing admin.
  In production store a bcrypt hash and put these behind real auth/SSO.
- `APP_SECRET` — signs the guest-draft cookie. **Change it.**
- `MAX_FILES`, `MAX_BYTES`, `ACCEPTED_MIME` — the upload limits, re-enforced server-side.
- `DRAFT_TTL_DAYS` — abandoned-draft / upload retention window (§5/§14).

## API surface

Public (the order app):

- `GET  /api/catalog` — papers, sizes, prices, borders, shipping, volume tiers, CC fee, DPI thresholds, limits. The client renders from this instead of hardcoding.
- `POST /api/uploads/init` — enforces count/size/type; returns a single presigned PUT for small files or a **resumable multipart** session for large ones (multi-GB scans).
- `POST /api/uploads/:fileId/part` · `GET /api/uploads/:fileId/parts` · `POST /api/uploads/:fileId/complete-multipart` · `DELETE /api/uploads/:fileId/multipart` — sign a part, list parts (resume), finalize, or abort. Matches Uppy's S3 multipart contract (see `LARGE-FILES.md`).
- `POST /api/uploads/:fileId/complete` — validates: full scan + metadata for small files; header-only metadata + deferred scan for large ones.
- `POST /api/price/quote` — server-authoritative quote; per-photo DPI flags from real file metadata.
- `GET/PUT/DELETE /api/draft` — autosave/resume (guest cookie).
- `POST /api/orders` — validates required fields + email format, recomputes price, enforces the low-res acknowledgment, authorizes payment, emails confirmation.
- `GET  /api/orders/:ref?email=` — customer status lookup (guarded by the order email).

Studio (password-protected — the mockup's "Proofing queue"):

- `GET  /api/studio/queue` — pending + recent orders, each with items, DPI flags, white-label flag, and the original-file URL.
- `POST /api/studio/orders/:id/approve` — **captures payment** and moves to production. Body `{ itemIds }` approves some photos and captures a partial amount (§9).
- `POST /api/studio/orders/:id/hold` — emails the customer and records the message on the order thread.
- `POST /api/studio/orders/:id/ship` — marks shipped with tracking, notifies.
- `POST /api/studio/orders/:id/items/:itemId/render` — re-applies a self-edit recipe to the full-res original and returns the print-ready file URL (also runs automatically on approval).
- `POST /api/studio/orders/:id/reauthorize` — for proofs past the ~7-day auth window (stub seam).

Admin (password-protected pricing page at `/admin`):

- `GET/PUT /api/admin/catalog` — edit prices, sizes, shipping, volume tiers, and settings without a developer (§7).

## Squarespace integration

Per plan §2, this does **not** run inside Squarespace — Squarespace can't host
file uploads, a database, resumable transfer, an approval workflow, or
server-side Stripe. Ship this as a **separate app on a subdomain** and link to it
from the Squarespace nav:

1. Deploy this backend + the order front end (the mockup, wired to the API — see
   `FRONTEND-INTEGRATION.md`) to `order.pochronstudios.com` on any host
   (Vercel, Render, AWS, Fly, etc.). Point `CORS_ORIGINS` at that origin.
2. In Squarespace: **Pages → Navigation → add a link** labeled "Order Prints"
   pointing to `https://order.pochronstudios.com`. (Optionally open in a new tab.)
3. Style the order app to match the marketing site (logo, type, color, header/
   footer) so moving between them feels continuous — the mockup already mirrors
   the Squarespace look and links back to the main site and `/contactus`.

The full About/story/portfolio stays on Squarespace; the tool carries only a
short orientation line and links out.

## Production checklist

- Set real `STORAGE_DRIVER=s3`, `PAYMENT_DRIVER=stripe`, `EMAIL_DRIVER=smtp`, a tax provider, and strong `APP_SECRET` / passwords (hashed).
- Swap SQLite for Postgres for concurrency (schema is portable; `better-sqlite3` → `pg`). Every query is plain SQL in `db/` and the route files.
- Add the ClamAV (or cloud) scanner in `adapters/misc.js`; small files call `scan()` inline, large files call `scanKey()` out of band. The pipeline already rejects on `infected`.
- Large files are handled: `POST /api/uploads/init` returns a **resumable multipart** session for anything above `UPLOAD_PART_SIZE`, the browser uploads chunks straight to S3/R2 with resume, and validation reads header-only. For a scan studio, use **Cloudflare R2** (zero egress). Full architecture + Uppy client wiring in `LARGE-FILES.md`.
- Add an email-verification API call at checkout (Kickbox/ZeroBounce) as layer 3 of §8 — the confirmation email is already layer 4.
- Decide the neutral return address for white-label shipments (§10) and real carrier rates/tracking (§10).

## Open decisions still owned by the studio (plan §14)

The $15 color-correction fee, whether the volume discount is strictly per-order,
the real large-file-transfer destination, the neutral white-label return address,
carriers and the tax source, and the draft-retention window. The code encodes the
current answers and isolates each so they're one config or catalog edit away.

## Deploying & publishing

See `DEPLOY.md` for the GitHub push, a free-tier live-demo deploy (runs on the
mock adapters, no cloud accounts needed), and the Squarespace nav-link step. See
`FRONTEND-INTEGRATION.md` for wiring the order front end to the API.

## Credits

Built by Clara Tucker for Pochron Studios, with their permission, as a custom
print-ordering system. Pochron Studios brand and product details are used with
permission. Code is MIT-licensed (see `LICENSE`).

