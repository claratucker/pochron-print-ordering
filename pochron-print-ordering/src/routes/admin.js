import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { requireAdmin } from '../lib/auth.js';
import { loadCatalog } from '../lib/catalog.js';

export const adminRouter = Router();
adminRouter.use(requireAdmin);

// GET /api/admin/catalog — current editable catalog.
adminRouter.get('/catalog', (req, res) => res.json(loadCatalog()));

// PUT /api/admin/catalog — update prices / shipping / volume tiers / settings.
// So Pochron Studios can change prices, add sizes, or adjust tiers without a
// developer (§7). Partial updates allowed; only provided sections are touched.
const CatalogPatch = z.object({
  prices: z.record(z.record(z.number())).optional(),          // { fam: { size: price } }
  shipping: z.array(z.object({ id: z.string(), label: z.string(), cost: z.number() })).optional(),
  volume: z.array(z.object({ min: z.number(), rate: z.number().nullable(), label: z.string() })).optional(),
  settings: z.record(z.number()).optional(),                  // cc_add, dpi_good, dpi_min, px_per_in
  sizes: z.array(z.string()).optional(),
}).strict();

adminRouter.put('/catalog', (req, res) => {
  const parsed = CatalogPatch.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid catalog update', details: parsed.error.flatten() });
  const patch = parsed.data;

  const tx = db.transaction(() => {
    if (patch.prices) {
      const up = db.prepare(
        `INSERT INTO prices (fam,size,price) VALUES (?,?,?)
         ON CONFLICT(fam,size) DO UPDATE SET price = excluded.price`
      );
      for (const [fam, bySize] of Object.entries(patch.prices))
        for (const [size, price] of Object.entries(bySize)) up.run(fam, size, price);
    }
    if (patch.sizes) {
      const up = db.prepare(`INSERT OR IGNORE INTO sizes (size, sort) VALUES (?, ?)`);
      patch.sizes.forEach((s, i) => up.run(s, i));
    }
    if (patch.shipping) {
      const up = db.prepare(
        `INSERT INTO shipping_methods (id,label,cost,sort) VALUES (?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET label=excluded.label, cost=excluded.cost`
      );
      patch.shipping.forEach((m, i) => up.run(m.id, m.label, m.cost, i));
    }
    if (patch.volume) {
      db.prepare('DELETE FROM volume_tiers').run();
      const up = db.prepare(`INSERT INTO volume_tiers (min_qty,rate,label) VALUES (?,?,?)`);
      patch.volume.forEach((v) => up.run(v.min, v.rate, v.label));
    }
    if (patch.settings) {
      const up = db.prepare(
        `INSERT INTO settings (key,value) VALUES (?,?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      );
      for (const [k, v] of Object.entries(patch.settings)) up.run(k, String(v));
    }
  });
  tx();
  res.json({ saved: true, catalog: loadCatalog() });
});
