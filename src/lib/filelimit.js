// The per-order file limit (§4).
//
// "Up to 12 photos per order" means per ORDER, not per lifetime. Files are
// stamped with an order_id once an order is placed, so anything already
// attached belongs to a finished order and must not count against the draft
// the visitor is building now.
//
// Getting this wrong is silent and gets worse over time: it works for a new
// visitor, then blocks a returning customer on their second order with a
// message that makes no sense to them. It lived in three separate routes, so
// it lives here now instead.

import { db } from '../db/index.js';
import { config } from '../config.js';

export function draftFileCount(ownerToken) {
  // A file counts toward the per-order limit if it's a real, visible photo
  // (uploaded/validated/processing) OR an upload that is genuinely still in flight
  // — an 'initialized' reservation younger than the window below. A reservation
  // whose upload died (a failed direct-to-cloud PUT, a closed tab) goes stale and
  // stops counting, so it can't silently hold a slot the customer never sees. We
  // never delete the row here: if that upload is somehow still finishing, it will
  // just become 'validated' and count again. Fresh reservations still count, so the
  // 12-file cap can't be raced by firing off many inits at once.
  return db.prepare(
    `SELECT COUNT(*) c FROM files
      WHERE owner_token = ? AND order_id IS NULL
        AND ( status IN ('uploaded','validated','processing')
              OR (status = 'initialized' AND created_at > datetime('now','-15 minutes')) )`
  ).get(ownerToken).c;
}

// Returns null when there is room, or a ready-to-send error when there isn't.
export function fileLimitError(ownerToken) {
  const used = draftFileCount(ownerToken);
  if (used < config.uploads.maxFiles) return null;
  return {
    error: `Up to ${config.uploads.maxFiles} photos per order.`,
    code: 'MAX_FILES',
    used,
    limit: config.uploads.maxFiles,
  };
}
