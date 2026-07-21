import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import crypto from 'node:crypto';
import {
  mkdirSync, writeFileSync, statSync, existsSync, readFileSync,
  readdirSync, rmSync, openSync, readSync, closeSync, createWriteStream,
} from 'node:fs';
import { config } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = join(__dirname, '..', '..', 'data', 'uploads');
const MP_DIR = join(UPLOAD_DIR, '.multipart');       // local multipart staging
mkdirSync(UPLOAD_DIR, { recursive: true });

// The upload subsystem is the highest-risk piece (§4). The browser transfers
// bytes straight to storage in resumable chunks; the app server only signs part
// URLs and coordinates — it never buffers the multi-GB body. High-end scans are
// routinely multi-GB, so multipart + resume + header-only validation are the
// default path, not an edge case.

// ── LOCAL driver (dev) ──────────────────────────────────────────────
// Simulates S3/R2 single-PUT AND multipart so the full flow is testable with no
// cloud creds: parts are staged on disk, then concatenated on complete.
const localDriver = {
  name: 'local',

  // single, small-file PUT
  async presignUpload({ fileId, filename }) {
    const key = `${fileId}/${sanitize(filename)}`;
    return { driver: 'local', mode: 'single', method: 'PUT',
      uploadUrl: `/api/uploads/local/${fileId}`, storageKey: key, headers: {} };
  },
  writeLocal(fileId, filename, buffer) {
    const dir = join(UPLOAD_DIR, fileId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, sanitize(filename));
    writeFileSync(path, buffer);
    return { path, bytes: buffer.length };
  },

  // multipart
  async createMultipart({ fileId, filename }) {
    const key = `${fileId}/${sanitize(filename)}`;
    const uploadId = crypto.randomUUID();
    mkdirSync(join(MP_DIR, uploadId), { recursive: true });
    return { key, uploadId };
  },
  // For local, the "presigned part URL" is a same-origin PUT to our receiver.
  async signPart({ fileId, uploadId, partNumber }) {
    return { url: `/api/uploads/local-part/${fileId}/${uploadId}/${partNumber}`, method: 'PUT' };
  },
  writeLocalPart(uploadId, partNumber, buffer) {
    const dir = join(MP_DIR, uploadId);
    if (!existsSync(dir)) throw new Error('Unknown or expired upload session.');
    writeFileSync(join(dir, `part-${String(partNumber).padStart(6, '0')}`), buffer);
    const etag = crypto.createHash('md5').update(buffer).digest('hex');
    return { etag, bytes: buffer.length };
  },
  async listParts({ uploadId }) {
    const dir = join(MP_DIR, uploadId);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.startsWith('part-')).sort().map((f) => {
      const n = parseInt(f.slice(5), 10);
      const buf = readFileSync(join(dir, f));
      return { PartNumber: n, ETag: crypto.createHash('md5').update(buf).digest('hex'), Size: buf.length };
    });
  },
  async completeMultipart({ key, uploadId /* parts */ }) {
    const dir = join(MP_DIR, uploadId);
    const files = readdirSync(dir).filter((f) => f.startsWith('part-')).sort();
    const outPath = join(UPLOAD_DIR, key);
    mkdirSync(dirname(outPath), { recursive: true });
    // Concatenate parts in order (streamed, so we don't hold the whole file in memory).
    await new Promise((resolve, reject) => {
      const ws = createWriteStream(outPath);
      ws.on('error', reject); ws.on('finish', resolve);
      (function next(i) {
        if (i >= files.length) return ws.end();
        ws.write(readFileSync(join(dir, files[i])), (err) => err ? reject(err) : next(i + 1));
      })(0);
    });
    rmSync(dir, { recursive: true, force: true });
    return { key, bytes: statSync(outPath).size };
  },
  async abortMultipart({ uploadId }) {
    rmSync(join(MP_DIR, uploadId), { recursive: true, force: true });
    return { aborted: true };
  },

  async getBuffer(storageKey) {
    const path = join(UPLOAD_DIR, storageKey);
    return existsSync(path) ? readFileSync(path) : null;
  },
  // Ranged read for header-only metadata on huge files (no full load).
  async getRange(storageKey, start, end) {
    const path = join(UPLOAD_DIR, storageKey);
    if (!existsSync(path)) return null;
    const len = Math.max(0, end - start + 1);
    const buf = Buffer.alloc(len);
    const fd = openSync(path, 'r');
    try { const read = readSync(fd, buf, 0, len, start); return buf.subarray(0, read); }
    finally { closeSync(fd); }
  },
  async writeDerived(storageKey, buffer) {
    const path = join(UPLOAD_DIR, storageKey);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, buffer);
    return { storageKey, bytes: buffer.length };
  },
  async size(storageKey) {
    const path = join(UPLOAD_DIR, storageKey);
    return existsSync(path) ? statSync(path).size : null;
  },
  publicUrl(storageKey) {
    return `/api/uploads/file/${encodeURIComponent(storageKey)}`;
  },
};

