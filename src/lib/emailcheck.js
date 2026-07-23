// Email validity, layered (§8). A mistyped address is silent and expensive:
// the customer gets no confirmation, no hold message, no approval notice, and
// can't look up their order (lookup is guarded by the email on file). Meanwhile
// the studio holds an authorized card and has no way to reach them.
//
// Layer 1 — format check (regex, in the route)
// Layer 2 — typo suggestion: catch near-misses of common domains  ← here
// Layer 3 — verification API: does the mailbox actually exist?    ← here (seam)
// Layer 4 — confirmation email (already sent on submit)

import { config } from '../config.js';

// The domains that account for the overwhelming majority of consumer mail.
const COMMON_DOMAINS = [
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'hotmail.com',
  'outlook.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'comcast.net', 'verizon.net', 'att.net', 'proton.me', 'protonmail.com',
];
// Typos too close to catch by edit distance alone (TLD slips, mostly).
const EXACT_FIXES = {
  'gmail.co': 'gmail.com', 'gmail.cm': 'gmail.com', 'gmail.con': 'gmail.com',
  'gmail.comm': 'gmail.com', 'gmaill.com': 'gmail.com', 'gmial.com': 'gmail.com',
  'yahoo.co': 'yahoo.com', 'yahoo.con': 'yahoo.com',
  'hotmail.co': 'hotmail.com', 'hotmial.com': 'hotmail.com',
  'outlook.co': 'outlook.com', 'iclould.com': 'icloud.com', 'icloud.co': 'icloud.com',
};

// Damerau-Levenshtein (edit distance incl. transposition — 'gmial' → 'gmail').
function editDistance(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}

// Returns a corrected address if the domain looks like a near-miss, else null.
// Deliberately conservative: only suggests, never rewrites.
export function suggestEmailFix(email) {
  const at = String(email || '').lastIndexOf('@');
  if (at < 1) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1).toLowerCase().trim();
  if (!domain) return null;

  if (EXACT_FIXES[domain]) return `${local}@${EXACT_FIXES[domain]}`;
  if (COMMON_DOMAINS.includes(domain)) return null;      // already fine

  for (const candidate of COMMON_DOMAINS) {
    const dist = editDistance(domain, candidate);
    // 1 edit for short domains, 2 for longer ones — tight enough to avoid
    // "correcting" a legitimate small-business domain.
    const allowed = candidate.length > 9 ? 2 : 1;
    if (dist > 0 && dist <= allowed) return `${local}@${candidate}`;
  }
  return null;
}

// Layer 3 — does the mailbox exist? Providers: Kickbox, ZeroBounce, NeverBounce.
// Returns: 'deliverable' | 'undeliverable' | 'risky' | 'unknown'.
// 'unknown' must never block an order — a provider outage shouldn't stop sales.
export async function verifyEmail(email) {
  const { driver, apiKey } = config.emailVerify;
  if (driver === 'none' || !apiKey) return 'unknown';
  try {
    if (driver === 'kickbox') {
      const r = await fetch(`https://api.kickbox.com/v2/verify?email=${encodeURIComponent(email)}&apikey=${apiKey}`);
      const j = await r.json();
      if (j.result === 'deliverable') return 'deliverable';
      if (j.result === 'undeliverable') return 'undeliverable';
      return j.result === 'risky' ? 'risky' : 'unknown';
    }
    if (driver === 'zerobounce') {
      const r = await fetch(`https://api.zerobounce.net/v2/validate?api_key=${apiKey}&email=${encodeURIComponent(email)}`);
      const j = await r.json();
      if (j.status === 'valid') return 'deliverable';
      if (j.status === 'invalid') return 'undeliverable';
      return 'unknown';
    }
  } catch {
    return 'unknown';   // never block on a provider failure
  }
  return 'unknown';
}
