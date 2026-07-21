# Handling multi-GB scans

Pochron is a high-end scan studio, so multi-GB originals (large-format drum
scans, layered PSDs, 16-bit TIFFs) are the normal case. This document is how the
backend handles them properly — no WeTransfer detour, no proxying gigabytes
through the app server.

## The three rules

1. **The browser uploads straight to object storage, never through the app
   server.** The server only issues presigned URLs and coordinates. A 4 GB file
   never touches Node's memory or bandwidth.
2. **Uploads are chunked and resumable.** A multi-GB transfer over a studio's
   connection *will* be interrupted. The file is split into parts; each part
   uploads independently and retries on failure; an interrupted upload resumes
   from the parts already stored. This is S3/R2 multipart upload.
3. **Validation never loads the whole file.** For large files the server reads
   only the header (a few MB, via a ranged GET) to get dimensions/DPI, and the
   malware scan runs out of band against the stored object — so a giant upload
   never blocks a request.

## Storage: use Cloudflare R2

The driver is S3-compatible, so AWS S3 works. But for this studio **R2 is the
better fit**: it's S3-compatible (same multipart code) and has **zero egress
fees**. Julie re-downloads multi-GB originals every time she prints; on S3 that
egress adds up fast, on R2 it's free. Point the driver at R2 with:

```
STORAGE_DRIVER=s3
S3_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
AWS_REGION=auto
S3_FORCE_PATH_STYLE=true
S3_BUCKET=pochron-originals
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
```

Backblaze B2 and MinIO work the same way (set their endpoint). Install the SDK:
`npm i @aws-sdk/client-s3 @aws-sdk/s3-request-presigner`.

## The upload flow

`POST /api/uploads/init` decides the path from the declared size: files at or
below `UPLOAD_PART_SIZE` get a single presigned PUT; larger files get a multipart
session:

```
init  → { fileId, upload: { mode:'multipart', storageKey, uploadId, partSize,
                            partCount, endpoints:{ signPart, listParts,
                            complete, abort, validate } } }
```

Then, per part: `POST endpoints.signPart {partNumber}` → `{ url }`; the browser
`PUT`s that chunk directly to storage and keeps the response `ETag`. To resume
after an interruption, `GET endpoints.listParts` returns the parts already
stored, and the client uploads only what's missing. When every part is up,
`POST endpoints.complete { parts:[{PartNumber,ETag}] }` assembles the object, and
`POST endpoints.validate` runs the header-only checks. `DELETE endpoints.abort`
cancels and cleans up.

The whole flow is covered end-to-end by `npm run smoke:large`, which runs it on
the local driver (which stages and concatenates parts on disk) so it's testable
with no cloud account.

## Client: Uppy does this out of the box

The endpoints above match Uppy's `@uppy/aws-s3` multipart contract, so you don't
hand-roll chunking, retries, resume, or progress:

```js
import Uppy from '@uppy/core';
import AwsS3 from '@uppy/aws-s3';

uppy.use(AwsS3, {
  shouldUseMultipart: (file) => file.size > 64 * 1024 * 1024,
  createMultipartUpload: async (file) => {
    const r = await api('/api/uploads/init', { method:'POST', body: {
      filename: file.name, sizeBytes: file.size, mime: file.type,
    }});
    file.meta.fileId = r.fileId;           // remember for the calls below
    return { uploadId: r.upload.uploadId, key: r.upload.storageKey };
  },
  signPart: async (file, { partNumber }) =>
    api(`/api/uploads/${file.meta.fileId}/part`, { method:'POST', body:{ partNumber } }),
  listParts: async (file) =>
    (await api(`/api/uploads/${file.meta.fileId}/parts`)).parts,
  completeMultipartUpload: async (file, { parts }) =>
    api(`/api/uploads/${file.meta.fileId}/complete-multipart`, { method:'POST', body:{ parts } }),
  abortMultipartUpload: async (file, { key, uploadId }) =>
    api(`/api/uploads/${file.meta.fileId}/multipart`, { method:'DELETE' }),
});

uppy.on('upload-success', (file) =>
  api(`/api/uploads/${file.meta.fileId}/complete`, { method:'POST' }));  // validation
```

Uppy also gives you the progress bars, pause/resume UI, and parallel part uploads
that make a multi-GB transfer bearable for the customer. (`tus` + a tus server is
an alternative if you'd rather; the same init/validate bookends apply.)

## Validation & scanning at scale

- **Metadata:** for files above `INLINE_PROCESS_MAX_BYTES` (default 256 MB) the
  server ranged-reads the first `HEADER_READ_BYTES` (default 8 MB) and pulls
  dimensions/profile from that. JPEG/PNG carry this early; some TIFF/PSD layouts
  don't, in which case the file is marked `processing` and a background pass fills
  dimensions. The DPI warning is best-effort until then; the studio always
  reviews before printing regardless.
- **Malware scan:** large files are marked `scan_status='pending'` and scanned
  out of band via `scanner.scanKey()` — wire it to stream the stored object to
  clamd, or to a bucket-side scanner (a Lambda + clamav layer, GuardDuty Malware
  Protection, etc.). Small files are still scanned inline. The studio approval
  step is the backstop: don't release to print while a scan is pending.

## Operational notes

- **Lifecycle:** set a storage lifecycle rule to abort orphaned multipart uploads
  after ~24 h (parts left by abandoned uploads still cost money), and to expire or
  cold-tier originals per the retention window (`DRAFT_TTL_DAYS`).
- **Part size:** 64 MB is a good default. Bigger parts = fewer requests but more
  to re-send on a failed chunk; 10,000 parts max, so 64 MB caps a file at ~640 GB.
- **CORS on the bucket:** the browser PUTs directly to storage, so the bucket
  needs a CORS policy allowing PUT from `order.pochronstudios.com` and exposing
  the `ETag` header.
- **Presign TTL:** part URLs default to 1 h; raise it if customers on slow links
  routinely exceed that per part.
