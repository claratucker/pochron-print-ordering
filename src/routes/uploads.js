import { Router, raw } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { storage } from '../adapters/storage.js';
import { scanner } from '../adapters/misc.js';
import { extractMeta, extractMetaFromHeader } from '../lib/imagemeta.js';
import { loadCatalog } from '../lib/catalog.js';
import { bestDpi } from '../lib/pricing.js';
import { getOrSetDraftToken } from '../lib/auth.js';
import { hasRoomFor } from '../lib/disk.js';
import { UPLOAD_DIR } from '../adapters/storage.js';

export const uploadsRouter = Router();

const InitSchema = z.object({
  filename: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  mime: z.string().optional(),
});

// POST /api/uploads/init — server enforces count/size/type BEFORE handing back
// an upload target (§4). Small files get a single presigned PUT; large files
// (routine for scans) get a resumable multipart session. The app server never
// receives the bytes either way.
uploadsRouter.post('/init', async (req, res) => {
  const token = getOrSetDraftToken(req, res);
  const parsed = InitSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid upload init', details: parsed.error.flatten() });
  const { filename, sizeBytes, mime } = parsed.data;

  const active = db.prepare(
    `SELECT COUNT(*) c FROM files WHERE owner_token = ? AND status != 'rejected'`
  ).get(token).c;
  if (active >= config.uploads.maxFiles) {
    return res.status(409).json({ error: `Up to ${config.uploads.maxFiles} files per order.`, code: 'MAX_FILES' });
  }
  if (sizeBytes > config.uploads.maxBytes) {
    return res.status(413).json({
      error: `"${filename}" is over the ${Math.round(config.uploads.maxBytes / 1073741824)} GB limit.`,
      code: 'TOO_LARGE',
      fallback: { studio: config.email.studioContactUrl },
    });
  }
  if (mime && !config.uploads.acceptedMime.includes(mime)) {
    return res.status(415).json({ error: `Unsupported type: ${mime}. Accepted: JPEG, TIFF, PSD, PNG.`, code: 'BAD_TYPE' });
  }

  // Refuse before handing out an upload target, not halfway through a 4 GB transfer.
  const room = await hasRoomFor(sizeBytes, UPLOAD_DIR);
  if (!room.ok) {
    console.error(`DISK: refusing upload — ${(room.freeBytes / 1073741824).toFixed(1)} GB free, ${room.usedPct}% used`);
    return res.status(507).json({
      error: 'We are temporarily unable to accept new uploads. Please contact the studio and we will arrange the transfer.',
      code: 'INSUFFICIENT_STORAGE',
      fallback: { studio: config.email.studioContactUrl },
    });
  }

  const fileId = crypto.randomUUID();
  const { partSize } = config.uploads;
  const multipart = sizeBytes > partSize;

  if (multipart) {
    const { key, uploadId } = await storage.createMultipart({ fileId, filename, mime });
    const partCount = Math.max(1, Math.ceil(sizeBytes / partSize));
    if (partCount > config.uploads.maxParts) {
      return res.status(413).json({ error: 'File needs more parts than allowed; increase UPLOAD_PART_SIZE.', code: 'TOO_MANY_PARTS' });
    }
    db.prepare(
      `INSERT INTO files (id, owner_token, storage_key, original_name, mime, bytes, status, multipart_upload_id)
       VALUES (?,?,?,?,?,?, 'initialized', ?)`
    ).run(fileId, token, key, filename, mime || null, sizeBytes, uploadId);

    return res.json({
      fileId,
      upload: {
        driver: storage.name, mode: 'multipart', storageKey: key, uploadId,
        partSize, partCount,
        endpoints: {
          signPart: `/api/uploads/${fileId}/part`,        // POST { partNumber } → { url }
          listParts: `/api/uploads/${fileId}/parts`,       // GET → { parts } (resume)
          complete: `/api/uploads/${fileId}/complete-multipart`, // POST { parts }
          abort: `/api/uploads/${fileId}/multipart`,       // DELETE
          validate: `/api/uploads/${fileId}/complete`,     // POST (after complete)
        },
      },
    });
  }

  const presign = await storage.presignUpload({ fileId, filename, mime });
  db.prepare(
    `INSERT INTO files (id, owner_token, storage_key, original_name, mime, bytes, status)
     VALUES (?,?,?,?,?,?, 'initialized')`
  ).run(fileId, token, presign.storageKey, filename, mime || null, sizeBytes);
  res.json({ fileId, upload: { ...presign, mode: presign.mode || 'single' } });
});