// ── S3 / R2 driver (production) ─────────────────────────────────────
// S3-compatible. For Cloudflare R2 set STORAGE_DRIVER=s3, S3_ENDPOINT to the R2
// endpoint, AWS_REGION=auto, and the R2 access keys. R2 has zero egress fees,
// which matters when the studio re-downloads multi-GB originals to print.
//   npm i @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
const s3Driver = {
  name: 's3',
  async _client() {
    let mod;
    try { mod = await import('@aws-sdk/client-s3'); }
    catch {
      throw new Error('S3 driver selected but @aws-sdk/client-s3 is not installed. Run: npm i @aws-sdk/client-s3 @aws-sdk/s3-request-presigner');
    }
    const { S3Client } = mod;
    const opts = { region: config.storage.region };
    if (config.storage.endpoint) opts.endpoint = config.storage.endpoint;   // R2/B2/MinIO
    if (config.storage.forcePathStyle) opts.forcePathStyle = true;
    if (config.storage.accessKeyId && config.storage.secretAccessKey)
      opts.credentials = { accessKeyId: config.storage.accessKeyId, secretAccessKey: config.storage.secretAccessKey };
    return { S3Client: new S3Client(opts), mod };
  },
  _key(fileId, filename) { return `originals/${fileId}/${sanitize(filename)}`; },

  // Small files: a single presigned PUT.
  async presignUpload({ fileId, filename, mime }) {
    const { S3Client, mod } = await this._client();
    const { PutObjectCommand } = mod;
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const key = this._key(fileId, filename);
    const url = await getSignedUrl(S3Client,
      new PutObjectCommand({ Bucket: config.storage.bucket, Key: key, ContentType: mime || undefined }),
      { expiresIn: config.storage.presignTtl });
    return { driver: 's3', mode: 'single', method: 'PUT', uploadUrl: url, storageKey: key, headers: mime ? { 'Content-Type': mime } : {} };
  },

  async createMultipart({ fileId, filename, mime }) {
    const { S3Client, mod } = await this._client();
    const { CreateMultipartUploadCommand } = mod;
    const key = this._key(fileId, filename);
    const { UploadId } = await S3Client.send(new CreateMultipartUploadCommand({
      Bucket: config.storage.bucket, Key: key, ContentType: mime || undefined,
    }));
    return { key, uploadId: UploadId };
  },
  async signPart({ key, uploadId, partNumber }) {
    const { S3Client, mod } = await this._client();
    const { UploadPartCommand } = mod;
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const url = await getSignedUrl(S3Client, new UploadPartCommand({
      Bucket: config.storage.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber,
    }), { expiresIn: config.storage.presignTtl });
    return { url, method: 'PUT' };
  },
  async listParts({ key, uploadId }) {
    const { S3Client, mod } = await this._client();
    const { ListPartsCommand } = mod;
    const out = await S3Client.send(new ListPartsCommand({ Bucket: config.storage.bucket, Key: key, UploadId: uploadId }));
    return (out.Parts || []).map((p) => ({ PartNumber: p.PartNumber, ETag: p.ETag, Size: p.Size }));
  },
  async completeMultipart({ key, uploadId, parts }) {
    const { S3Client, mod } = await this._client();
    const { CompleteMultipartUploadCommand } = mod;
    const Parts = [...parts].sort((a, b) => a.PartNumber - b.PartNumber)
      .map((p) => ({ PartNumber: p.PartNumber, ETag: p.ETag }));
    await S3Client.send(new CompleteMultipartUploadCommand({
      Bucket: config.storage.bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts },
    }));
    return { key };
  },
  async abortMultipart({ key, uploadId }) {
    const { S3Client, mod } = await this._client();
    const { AbortMultipartUploadCommand } = mod;
    await S3Client.send(new AbortMultipartUploadCommand({ Bucket: config.storage.bucket, Key: key, UploadId: uploadId }));
    return { aborted: true };
  },

  async getBuffer(storageKey) {
    const { S3Client, mod } = await this._client();
    const { GetObjectCommand } = mod;
    const res = await S3Client.send(new GetObjectCommand({ Bucket: config.storage.bucket, Key: storageKey }));
    const chunks = []; for await (const c of res.Body) chunks.push(c);
    return Buffer.concat(chunks);
  },
  async getRange(storageKey, start, end) {
    const { S3Client, mod } = await this._client();
    const { GetObjectCommand } = mod;
    const res = await S3Client.send(new GetObjectCommand({
      Bucket: config.storage.bucket, Key: storageKey, Range: `bytes=${start}-${end}`,
    }));
    const chunks = []; for await (const c of res.Body) chunks.push(c);
    return Buffer.concat(chunks);
  },
  async size(storageKey) {
    const { S3Client, mod } = await this._client();
    const { HeadObjectCommand } = mod;
    const res = await S3Client.send(new HeadObjectCommand({ Bucket: config.storage.bucket, Key: storageKey }));
    return res.ContentLength;
  },
  async writeDerived(storageKey, buffer) {
    const { S3Client, mod } = await this._client();
    const { PutObjectCommand } = mod;
    await S3Client.send(new PutObjectCommand({ Bucket: config.storage.bucket, Key: storageKey, Body: buffer }));
    return { storageKey, bytes: buffer.length };
  },
  publicUrl(storageKey) {
    return config.storage.cdnBase ? `${config.storage.cdnBase}/${storageKey}` : `s3://${config.storage.bucket}/${storageKey}`;
  },
};

function sanitize(name) {
  return String(name).replace(/[^\w.\-]+/g, '_').slice(0, 200);
}

export const storage = config.storage.driver === 's3' ? s3Driver : localDriver;
export { UPLOAD_DIR };
