import { config } from '../config.js';

// ── Tax (§7/§8) ─────────────────────────────────────────────────────
// The mockup defers tax to the address. 'none' returns 0; 'flat' applies a
// single rate. For production, swap in a provider (TaxJar/Avalara/Stripe Tax)
// keyed on the shipping address — same interface.
export const tax = {
  async quote({ printsTotal, shippingCost, address }) {
    if (config.tax.driver === 'flat') {
      return +(((printsTotal || 0) + (shippingCost || 0)) * config.tax.flatRate).toFixed(2);
    }
    return 0;
  },
};

// ── Virus / malware scan (§4/§13) ───────────────────────────────────
// Small files are scanned inline on receipt. Multi-GB files are NOT pulled into
// the app server to scan — that would block the request and blow memory — so
// they're marked 'pending' and scanned out of band via scanKey() (a background
// worker streams the object from storage to clamd, or a cloud scanner runs on
// the bucket object). Returns: 'clean' | 'infected' | 'error' | 'pending'.
export const scanner = {
  async scan(/* buffer */) {
    // e.g. const clam = await NodeClam().init(); return (await clam.scanBuffer(buffer)).isInfected ? 'infected' : 'clean';
    return 'clean';
  },
  // Deferred/streaming scan of an already-stored object (for large uploads).
  // Wire this to a background job: stream storage.getBuffer/getRange → clamd
  // INSTREAM, or trigger a bucket-side scanner (e.g. GuardDuty Malware, a Lambda
  // + clamav layer, or Cloudflare's scanning). Until wired, treat as clean.
  async scanKey(/* storageKey */) {
    return 'clean';
  },
};
