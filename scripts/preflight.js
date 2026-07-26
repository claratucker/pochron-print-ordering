#!/usr/bin/env node
// Offline preflight for the Stripe + R2 wiring. Catches the half-configured
// states that otherwise only surface when a customer hits them:
//   - driver flipped on but the SDK was never installed
//   - a value left as a REPLACE_/<...> placeholder
//   - test vs live key mismatch (or a pk_ where an sk_ belongs)
//   - storage/payment vars missing while the driver expects them
//
// No network, no secrets printed. Run before restarting:
//   node scripts/preflight.js
// Exits 1 if anything would fail at runtime, 0 otherwise.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Load .env into process.env if present (tiny parser, no dependency) so the
// script "just works" from the project root without a process manager.
try {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    for (const raw of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(k in process.env)) process.env[k] = v;
    }
  }
} catch { /* ignore */ }

const env = process.env;
let failures = 0, warnings = 0;
const fail = (m) => { failures++; console.log('  \u2717 ' + m); };
const warn = (m) => { warnings++; console.log('  ! ' + m); };
const ok = (m) => console.log('  \u2713 ' + m);

// A value is "unset" if empty, or still a template placeholder.
const isPlaceholder = (v) => !v || /REPLACE|<[^>]+>|change[_-]?me|xxxx/i.test(v);
const has = (k) => !isPlaceholder(env[k]);
const installed = (mod) => { try { require.resolve(mod); return true; } catch { return false; } };
const mask = (v) => (v ? v.slice(0, 8) + '\u2026' : '(unset)');

console.log('\nPreflight \u2014 payments');
const payDriver = env.PAYMENT_DRIVER || 'mock';
if (payDriver !== 'stripe') {
  ok(`PAYMENT_DRIVER=${payDriver} \u2014 mock payments (no real authorizations). Nothing to check.`);
} else {
  if (!installed('stripe')) fail("PAYMENT_DRIVER=stripe but the 'stripe' package is not installed. Run: npm i stripe");
  else ok("'stripe' package installed");

  const sk = env.STRIPE_SECRET_KEY, pk = env.STRIPE_PUBLISHABLE_KEY;
  if (!has('STRIPE_SECRET_KEY')) fail('STRIPE_SECRET_KEY is unset or a placeholder');
  else if (!sk.startsWith('sk_')) fail(`STRIPE_SECRET_KEY should start with sk_ (got ${mask(sk)})`);
  else ok(`STRIPE_SECRET_KEY looks like a secret key (${mask(sk)})`);

  if (!has('STRIPE_PUBLISHABLE_KEY')) fail('STRIPE_PUBLISHABLE_KEY is unset or a placeholder');
  else if (!pk.startsWith('pk_')) fail(`STRIPE_PUBLISHABLE_KEY should start with pk_ (got ${mask(pk)})`);
  else ok(`STRIPE_PUBLISHABLE_KEY looks like a publishable key (${mask(pk)})`);

  // Mode coherence: both must be test, or both live.
  const mode = (k) => k && k.startsWith('sk_test_') || k && k.startsWith('pk_test_') ? 'test'
    : k && (k.startsWith('sk_live_') || k.startsWith('pk_live_')) ? 'live' : 'unknown';
  if (has('STRIPE_SECRET_KEY') && has('STRIPE_PUBLISHABLE_KEY')) {
    const ms = mode(sk), mp = mode(pk);
    if (ms !== 'unknown' && mp !== 'unknown' && ms !== mp)
      fail(`Key mode mismatch: secret is ${ms}, publishable is ${mp}. Both must be test or both live.`);
    else if (ms === 'live') warn('Keys are LIVE \u2014 real cards will be charged. Use sk_test_/pk_test_ until you go live.');
    else if (ms === 'test') ok('Both keys are test mode');
  }
  if (has('STRIPE_WEBHOOK_SECRET')) warn('STRIPE_WEBHOOK_SECRET is set but the app has no webhook handler \u2014 it is ignored.');
}

console.log('\nPreflight \u2014 storage');
const storeDriver = env.STORAGE_DRIVER || 'local';
if (storeDriver !== 's3') {
  ok(`STORAGE_DRIVER=${storeDriver} \u2014 originals on local disk (not durable, not backed up). Nothing to check.`);
} else {
  for (const mod of ['@aws-sdk/client-s3', '@aws-sdk/s3-request-presigner']) {
    if (!installed(mod)) fail(`STORAGE_DRIVER=s3 but '${mod}' is not installed. Run: npm i @aws-sdk/client-s3 @aws-sdk/s3-request-presigner`);
    else ok(`'${mod}' installed`);
  }
  for (const k of ['S3_BUCKET', 'S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) {
    if (!has(k)) fail(`${k} is unset or a placeholder`);
    // Mask the credential pair (access key id + secret) so pasted preflight output can't leak it.
    else ok(`${k} set${k.includes('ACCESS_KEY') ? ` (${mask(env[k])})` : `: ${env[k]}`}`);
  }
  const ep = env.S3_ENDPOINT || '';
  if (has('S3_ENDPOINT') && !/^https:\/\/[a-z0-9]+\.r2\.cloudflarestorage\.com\/?$/i.test(ep))
    warn(`S3_ENDPOINT doesn't match https://<account-id>.r2.cloudflarestorage.com \u2014 double-check it (got ${ep})`);
  if ((env.AWS_REGION || '') !== 'auto') warn(`AWS_REGION should be 'auto' for R2 (got '${env.AWS_REGION || '(unset)'}')`);
  if ((env.S3_FORCE_PATH_STYLE || '') !== 'true') warn("S3_FORCE_PATH_STYLE should be 'true' for R2");
  console.log('  \u2139 CORS on the bucket is browser-side and cannot be checked here \u2014 verify with a real upload (npm run check:storage covers server-side only).');
}

console.log('\nPreflight \u2014 app');
if (!has('APP_SECRET') || env.APP_SECRET === 'dev-only-change-me')
  warn('APP_SECRET is unset or the dev default \u2014 set a real random value for production.');
else ok('APP_SECRET set');

console.log(`\n${failures ? '\u2717' : '\u2713'} ${failures} failure(s), ${warnings} warning(s).\n`);
process.exit(failures ? 1 : 0);
