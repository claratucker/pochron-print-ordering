// ─── Server-authoritative pricing + DPI engine ─────────────────────────────
// This is the real charge. The client total is a display convenience (§7).
// Every function here mirrors the mockup's math one-to-one so the numbers match.

import { SHIP_REGIONS, SHIP_COUNTRIES } from '../catalog-defaults.js';

const round2 = (n) => +Number(n).toFixed(2);
export const dims = (s) => s.split('×').map(Number);

// dpiAtSize: how sharp `size` prints given a file's pixel dimensions, allowing
// either orientation (matches dpiAtSize() in the mockup).
export function dpiAtSize(width, height, sizeStr) {
  if (!width || !height) return Infinity;
  const [w, h] = dims(sizeStr);
  return Math.round(Math.max(Math.min(width / w, height / h), Math.min(width / h, height / w)));
}
export function bestDpi(width, height, sizes) {
  return Math.max(...sizes.map((s) => dpiAtSize(width, height, s)));
}
export function dpiFlag(dpi, cat) {
  if (dpi < cat.dpiMin) return 'too_small';
  if (dpi < cat.dpiGood) return 'soft';
  return 'ok';
}

// ── Per-line math (unitPrice / ccFee / photoTotal in the mockup) ──
export function priceLine(cat, item, file) {
  const paper = cat.paperById[item.paper];
  if (!paper) throw new PriceError(`Unknown paper: ${item.paper}`);
  const famPrices = cat.prices[paper.fam];
  const base = famPrices?.[item.size];
  if (base === undefined) throw new PriceError(`No price for ${paper.fam} ${item.size}`);

  const border = cat.borders[item.border] || cat.borders.none;
  const qty = Math.max(1, parseInt(item.qty, 10) || 1);
  const isStudio = item.colorPath === 'studio';

  const unitPrice = round2(base + border.add);
  const ccFee = isStudio ? cat.ccAdd : 0;
  const lineTotal = round2(unitPrice * qty + ccFee);

  // DPI from the *file's real metadata*, not from the client (§4).
  const w = file?.width, h = file?.height;
  const dpi = (w && h) ? dpiAtSize(w, h, item.size) : null;

  return {
    paper: item.paper, paperLabel: paper.label, fam: paper.fam,
    size: item.size, border: item.border, qty,
    colorPath: item.colorPath || 'none',
    unitPrice, ccFee, lineTotal,
    width: w ?? null, height: h ?? null,
    dpi, dpiFlag: dpi == null ? null : dpiFlag(dpi, cat),
  };
}

// ── Shipping: domestic by region (state), non-US on the flat method for now ──
function normalizeState(v) {
  const t = String(v || '').trim().toUpperCase();
  if (SHIP_REGIONS.states[t]) return t;                    // already a 2-letter code
  return SHIP_REGIONS.names[t.toLowerCase()] || null;      // full name -> abbr
}
function isUS(country) {
  const c = String(country ?? 'US').trim().toLowerCase();
  return !c || ['us', 'usa', 'united states', 'united states of america'].includes(c);
}
// ZIP3 prefix -> zone (fallback when the state field doesn't resolve). Requires
// at least 3 digits so a partial ZIP can't match prematurely.
function zoneFromZip(zip) {
  const d = String(zip || '').replace(/\D/g, '');
  if (d.length < 3) return null;
  const z3 = parseInt(d.slice(0, 3), 10);
  for (const [lo, hi, zone] of (SHIP_REGIONS.zip3 || [])) if (z3 >= lo && z3 <= hi) return zone;
  return null;
}
// Returns { cost, zone, label, method }. printsTotal is the discounted goods total,
// used for the free-shipping threshold.
export function shippingForZone(cat, address, methodId, printsTotal) {
  const exp = methodId === 'expedited';
  const free = Number(cat.freeShipOver || 0);
  if (isUS(address?.country)) {
    // Free shipping applies to domestic STANDARD only (never expedited, never international).
    if (free > 0 && printsTotal >= free && !exp) return { cost: 0, zone: 'free', label: 'Free shipping', method: methodId };
    const st = normalizeState(address?.state);
    const zoneKey = (st && SHIP_REGIONS.states[st]) || zoneFromZip(address?.zip);   // state, then ZIP; never a middle default
    const zone = zoneKey && (cat.shipZones || []).find((z) => z.key === zoneKey);
    if (zone) {
      const cost = exp ? (zone.expedited ?? zone.standard) : zone.standard;
      return { cost: round2(cost), zone: zone.key, label: `${zone.label} \u00b7 ${exp ? 'Expedited' : 'Standard'}`, method: methodId };
    }
    // US but neither state nor ZIP resolves -> fail closed to a quote, never a middle tier.
    return { gate: true, cost: 0, zone: 'quote', label: 'Contact the studio for a shipping quote', method: methodId };
  } else {
    // International: map country -> zone (charged as the zone price); unmapped -> quote gate.
    const hit = SHIP_COUNTRIES[String(address?.country || '').trim().toLowerCase()];
    const zone = hit && (cat.shipZones || []).find((z) => z.key === hit.zone);
    if (zone) return { cost: round2(zone.standard), zone: zone.key, label: zone.label, method: methodId, intl: true };
    return { gate: true, cost: 0, zone: 'quote', label: 'Contact the studio for a shipping quote', method: methodId };
  }
  // Fallback only if US zones are somehow unavailable.
  const m = cat.shipping.find((x) => x.id === methodId) || cat.shipping[0];
  return { cost: m ? m.cost : 0, zone: 'flat', label: m?.label, method: m?.id };
}

