import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { loadCatalog } from '../lib/catalog.js';
import { priceOrder, finalizeTotals, PriceError } from '../lib/pricing.js';
import { tax } from '../adapters/misc.js';

export const priceRouter = Router();

const ItemSchema = z.object({
  fileId: z.string().optional(),
  paper: z.string(),
  size: z.string(),
  border: z.enum(['none', 'border']).default('none'),
  qty: z.number().int().positive().default(1),
  colorPath: z.enum(['none', 'studio', 'self']).default('none'),
});
const QuoteSchema = z.object({
  items: z.array(ItemSchema).min(1),
  shipMethod: z.string().optional(),
  address: z.object({ state: z.string().optional(), zip: z.string().optional() }).partial().optional(),
});

// POST /api/price/quote — the display total AND the number that will be charged
// are computed here. DPI flags come from stored file metadata, not the client.
priceRouter.post('/quote', async (req, res) => {
  const parsed = QuoteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid quote request', details: parsed.error.flatten() });
  const { items, shipMethod, address } = parsed.data;

  const fileIds = items.map((i) => i.fileId).filter(Boolean);
  const files = fileIds.length
    ? db.prepare(`SELECT * FROM files WHERE id IN (${fileIds.map(() => '?').join(',')})`).all(...fileIds)
    : [];

  try {
    const cat = loadCatalog();
    const quote = priceOrder(cat, items, files, shipMethod);
    const taxResult = await tax.quote({ printsTotal: quote.printsTotal, shippingCost: quote.shippingCost, address });
    res.json({ ...finalizeTotals(quote, taxResult.amount), taxStatus: taxResult.status });
  } catch (e) {
    if (e instanceof PriceError) return res.status(400).json({ error: e.message });
    throw e;
  }
});
