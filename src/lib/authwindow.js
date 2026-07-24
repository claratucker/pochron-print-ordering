// How long is left on a card authorization (§9).
//
// The studio's promise is that nothing is charged until a human approves it.
// The cost of that promise is a clock: an authorization is a temporary hold,
// not money in the bank, and issuers release it after roughly a week. An order
// that sits in the queue past that window cannot be captured — the work is
// still wanted, the funds simply are not reserved any more.
//
// So the age of every authorization is computed and surfaced, and the studio is
// warned BEFORE it lapses rather than discovering it at capture time.

import { config } from '../config.js';

export function authWindow(order) {
  const started = order?.authorized_at || order?.created_at;
  if (!started || !order?.payment_ref) return { status: 'none' };

  // SQLite stores UTC without a zone marker; make that explicit before parsing.
  const startedMs = Date.parse(String(started).replace(' ', 'T') + 'Z');
  if (Number.isNaN(startedMs)) return { status: 'none' };

  const ageDays = (Date.now() - startedMs) / 86400000;
  const windowDays = config.payment.authWindowDays;
  const daysLeft = +(windowDays - ageDays).toFixed(2);

  // Already captured or voided? The clock is irrelevant.
  if (['captured', 'partially_captured', 'voided', 'failed'].includes(order.payment_status)) {
    return { status: 'settled', ageDays: +ageDays.toFixed(2), daysLeft };
  }

  const status = daysLeft <= 0 ? 'expired'
    : ageDays >= config.payment.authWarnDays ? 'expiring'
    : 'ok';

  return {
    status,
    ageDays: +ageDays.toFixed(2),
    daysLeft,
    expiresAt: new Date(startedMs + windowDays * 86400000).toISOString(),
    reauthCount: order.reauth_count || 0,
  };
}

// Plain-language line for the studio queue.
export function authLabel(w) {
  if (w.status === 'expired') return 'Authorization expired — re-authorize before printing';
  if (w.status === 'expiring') {
    const h = Math.max(0, Math.round(w.daysLeft * 24));
    return h <= 48 ? `Authorization expires in ~${h}h` : `Authorization expires in ~${Math.round(w.daysLeft)} days`;
  }
  return null;
}