// ── Whole-order math (subtotal → volume tier → grand total) ──
export function priceOrder(cat, items, files, shipMethodId, address) {
  const fileById = Object.fromEntries((files || []).map((f) => [f.id, f]));
  const lines = items.map((it) => priceLine(cat, it, fileById[it.fileId]));

  const subtotal = round2(lines.reduce((s, l) => s + l.lineTotal, 0));
  const totalQty = lines.reduce((s, l) => s + l.qty, 0);

  // Volume tier by total print count (tiers stored high→low).
  const tier = cat.volume.find((v) => totalQty >= v.min) || { rate: 0, label: 'Standard pricing' };
  const manualQuote = tier.rate === null;                 // 100+ → contact us
  const discountRate = manualQuote ? 0 : (tier.rate || 0);
  const discountAmount = round2(subtotal * discountRate);
  const printsTotal = round2(subtotal - discountAmount);

  const ship = shippingForZone(cat, address, shipMethodId, printsTotal);
  const shippingCost = ship.cost;

  const anyTooSmall = lines.some((l) => l.dpiFlag === 'too_small');

  return {
    lines, subtotal, totalQty,
    tier: { min: tier.min, rate: tier.rate, label: tier.label },
    manualQuote, discountRate, discountAmount, printsTotal,
    shipMethod: ship.method, shippingLabel: ship.label, shippingCost, shipZone: ship.zone, shipGate: !!ship.gate,
    anyTooSmall,
    // Tax + final total are finished in finalizeTotals() once we have an address.
  };
}

// Tax enters the total at checkout, computed from the shipping address (§7/§8).
export function finalizeTotals(quote, tax) {
  const taxAmount = round2(tax || 0);
  const total = round2(quote.printsTotal + quote.shippingCost + taxAmount);
  return { ...quote, tax: taxAmount, total };
}


// Amount to capture at approval. Full approval captures the order total, minus an
// optional DOWN-ONLY reduction to shipping (Julie entering the real postage on an
// international order — she can never capture above the authorized total). Partial
// approval captures just the approved line totals; shipping settles on full approval.
export function captureAmountFor({ total, shippingCost, items }, { itemIds, actualShipping } = {}) {
  const approving = itemIds?.length ? items.filter((i) => itemIds.includes(i.id)) : items;
  const partial = !!(itemIds?.length && approving.length < items.length);
  if (partial) {
    return { amount: round2(approving.reduce((s, i) => s + i.line_total, 0)), partial: true, adjustedShipping: null };
  }
  let amount = total, adjustedShipping = null;
  if (actualShipping != null && shippingCost != null) {
    const capped = Math.min(Math.max(0, actualShipping), shippingCost);   // down-only, never below 0
    amount = round2(total - (shippingCost - capped));
    adjustedShipping = round2(capped);
  }
  return { amount: round2(amount), partial: false, adjustedShipping };
}

export class PriceError extends Error {}
