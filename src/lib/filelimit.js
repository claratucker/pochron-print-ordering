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
  return db.prepare(
    `SELECT COUNT(*) c FROM files
      WHERE owner_token = ? AND status != 'rejected' AND order_id IS NULL`
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
