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

// A started-but-never-finished upload reserves a slot at init (so a visitor can't
// kick off unlimited uploads), and that reservation is correct while the upload is
// in flight. But an 'initialized' row whose upload never completes — a failed
// direct-to-cloud PUT, a closed tab — would hold that slot forever, counting
// against a limit the customer can't see or clear (the file list only shows
// uploaded/validated/processing). So before counting, release any initialized
// upload old enough to be certainly abandoned. The window is generous so a
// genuinely slow large upload still in progress is never reaped.
export function reapAbandoned(ownerToken) {
  db.prepare(
    `UPDATE files SET status='rejected', reject_reason='abandoned'
      WHERE owner_token = ? AND order_id IS NULL AND status='initialized'
        AND created_at < datetime('now','-1 day')`
  ).run(ownerToken);
}

export function draftFileCount(ownerToken) {
  return db.prepare(
    `SELECT COUNT(*) c FROM files
      WHERE owner_token = ? AND status != 'rejected' AND order_id IS NULL`
  ).get(ownerToken).c;
}

// Returns null when there is room, or a ready-to-send error when there isn't.
export function fileLimitError(ownerToken) {
  reapAbandoned(ownerToken);            // release slots held by dead uploads first
  const used = draftFileCount(ownerToken);
  if (used < config.uploads.maxFiles) return null;
  return {
    error: `Up to ${config.uploads.maxFiles} photos per order.`,
    code: 'MAX_FILES',
    used,
    limit: config.uploads.maxFiles,
  };
}