// POST /api/uploads/:fileId/part — return a presigned URL for one part. The
// client PUTs the chunk directly to storage and keeps the returned ETag.
const PartSchema = z.object({ partNumber: z.number().int().positive() });
uploadsRouter.post('/:fileId/part', async (req, res) => {
  const file = db.prepare('SELECT * FROM files WHERE id=?').get(req.params.fileId);
  if (!file || !file.multipart_upload_id) return res.status(404).json({ error: 'No multipart upload for this file.' });
  const parsed = PartSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'partNumber required.' });
  const signed = await storage.signPart({
    fileId: file.id, key: file.storage_key, uploadId: file.multipart_upload_id, partNumber: parsed.data.partNumber,
  });
  res.json(signed);
});

// PUT /api/uploads/local-part/:fileId/:uploadId/:partNumber — LOCAL driver only:
// receives one chunk and returns its ETag (production PUTs straight to S3/R2).
uploadsRouter.put('/local-part/:fileId/:uploadId/:partNumber',
  raw({ type: '*/*', limit: config.uploads.partSize + 1048576 }), (req, res) => {
    if (storage.name !== 'local') return res.status(404).json({ error: 'Not found' });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'Empty part' });
    try {
      const { etag } = storage.writeLocalPart(req.params.uploadId, +req.params.partNumber, req.body);
      res.setHeader('ETag', `"${etag}"`);
      res.json({ etag, partNumber: +req.params.partNumber, bytes: req.body.length });
    } catch (e) { res.status(409).json({ error: e.message }); }
  });

// GET /api/uploads/:fileId/parts — list uploaded parts so an interrupted upload
// can resume where it left off.
uploadsRouter.get('/:fileId/parts', async (req, res) => {
  const file = db.prepare('SELECT * FROM files WHERE id=?').get(req.params.fileId);
  if (!file || !file.multipart_upload_id) return res.status(404).json({ error: 'No multipart upload for this file.' });
  const parts = await storage.listParts({ key: file.storage_key, uploadId: file.multipart_upload_id });
  res.json({ parts, partSize: config.uploads.partSize });
});

// POST /api/uploads/:fileId/complete-multipart — finalize the object from parts.
const CompleteSchema = z.object({
  parts: z.array(z.object({ PartNumber: z.number().int().positive(), ETag: z.string() })).min(1),
});
uploadsRouter.post('/:fileId/complete-multipart', async (req, res) => {
  const file = db.prepare('SELECT * FROM files WHERE id=?').get(req.params.fileId);
  if (!file || !file.multipart_upload_id) return res.status(404).json({ error: 'No multipart upload for this file.' });
  const parsed = CompleteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'parts[] required.', details: parsed.error.flatten() });
  try {
    await storage.completeMultipart({ key: file.storage_key, uploadId: file.multipart_upload_id, parts: parsed.data.parts });
    db.prepare(`UPDATE files SET status='uploaded', multipart_upload_id=NULL WHERE id=?`).run(file.id);
    res.json({ ok: true, fileId: file.id });
  } catch (e) { res.status(502).json({ error: 'Could not finalize the upload.', detail: e.message }); }
});

