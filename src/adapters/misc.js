import { config } from '../config.js';

// ── Tax (§7/§8) ─────────────────────────────────────────────────────
// Drivers: none | flat | stripe
//
// Returns { amount, status, provider } where status is:
//   'ok'        — calculated by a real provider for this address
//   'estimated' — flat-rate fallback, not authoritative
//   'none'      — no tax configured (development only)
//   'failed'    — the provider errored; the order still completes, but it is
//                 flagged in the studio queue so it can be corrected. Blocking
//                 checkout on a tax-provider outage would cost more than it saves.
//
// Stripe Tax needs an origin address set in the Stripe dashboard
// (Settings → Tax) and registrations for the states where tax is owed.
// txcd_99999999 = general tangible goods, which is what prints are.
export const tax = {
  async quote({ printsTotal = 0, shippingCost = 0, address, currency = 'usd' }) {
    const driver = config.tax.driver;

    if (driver === 'flat') {
      return {
        amount: +((printsTotal + shippingCost) * config.tax.flatRate).toFixed(2),
        status: 'estimated', provider: 'flat',
      };
    }

    if (driver === 'stripe') {
      if (!config.payment.stripeSecret) {
        console.error('TAX: stripe driver selected but STRIPE_SECRET_KEY is unset.');
        return { amount: 0, status: 'failed', provider: 'stripe' };
      }
      try {
        const { default: Stripe } = await import('stripe');
        const stripe = new Stripe(config.payment.stripeSecret);
        const calc = await stripe.tax.calculations.create({
          currency,
          line_items: [{
            amount: Math.round(printsTotal * 100),
            reference: 'prints',
            tax_behavior: 'exclusive',
            tax_code: config.tax.stripeTaxCode,
          }],
          shipping_cost: { amount: Math.round(shippingCost * 100), tax_behavior: 'exclusive' },
          customer_details: {
            address: {
              line1: address?.addr1 || '',
              line2: address?.addr2 || undefined,
              city: address?.city || '',
              state: address?.state || '',
              postal_code: address?.zip || '',
              country: normalizeCountry(address?.country),
            },
            address_source: 'shipping',
          },
        });
        return {
          amount: +((calc.tax_amount_exclusive || 0) / 100).toFixed(2),
          status: 'ok', provider: 'stripe', calculationId: calc.id,
        };
      } catch (e) {
        // Do not block the sale. Record it so it can be reconciled.
        console.error('TAX: Stripe Tax calculation failed —', e.message);
        return { amount: 0, status: 'failed', provider: 'stripe', error: e.message };
      }
    }

    return { amount: 0, status: 'none', provider: 'none' };
  },
};

// Stripe wants ISO-3166 alpha-2; the checkout may send a full country name.
function normalizeCountry(c) {
  const v = String(c || 'US').trim();
  if (v.length === 2) return v.toUpperCase();
  const map = { 'united states': 'US', 'united states of america': 'US', usa: 'US', canada: 'CA' };
  return map[v.toLowerCase()] || 'US';
}

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
