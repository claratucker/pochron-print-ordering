import { db } from './index.js';
import {
  PAPERS, PAPER_DESC, SIZES, PRICES, SHIP_METHODS, VOLUME, SETTINGS,
} from '../catalog-defaults.js';

// Idempotent seed of the editable catalog. Existing edited rows are preserved
// unless --force is passed (which resets the catalog to the sheet defaults).
const force = process.argv.includes('--force');

const seed = db.transaction(() => {
  if (force) {
    for (const t of ['papers', 'sizes', 'prices', 'shipping_methods', 'volume_tiers', 'settings']) {
      db.prepare(`DELETE FROM ${t}`).run();
    }
  }

  const paper = db.prepare(
    `INSERT OR IGNORE INTO papers (id,label,fam,descr,sort) VALUES (?,?,?,?,?)`
  );
  PAPERS.forEach((p, i) => paper.run(p.id, p.label, p.fam, PAPER_DESC[p.id] || '', i));

  const size = db.prepare(`INSERT OR IGNORE INTO sizes (size,sort) VALUES (?,?)`);
  SIZES.forEach((s, i) => size.run(s, i));

  const price = db.prepare(`INSERT OR IGNORE INTO prices (fam,size,price) VALUES (?,?,?)`);
  for (const fam of Object.keys(PRICES)) {
    for (const [s, v] of Object.entries(PRICES[fam])) price.run(fam, s, v);
  }

  const ship = db.prepare(
    `INSERT OR IGNORE INTO shipping_methods (id,label,cost,sort) VALUES (?,?,?,?)`
  );
  SHIP_METHODS.forEach((m, i) => ship.run(m.id, m.label, m.cost, i));

  const vol = db.prepare(
    `INSERT OR IGNORE INTO volume_tiers (min_qty,rate,label) VALUES (?,?,?)`
  );
  VOLUME.forEach((v) => vol.run(v.min, v.rate, v.label));

  const setting = db.prepare(`INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)`);
  for (const [k, v] of Object.entries(SETTINGS)) setting.run(k, String(v));
});

seed();
const n = db.prepare('SELECT COUNT(*) c FROM prices').get().c;
console.log(`✓ Catalog seeded (${n} price rows${force ? ', forced reset' : ''}).`);