// DELETE /api/uploads/:fileId/multipart — abort an in-progress upload (cancel).
uploadsRouter.delete('/:fileId/multipart', async (req, res) => {
  const file = db.prepare('SELECT * FROM files WHERE id=?').get(req.params.fileId);
  if (!file || !file.multipart_upload_id) return res.status(404).json({ error: 'No multipart upload for this file.' });
  try {
    await storage.abortMultipart({ key: file.storage_key, uploadId: file.multipart_upload_id });
    db.prepare(`UPDATE files SET status='rejected', reject_reason='aborted', multipart_upload_id=NULL WHERE id=?`).run(file.id);
    res.json({ aborted: true });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// PUT /api/uploads/local/:fileId — LOCAL single-PUT receiver (small files, dev).
uploadsRouter.put('/local/:fileId', raw({ type: '*/*', limit: config.uploads.partSize + 1048576 }), (req, res) => {
  if (storage.name !== 'local') return res.status(404).json({ error: 'Not found' });
  const file = db.prepare('SELECT * FROM files WHERE id = ?').get(req.params.fileId);
  if (!file) return res.status(404).json({ error: 'Unknown file' });
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'Empty body' });
  storage.writeLocal(req.params.fileId, file.original_name, req.body);
  db.prepare(`UPDATE files SET bytes = ?, status = 'uploaded' WHERE id = ?`).run(req.body.length, req.params.fileId);
  res.json({ ok: true, bytes: req.body.length });
});

// POST /api/uploads/:fileId/complete — validation gate (§4). Small files are
// scanned + read in full; large files (routine scans) are validated header-only
// and scanned out of band, so the request never loads the multi-GB body.
uploadsRouter.post('/:fileId/complete', async (req, res) => {
  const file = db.prepare('SELECT * FROM files WHERE id = ?').get(req.params.fileId);
  if (!file) return res.status(404).json({ error: 'Unknown file' });

  const realSize = (await storage.size(file.storage_key)) ?? file.bytes ?? 0;
  if (!realSize) return res.status(409).json({ error: 'File not present in storage yet.' });
  if (realSize > config.uploads.maxBytes) {
    db.prepare(`UPDATE files SET status='rejected', reject_reason='too_large' WHERE id=?`).run(file.id);
    return res.status(413).json({ error: 'File exceeds the size limit.', code: 'TOO_LARGE' });
  }

  const cat = loadCatalog();
  const large = realSize > config.uploads.inlineProcessMaxBytes;

  let meta, scan, deferred = false;
  if (large) {
    // Header-only metadata; defer the scan to a background pass.
    const header = await storage.getRange(file.storage_key, 0, config.uploads.headerReadBytes - 1);
    meta = header ? await extractMetaFromHeader(header) : { width: null, height: null, colorProfile: null, bitDepth: null, ok: false, deferred: true };
    deferred = !meta.ok || meta.deferred;
    scan = 'pending';
    // Kick the out-of-band scan without blocking the response.
    Promise.resolve().then(() => scanner.scanKey(file.storage_key))
      .then((result) => db.prepare(`UPDATE files SET scan_status=? WHERE id=?`).run(result, file.id))
      .catch((e) => console.error('Deferred scan failed:', e.message));
  } else {
    const buffer = await storage.getBuffer(file.storage_key);
    if (!buffer) return res.status(409).json({ error: 'File not present in storage yet.' });
    scan = await scanner.scan(buffer);
    if (scan === 'infected') {
      db.prepare(`UPDATE files SET scan_status='infected', status='rejected', reject_reason='infected' WHERE id=?`).run(file.id);
      return res.status(422).json({ error: 'File failed a security scan and was rejected.', code: 'INFECTED' });
    }
    meta = await extractMeta(buffer);
  }

  const best = (meta.width && meta.height) ? bestDpi(meta.width, meta.height, cat.sizes) : null;
  const status = deferred ? 'processing' : 'validated';
  db.prepare(
    `UPDATE files SET bytes=?, width=?, height=?, color_profile=?, bit_depth=?, best_dpi=?,
      scan_status=?, status=? WHERE id=?`
  ).run(realSize, meta.width, meta.height, meta.colorProfile, meta.bitDepth, best, scan, status, file.id);

  res.json({
    fileId: file.id,
    name: file.original_name,
    width: meta.width, height: meta.height,
    colorProfile: meta.colorProfile, bitDepth: meta.bitDepth,
    bestDpi: best,
    tooSmallEverywhere: best != null ? best < cat.dpiMin : false,
    sizeBytes: realSize,
    scanPending: scan === 'pending',
    metadataDeferred: deferred,   // dimensions filled by a background pass for huge files
    url: storage.publicUrl(file.storage_key),
  });
});

// GET /api/uploads/file/:key — LOCAL driver preview/serving (dev). In production
// originals live behind the CDN with per-customer access control (§13).
uploadsRouter.get('/file/*', async (req, res) => {
  if (storage.name !== 'local') return res.status(404).end();
  const key = decodeURIComponent(req.params[0]);
  const buffer = await storage.getBuffer(key);
  if (!buffer) return res.status(404).end();
  res.setHeader('Content-Type', 'application/octet-stream');
  res.send(buffer);
});
