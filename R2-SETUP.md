# Moving originals to Cloudflare R2

Local disk is a stopgap: customer originals share a 30 GB volume with the
database, they aren't backed up, and multi-GB scans fill it fast. R2 fixes all
three. It's S3-compatible, so no code changes — only `.env`.

**Why R2 rather than S3:** zero egress fees. Julie re-downloads multi-GB
originals every time she prints. On S3 that egress is billed every time; on R2
it's free. Storage itself is comparable, with ~10 GB free.

**Whose account:** this holds Pochron's customer photographs and is the cost
that grows with real usage — it belongs on **Pochron Studios' Cloudflare
account**, not a personal or university one.

## 1. Enable R2

1. Create/sign in at <https://dash.cloudflare.com>.
2. Left sidebar → **R2 Object Storage** → **Overview**.
3. Enable R2. A payment method is required even for the free tier — nothing is
   charged below the free allowance, but the card must be on file before tokens
   can be created.

## 2. Create the bucket

**Create bucket** → name it `pochron-originals` (lowercase, digits, hyphens
only). Choose a location near the studio — **North America (ENAM)** for
Brooklyn. Standard storage class. Leave it **private**; the app issues
short-lived signed URLs rather than exposing objects publicly.

## 3. Create an API token

R2 Overview → **API Tokens** → **Manage** → **Create Account API token**.

- **Permission: Object Read & Write** — not Admin. The app only needs to read
  and write objects; it never needs to create or delete buckets.
- **Apply to specific buckets only** → select `pochron-originals`.
- Create, then copy the **Access Key ID** and **Secret Access Key**.
  The secret is shown **once**.

Also copy your **Account ID** from the R2 Overview page. Your endpoint is:

```
https://<ACCOUNT_ID>.r2.cloudflarestorage.com
```

## 4. Set the bucket CORS policy

**This step is not optional.** The browser uploads directly to R2, so without
CORS every upload fails with an opaque browser error.

Bucket → **Settings** → **CORS Policy** → **Add CORS policy**:

```json
[
  {
    "AllowedOrigins": ["https://order.pochronstudios.com"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

`ExposeHeaders: ["ETag"]` is what makes resumable multipart work — the browser
must read each part's ETag to finalize the upload. Omitting it breaks every
large file while small ones keep working, which is a confusing failure.

Add `http://localhost:4000` to `AllowedOrigins` if you test locally.

## 5. Configure the app

```bash
npm i @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
nano .env
```

```
STORAGE_DRIVER=s3
S3_BUCKET=pochron-originals
S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
AWS_REGION=auto
S3_FORCE_PATH_STYLE=true
S3_ACCESS_KEY_ID=<access key id>
S3_SECRET_ACCESS_KEY=<secret access key>
PRESIGN_TTL_SECONDS=3600
```

## 6. Verify before trusting it

```bash
npm run check:storage
```

Exercises write, read, ranged read, size, and the full multipart path against
the real bucket. All 8 must pass. Then:

```bash
pm2 restart pochron
curl -s localhost:4000/api/health     # adapters.storage should say "s3"
```

Then place a real test order through the site and confirm the studio queue can
open the original. That end-to-end check is what proves CORS is right — the
storage check runs server-side and can't see browser CORS.

## 7. Existing files

Originals already on disk in `data/uploads` are **not** migrated automatically.
If those orders still matter, copy them up with `rclone` before switching; if
they're only test orders, ignore it.

## Afterwards

- Set a **lifecycle rule** to abort incomplete multipart uploads after ~24h;
  abandoned parts still cost storage.
- Disk pressure on the instance disappears — only the (tiny) database remains,
  which is already backed up nightly.
- Customer originals are now on durable storage rather than one EBS volume,
  which is what makes "we always keep your original" true.
