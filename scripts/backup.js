#!/usr/bin/env node
// Database backup. Run from cron; see the header of BACKUPS.md for setup.
//
//   node scripts/backup.js
//
// Uses SQLite's online backup API rather than copying the file. That matters:
// the database runs in WAL mode, so a plain `cp` of pochron.db while the server
// is writing can produce a file that is missing recent transactions or is
// outright corrupt. The backup API takes a consistent snapshot of a live
// database with no downtime.
//
// Backups are gzipped, rotated locally, and optionally pushed off the box.
// A backup that only exists on the same disk as the original is not a backup:
// it protects against a bad deploy or a dropped table, not against losing the
// volume or the instance. Set BACKUP_S3_BUCKET to make it real.

import Database from 'better-sqlite3';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || join(__dirname, '..', 'data');
const DB_PATH = join(DATA_DIR, 'pochron.db');
const BACKUP_DIR = process.env.BACKUP_DIR || join(__dirname, '..', 'backups');
const KEEP_DAYS = parseInt(process.env.BACKUP_KEEP_DAYS || '14', 10);
const S3_BUCKET = process.env.BACKUP_S3_BUCKET;
const S3_PREFIX = process.env.BACKUP_S3_PREFIX || 'pochron-db';

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const rawPath = join(BACKUP_DIR, `pochron-${stamp}.db`);
const gzPath = `${rawPath}.gz`;

async function main() {
  if (!existsSync(DB_PATH)) {
    console.error(`No database at ${DB_PATH}`);
    process.exit(1);
  }
  mkdirSync(BACKUP_DIR, { recursive: true });

  // 1. Consistent snapshot of the live database.
  const db = new Database(DB_PATH, { readonly: true });
  await db.backup(rawPath);

  // Verify the snapshot opens and has the tables we expect before trusting it.
  const check = new Database(rawPath, { readonly: true });
  const orders = check.prepare('SELECT COUNT(*) c FROM orders').get().c;
  const integrity = check.pragma('integrity_check', { simple: true });
  check.close();
  db.close();
  // Opening the snapshot creates -wal/-shm sidecars; they aren't part of the backup.
  for (const ext of ['-wal', '-shm']) {
    if (existsSync(rawPath + ext)) unlinkSync(rawPath + ext);
  }
  if (integrity !== 'ok') throw new Error(`Backup failed integrity check: ${integrity}`);

  // 2. Compress (SQLite files gzip very well).
  await pipeline(createReadStream(rawPath), createGzip({ level: 9 }), createWriteStream(gzPath));
  unlinkSync(rawPath);
  const size = statSync(gzPath).size;
  console.log(`✓ ${gzPath}  (${orders} orders, ${(size / 1024).toFixed(0)} KB, integrity ok)`);

  // 3. Off-box copy — the part that actually protects you.
  if (S3_BUCKET) {
    try {
      const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
      const opts = { region: process.env.AWS_REGION || 'auto' };
      if (process.env.S3_ENDPOINT) opts.endpoint = process.env.S3_ENDPOINT;
      if (process.env.S3_FORCE_PATH_STYLE === 'true') opts.forcePathStyle = true;
      if (process.env.S3_ACCESS_KEY_ID) {
        opts.credentials = {
          accessKeyId: process.env.S3_ACCESS_KEY_ID,
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
        };
      }
      const client = new S3Client(opts);
      const { readFileSync } = await import('node:fs');
      await client.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: `${S3_PREFIX}/pochron-${stamp}.db.gz`,
        Body: readFileSync(gzPath),
      }));
      console.log(`✓ uploaded to ${S3_BUCKET}/${S3_PREFIX}/`);
    } catch (e) {
      // Loud, and a non-zero exit, so a silent offsite failure doesn't look fine.
      console.error(`✗ OFFSITE UPLOAD FAILED: ${e.message}`);
      process.exitCode = 2;
    }
  } else {
    console.warn('⚠ BACKUP_S3_BUCKET is not set — this backup is on the same disk as the database.');
  }

  // 4. Rotate local copies.
  const cutoff = Date.now() - KEEP_DAYS * 86400_000;
  let removed = 0;
  for (const f of readdirSync(BACKUP_DIR)) {
    if (!f.startsWith('pochron-') || !f.endsWith('.db.gz')) continue;
    const p = join(BACKUP_DIR, f);
    if (statSync(p).mtimeMs < cutoff) { unlinkSync(p); removed++; }
  }
  if (removed) console.log(`  rotated out ${removed} backup(s) older than ${KEEP_DAYS} days`);
}

main().catch((e) => {
  console.error('BACKUP FAILED:', e.message);
  process.exit(1);
});
