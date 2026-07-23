import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { config } from '../config.js';
import { requireStudio } from '../lib/auth.js';
import { payment } from '../adapters/payment.js';
import { emails } from '../adapters/email.js';
import { getOrder, transition, addMessage } from '../lib/orders.js';
import { storage } from '../adapters/storage.js';
import { renderRecipe, recipeIsNoop } from '../lib/render.js';

// Render one self-edited item's recipe onto the full-res ORIGINAL and store the
// print-ready file. Returns { itemId, printUrl } or null when nothing to render
// (studio-corrected or as-submitted items print straight from the original).
async function renderPrintFile(item) {
  if (item.color_path !== 'self') return null;
  const recipe = item.adjust_recipe ? JSON.parse(item.adjust_recipe) : {};
  if (recipeIsNoop(recipe)) return null;
  const file = db.prepare('SELECT storage_key FROM files WHERE id=?').get(item.file_id);
  if (!file) return null;
  const original = await storage.getBuffer(file.storage_key);
  if (!original) return null;
  const outBuf = await renderRecipe(original, recipe, { format: 'tiff' });
  const key = `${item.file_id}/print/item-${item.id}.tiff`;
  await storage.writeDerived(key, outBuf);
  db.prepare('UPDATE order_items SET print_file_key=? WHERE id=?').run(key, item.id);
  return { itemId: item.id, printUrl: storage.publicUrl(key) };
}

export const studioRouter = Router();
studioRouter.use(requireStudio);   // every studio route is authenticated

// GET /api/studio/queue — orders awaiting proof, plus recent history.
studioRouter.get('/queue', (req, res) => {
  const rows = db.prepare(
    `SELECT id, ref, status, customer_name, email, white_label, white_label_name, total, created_at
       FROM orders ORDER BY (status IN ('submitted','on_hold')) DESC, created_at DESC LIMIT 100`
  ).all();
  const pending = rows.filter((o) => o.status === 'submitted' || o.status === 'on_hold').length;
  const queue = rows.map((o) => {
    const full = getOrder(o.id);
    return {
      id: o.id, ref: o.ref, status: o.status, who: o.customer_name, email: o.email,
      whiteLabel: !!o.white_label, total: o.total, createdAt: o.created_at,
      // The address that goes on the parcel: neutral for white-label (§10).
      whiteLabelName: o.white_label_name || null,
      // White-label parcels ship under the CUSTOMER's business name at the
      // studio's drop address — no Pochron branding (§10).
      returnAddress: o.white_label
        ? `${o.white_label_name || 'Sender'}\n${config.fulfillment.dropAddress}`
        : config.fulfillment.studioReturnAddress,
      items: full.items.map((i) => ({
        id: i.id, name: i.original_name, paper: i.paper, size: i.size, qty: i.qty,
        colorPath: i.color_path,               // none | studio | self
        adjust: i.adjust_recipe ? JSON.parse(i.adjust_recipe) : null,
        px: i.width && i.height ? `${i.width}×${i.height}` : null,
        dpi: i.dpi, dpiFlag: i.dpi_flag, lineTotal: i.line_total,
        itemStatus: i.item_status,
        // Studio path prints from the ORIGINAL; self-edit stores recipe + original (§6).
        originalUrl: i.file_id ? storage.publicUrl(
          db.prepare('SELECT storage_key FROM files WHERE id=?').get(i.file_id)?.storage_key || ''
        ) : null,
      })),
      messages: full.messages,
    };
  });
  res.json({ pending, total: rows.length, queue });
});

