import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { loadCatalog } from '../lib/catalog.js';
import { priceOrder, finalizeTotals, PriceError } from '../lib/pricing.js';
import { tax } from '../adapters/misc.js';
import { payment } from '../adapters/payment.js';
import { emails } from '../adapters/email.js';
import { newRef, getOrderByRef } from '../lib/orders.js';
import { readDraftToken } from '../lib/auth.js';

export const ordersRouter = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Normalized self-edit recipe (from the browser editor, mapped in the client).
// passthrough() keeps any extra editor fields without failing validation; the
// server render only reads the known keys.
const RecipeSchema = z
  .object({
    crop: z
      .object({ left: z.number(), top: z.number(), width: z.number(), height: z.number() })
      .partial()
      .optional(),
    rotate: z.number().optional(),
    straighten: z.number().optional(),
    flipX: z.boolean().optional(),
    flipY: z.boolean().optional(),
    brightness: z.number().optional(),
    saturation: z.number().optional(),
    contrast: z.number().optional(),
    warmth: z.number().optional(),
  })
  .passthrough();

const ItemSchema = z.object({
  fileId: z.string(),
  paper: z.string(),
  size: z.string(),
  border: z.enum(['none', 'border']).default('none'),
  qty: z.number().int().positive().default(1),
  colorPath: z.enum(['none', 'studio', 'self']).default('none'),
  adjust: RecipeSchema.optional(),
  posX: z.number().optional(),
  posY: z.number().optional(),
});
const OrderSchema = z.object({
  items: z.array(ItemSchema).min(1),
  contact: z.object({
    name: z.string().min(1, 'your name'),
    email: z.string().min(1, 'your email'),
    phone: z.string().optional(),
  }),
  shipping: z.object({
    name: z.string().optional(),
    addr1: z.string().min(1, 'a street address'),
    addr2: z.string().optional(),
    city: z.string().min(1, 'city'),
    state: z.string().min(1, 'state'),
    zip: z.string().min(1, 'ZIP'),
    country: z.string().default('United States'),
    method: z.string(),
  }),
  whiteLabel: z.boolean().default(false),
  lowResAck: z.boolean().default(false),
  paymentMethodId: z.string().optional(),   // Stripe pm_... (production)
});

