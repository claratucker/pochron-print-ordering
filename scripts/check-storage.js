#!/usr/bin/env node
// Verify object storage before trusting it with customer originals.
//
//   node scripts/check-storage.js
//
// Exercises the operations the app actually depends on — including multipart,
// which is the path every multi-GB scan takes — and cleans up after itself.
// Run this after changing STORAGE_DRIVER, and again from the server itself,
// since credentials and network egress can differ between machines.

import { config } from '../src/config.js';
import { storage } from '../src/adapters/storage.js';
import crypto from 'node:crypto';

const results = [];
const ok = (name, passed, detail = '') => {
  results.push(passed);
  console.log(`  ${passed ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
};

async function main() {
  console.log(`\nStorage driver: ${storage.name}`);
  if (storage.name === 's3') {
    console.log(`  bucket:   ${config.storage.bucket}`);
    console.log(`  endpoint: ${config.storage.endpoint || '(AWS S3 default)'}`);
    console.log(`  region:   ${config.storage.region}`);
    if (!config.storage.bucket) {
      console.error('\n✗ S3_BUCKET is not set.\n');
      process.exit(1);
    }
  } else {
    console.log('  (local disk — set STORAGE_DRIVER=s3 to test R2/S3)');
  }
  console.log('');

  const id = `_healthcheck/${crypto.randomUUID()}`;
  const payload = Buffer.from('pochron storage check ' + new Date().toISOString());

  // 1. Write
  try {
    await storage.writeDerived(id, payload);
    ok('write an object', true);
  } catch (e) {
    ok('write an object', false, e.message);
    return finish();
  }

  // 2. Read back and compare
  try {
    const got = await storage.getBuffer(id);
    ok('read it back intact', Buffer.compare(got, payload) === 0);
  } catch (e) {
    ok('read it back intact', false, e.message);
  }

  // 3. Ranged read — how metadata is pulled from multi-GB files without
  //    downloading them.
  try {
    const part = await storage.getRange(id, 0, 7);
    ok('ranged read (header-only metadata)', part && part.length === 8, `got ${part?.length} bytes`);
  } catch (e) {
    ok('ranged read (header-only metadata)', false, e.message);
  }

  // 4. Size
  try {
    const size = await storage.size(id);
    ok('report object size', size === payload.length, `${size} bytes`);
  } catch (e) {
    ok('report object size', false, e.message);
  }

  // 5. Multipart — the path every large scan takes.
  let mp = null;
  try {
    mp = await storage.createMultipart({ fileId: 'healthcheck', filename: 'check.bin', mime: 'application/octet-stream' });
    ok('start a multipart upload', !!mp.uploadId);
  } catch (e) {
    ok('start a multipart upload', false, e.message);
  }
  if (mp?.uploadId) {
    try {
      const signed = await storage.signPart({ fileId: 'healthcheck', key: mp.key, uploadId: mp.uploadId, partNumber: 1 });
      ok('sign a part URL (browser uploads direct)', !!signed.url);
    } catch (e) {
      ok('sign a part URL (browser uploads direct)', false, e.message);
    }
    try {
      await storage.abortMultipart({ key: mp.key, uploadId: mp.uploadId });
      ok('abort a multipart upload (cleanup)', true);
    } catch (e) {
      ok('abort a multipart upload (cleanup)', false, e.message);
    }
  }

  // 6. Presign a single PUT
  try {
    const p = await storage.presignUpload({ fileId: 'healthcheck', filename: 'x.png', mime: 'image/png' });
    ok('presign a direct upload URL', !!p.uploadUrl);
  } catch (e) {
    ok('presign a direct upload URL', false, e.message);
  }

  finish();
}

function finish() {
  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;
  console.log(`\n──────── ${passed} passed, ${failed} failed ────────`);
  if (failed) {
    console.log(`
If writes fail with AccessDenied, the API token needs Object Read & Write on
this bucket. If the browser can upload but the studio cannot read originals
back, that is a CORS problem on the bucket, not a credentials problem —
the policy must allow PUT and GET from the order domain and expose ETag.
`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('CHECK FAILED:', e.message); process.exit(1); });