// GET /api/studio/orders/:id — full order detail.
studioRouter.get('/orders/:id', (req, res) => {
  const order = getOrder(+req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  res.json(order);
});

// POST /api/studio/orders/:id/approve — approve & print → CAPTURE payment (§9).
// Optional body { itemIds: [...] } approves only some photos and captures a
// partial amount; the rest stay held.
const ApproveSchema = z.object({ itemIds: z.array(z.number()).optional() });
studioRouter.post('/orders/:id/approve', async (req, res) => {
  const order = getOrder(+req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  const ap = ApproveSchema.safeParse(req.body || {});
  if (!ap.success) return res.status(400).json({ error: 'Invalid approval request.', details: ap.error.flatten() });
  const { itemIds } = ap.data;

  const approving = itemIds?.length ? order.items.filter((i) => itemIds.includes(i.id)) : order.items;
  if (!approving.length) return res.status(400).json({ error: 'No matching items to approve.' });

  const partial = itemIds?.length && approving.length < order.items.length;
  // Amount to capture: sum of approved line totals + a proportional share of
  // shipping/tax on full approval. On partials we capture just the print lines
  // and settle shipping/tax when the order fully approves.
  const lineSum = approving.reduce((s, i) => s + i.line_total, 0);
  const captureAmount = partial
    ? +lineSum.toFixed(2)
    : order.total;

  let cap;
  try {
    cap = await payment.capture({ paymentRef: order.payment_ref, amount: partial ? captureAmount : undefined });
  } catch (e) {
    return res.status(402).json({ error: 'Capture failed. The authorization may have expired — re-authorize the customer.', detail: e.message, code: 'CAPTURE_FAILED' });
  }

  const tx = db.transaction(() => {
    approving.forEach((i) =>
      db.prepare(`UPDATE order_items SET item_status='approved', captured_amount=? WHERE id=?`)
        .run(+(i.line_total).toFixed(2), i.id));
    const remaining = db.prepare(`SELECT COUNT(*) c FROM order_items WHERE order_id=? AND item_status!='approved'`).get(order.id).c;
    if (remaining === 0) {
      db.prepare(`UPDATE orders SET payment_status='captured', updated_at=datetime('now') WHERE id=?`).run(order.id);
      transition(order.id, 'approved', `Approved; captured ${cap.capturedAmount ?? order.total}`);
      db.prepare(`UPDATE orders SET status='in_production' WHERE id=?`).run(order.id);
    } else {
      db.prepare(`UPDATE orders SET payment_status='partially_captured' WHERE id=?`).run(order.id);
      transition(order.id, 'on_hold', `Partial approval; ${remaining} item(s) still held`);
    }
  });
  tx();

  // For each approved self-edit, generate the print-ready file from the original
  // + recipe (§6). Failures here don't undo the capture — they surface as a note.
  const rendered = [];
  for (const i of approving) {
    try { const r = await renderPrintFile(i); if (r) rendered.push(r); }
    catch (e) { addMessage(order.id, 'system', `Print render failed for item ${i.id}: ${e.message}`); }
  }

  const fresh = getOrder(order.id);
  try { if (fresh.status === 'in_production' || fresh.status === 'approved') await emails.approved(fresh, cap.capturedAmount ?? order.total); }
  catch (e) { console.error('Approved email failed:', e.message); }

  res.json({ ref: order.ref, status: getOrder(order.id).status, captured: cap.capturedAmount ?? captureAmount, partial, printFiles: rendered });
});

// POST /api/studio/orders/:id/items/:itemId/render — (re)generate a self-edit's
// print-ready file on demand, e.g. to preview the rendered result before approving.
studioRouter.post('/orders/:id/items/:itemId/render', async (req, res) => {
  const order = getOrder(+req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  const item = order.items.find((i) => i.id === +req.params.itemId);
  if (!item) return res.status(404).json({ error: 'Item not found.' });
  if (item.color_path !== 'self')
    return res.json({ itemId: item.id, printUrl: item.originalUrl, note: 'Prints directly from the original (no self-edit recipe).' });
  try {
    const r = await renderPrintFile(item);
    if (!r) return res.json({ itemId: item.id, note: 'Recipe is empty — prints from the original.' });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: 'Render failed.', detail: e.message });
  }
});

// POST /api/studio/orders/:id/hold — message the customer, move to on_hold (§6).
const HoldSchema = z.object({ message: z.string().min(1) });
studioRouter.post('/orders/:id/hold', async (req, res) => {
  const order = getOrder(+req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  const parsed = HoldSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Write a message for the customer before placing the order on hold.' });
  const { message } = parsed.data;

  addMessage(order.id, 'studio_to_customer', message);
  transition(order.id, 'on_hold', 'Studio messaged customer');
  try { await emails.hold(order, message); } catch (e) { console.error('Hold email failed:', e.message); }
  res.json({ ref: order.ref, status: 'on_hold' });
});

// POST /api/studio/orders/:id/ship — mark shipped with tracking, notify.
const ShipSchema = z.object({ tracking: z.string().optional() });
studioRouter.post('/orders/:id/ship', async (req, res) => {
  const order = getOrder(+req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  const sp = ShipSchema.safeParse(req.body || {});
  if (!sp.success) return res.status(400).json({ error: 'Invalid ship request.', details: sp.error.flatten() });
  const { tracking } = sp.data;
  db.prepare(`UPDATE orders SET tracking=?, updated_at=datetime('now') WHERE id=?`).run(tracking || null, order.id);
  transition(order.id, 'shipped', tracking ? `Shipped: ${tracking}` : 'Shipped');
  try { await emails.shipped(getOrder(order.id), tracking); } catch (e) { console.error('Shipped email failed:', e.message); }
  res.json({ ref: order.ref, status: 'shipped', tracking: tracking || null });
});

// POST /api/studio/orders/:id/reauthorize — for slow proofs past the auth window (§9).
studioRouter.post('/orders/:id/reauthorize', async (req, res) => {
  const order = getOrder(+req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  addMessage(order.id, 'system', 'Re-authorization requested (authorization expired).');
  // In production: create a fresh PaymentIntent and email the customer a link to re-confirm.
  res.json({ ref: order.ref, note: 'Re-authorization flow stubbed — create a new auth and email the customer to re-confirm.' });
});