// POST /api/orders — place the order. Authorize now, capture on approval (§6/§9).
ordersRouter.post('/', async (req, res) => {
  const parsed = OrderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Please complete the required fields.', details: parsed.error.flatten() });
  }
  const { items, contact, shipping, whiteLabel, lowResAck, paymentMethodId } = parsed.data;

  // Email format gate (layer 1 of §8; verification API + confirmation email are the stronger layers).
  if (!EMAIL_RE.test(contact.email)) {
    return res.status(400).json({ error: "That email address doesn't look right. Please double-check it.", field: 'email' });
  }

  // Load the real files + recompute the price SERVER-SIDE. The client total is never trusted.
  const fileIds = items.map((i) => i.fileId);
  const files = db.prepare(
    `SELECT * FROM files WHERE id IN (${fileIds.map(() => '?').join(',')})`
  ).all(...fileIds);
  const foundIds = new Set(files.map((f) => f.id));
  const missing = fileIds.filter((id) => !foundIds.has(id));
  if (missing.length) return res.status(409).json({ error: 'Some uploads are missing or not yet validated.', missing });

  let quote;
  try {
    const cat = loadCatalog();
    const q = priceOrder(cat, items, files, shipping.method);

    // Low-res acknowledgment gate — any too-small image requires explicit ack (§4).
    if (q.anyTooSmall && !lowResAck) {
      return res.status(422).json({
        error: 'Please confirm the low-resolution image(s) before submitting.',
        code: 'NEEDS_LOWRES_ACK',
      });
    }
    // 100+ prints → manual quote, not a self-serve charge (§7).
    if (q.manualQuote) {
      return res.status(422).json({
        error: 'Orders of 100+ prints are custom-quoted. Please contact the studio.',
        code: 'MANUAL_QUOTE', studio: config.email.studioContactUrl,
      });
    }
    const taxAmount = await tax.quote({ printsTotal: q.printsTotal, shippingCost: q.shippingCost, address: shipping });
    quote = finalizeTotals(q, taxAmount);
  } catch (e) {
    if (e instanceof PriceError) return res.status(400).json({ error: e.message });
    throw e;
  }

  const ref = newRef();

  // Authorize payment (auth now, capture on approval).
  let auth;
  try {
    auth = await payment.authorize({ amount: quote.total, email: contact.email, orderRef: ref, paymentMethodId });
  } catch (e) {
    return res.status(402).json({ error: 'Payment could not be authorized.', detail: e.message });
  }

  // Persist order + items atomically, then map file metadata onto each line.
  const fileById = Object.fromEntries(files.map((f) => [f.id, f]));
  const tx = db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO orders
        (ref,status,customer_name,email,phone,
         ship_name,ship_addr1,ship_addr2,ship_city,ship_state,ship_zip,ship_country,ship_method,
         white_label,low_res_ack,subtotal,discount_rate,discount_amount,shipping_cost,tax,total,
         payment_ref,payment_status)
       VALUES (?, 'submitted', ?,?,?, ?,?,?,?,?,?,?,?, ?,?, ?,?,?,?,?,?, ?,?)`
    ).run(
      ref, contact.name, contact.email, contact.phone || null,
      shipping.name || contact.name, shipping.addr1, shipping.addr2 || null,
      shipping.city, shipping.state, shipping.zip, shipping.country || 'United States', shipping.method,
      whiteLabel ? 1 : 0, lowResAck ? 1 : 0,
      quote.subtotal, quote.discountRate, quote.discountAmount, quote.shippingCost, quote.tax, quote.total,
      auth.paymentRef, auth.status === 'authorized' || auth.status === 'requires_capture' ? 'authorized' : auth.status
    );
    const orderId = info.lastInsertRowid;

    const insItem = db.prepare(
      `INSERT INTO order_items
        (order_id,file_id,original_name,paper,size,border,qty,color_path,adjust_recipe,pos_x,pos_y,
         unit_price,cc_fee,line_total,width,height,dpi,dpi_flag)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?,?,?)`
    );
    quote.lines.forEach((l, idx) => {
      const it = items[idx];
      const f = fileById[it.fileId];
      insItem.run(
        orderId, it.fileId, f.original_name, l.paper, l.size, l.border, l.qty, l.colorPath,
        // Store BOTH the edit recipe and the original ref for every photo (§6).
        it.colorPath === 'self' ? JSON.stringify(it.adjust || {}) : null,
        it.posX ?? 50, it.posY ?? 50,
        l.unitPrice, l.ccFee, l.lineTotal, l.width, l.height, l.dpi, l.dpiFlag
      );
    });

    db.prepare(`INSERT INTO order_events (order_id,from_status,to_status,note) VALUES (?,?, 'submitted', 'Order placed; payment authorized')`).run(orderId, 'draft');
    db.prepare(`UPDATE files SET order_id = ? WHERE id IN (${fileIds.map(() => '?').join(',')})`).run(orderId, ...fileIds);
    return orderId;
  });
  const orderId = tx();

  // Confirmation email — includes a copy of the submission; a bounce flags the order (§8/§11).
  const order = getOrderByRef(ref);
  try { await emails.confirmation(order); } catch (e) { console.error('Confirmation email failed:', e.message); }

  // Clear the guest draft now that it's submitted.
  const token = readDraftToken(req);
  if (token) db.prepare('DELETE FROM drafts WHERE token = ?').run(token);

  res.status(201).json({
    ref, orderId, status: 'submitted',
    total: quote.total, paymentStatus: 'authorized',
    message: 'Order received. We emailed a copy to ' + contact.email + '.',
  });
});

// GET /api/orders/:ref?email=... — customer status lookup (guarded by email match).
ordersRouter.get('/:ref', (req, res) => {
  const order = getOrderByRef(req.params.ref);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  const email = (req.query.email || '').toString().toLowerCase();
  if (!email || email !== (order.email || '').toLowerCase()) {
    return res.status(403).json({ error: 'Provide the email on the order to view it.' });
  }
  res.json(publicView(order));
});

function publicView(o) {
  return {
    ref: o.ref, status: o.status, total: o.total,
    items: o.items.map((i) => ({
      name: i.original_name, paper: i.paper, size: i.size, qty: i.qty,
      colorPath: i.color_path, lineTotal: i.line_total, status: i.item_status,
    })),
    tracking: o.tracking, createdAt: o.created_at,
    messages: o.messages.filter((m) => m.direction !== 'system').map((m) => ({ from: m.direction, body: m.body, at: m.created_at })),
  };
}
