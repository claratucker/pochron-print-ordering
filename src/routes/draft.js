import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/index.js';
import { getOrSetDraftToken, readDraftToken } from '../lib/auth.js';

export const draftRouter = Router();

// The order is persisted server-side, updated on each meaningful change
// (client debounces). Stores references to already-uploaded files (never
// re-uploading), each photo's config, and the order-level white-label flag (§5).
const DraftSchema = z.object({
  items: z.array(z.object({
    fileId: z.string(),
    paper: z.string(),
    size: z.string(),
    border: z.enum(['none', 'border']).default('none'),
    qty: z.number().int().positive().default(1),
    colorPath: z.enum(['none', 'studio', 'self']).default('none'),
    adjust: z.record(z.number()).optional(),   // self-edit recipe
    posX: z.number().optional(),
    posY: z.number().optional(),
  })).default([]),
  whiteLabel: z.boolean().default(false),
  shipMethod: z.string().optional(),
});

// GET /api/draft — resume (same-device via cookie). Returns null if none.
draftRouter.get('/', (req, res) => {
  const token = readDraftToken(req);
  if (!token) return res.json({ draft: null });
  const row = db.prepare('SELECT data, updated_at FROM drafts WHERE token = ?').get(token);
  res.json({ draft: row ? { ...JSON.parse(row.data), updatedAt: row.updated_at } : null });
});

// PUT /api/draft — autosave.
draftRouter.put('/', (req, res) => {
  const token = getOrSetDraftToken(req, res);
  const parsed = DraftSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid draft', details: parsed.error.flatten() });
  db.prepare(
    `INSERT INTO drafts (token, data, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(token) DO UPDATE SET data = excluded.data, updated_at = datetime('now')`
  ).run(token, JSON.stringify(parsed.data));
  res.json({ saved: true });
});

// DELETE /api/draft — clear (e.g. after successful submit).
draftRouter.delete('/', (req, res) => {
  const token = readDraftToken(req);
  if (token) {
    db.prepare('DELETE FROM drafts WHERE token = ?').run(token);
    // Release the files too, or the visitor keeps consuming their per-order
    // allowance for photos they have explicitly discarded. Files already
    // attached to a placed order are left alone — those are the studio's record.
    db.prepare(
      `UPDATE files SET status='rejected', reject_reason='draft_cleared'
        WHERE owner_token = ? AND order_id IS NULL AND status != 'rejected'`
    ).run(token);
  }
  res.json({ cleared: true });
});
