import { db } from '../db/index.js';

// Reads the editable catalog out of the DB. This is what both the pricing
// engine and the public GET /api/catalog serve, so the client never hardcodes
// prices again (§7).
export function loadCatalog() {
  const papers = db.prepare('SELECT id,label,fam,descr FROM papers ORDER BY sort').all();
  const sizes = db.prepare('SELECT size FROM sizes ORDER BY sort').all().map((r) => r.size);
  const priceRows = db.prepare('SELECT fam,size,price FROM prices').all();
  const shipping = db.prepare('SELECT id,label,cost FROM shipping_methods ORDER BY sort').all();
  const volume = db.prepare('SELECT min_qty,rate,label FROM volume_tiers ORDER BY min_qty DESC').all()
    .map((r) => ({ min: r.min_qty, rate: r.rate, label: r.label }));
  const settingsRows = db.prepare('SELECT key,value FROM settings').all();

  const prices = {};
  for (const r of priceRows) {
    (prices[r.fam] ||= {})[r.size] = r.price;
  }
  const settings = {};
  for (const r of settingsRows) settings[r.key] = Number(r.value);

  const paperById = Object.fromEntries(papers.map((p) => [p.id, p]));

  return {
    papers, paperById, sizes, prices, shipping, volume,
    borders: { none: { label: 'No border (fills the print)', add: 0 },
               border: { label: 'White border (fits the whole image)', add: 0 } },
    ccAdd: settings.cc_add ?? 15,
    dpiGood: settings.dpi_good ?? 240,
    dpiMin: settings.dpi_min ?? 180,
    pxPerIn: settings.px_per_in ?? 6.6,
  };
}
