import crypto from 'node:crypto';
import { config } from '../config.js';

// ── Guest draft token (§5) ──────────────────────────────────────────
// Signed, httpOnly cookie so a guest can resume on the same device. Creating an
// account (Phase 3) upgrades this to cross-device recovery.
const COOKIE = 'ps_draft';

function sign(value) {
  const mac = crypto.createHmac('sha256', config.appSecret).update(value).digest('base64url');
  return `${value}.${mac}`;
}
function verify(signed) {
  if (!signed || !signed.includes('.')) return null;
  const i = signed.lastIndexOf('.');
  const value = signed.slice(0, i), mac = signed.slice(i + 1);
  const expected = crypto.createHmac('sha256', config.appSecret).update(value).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? value : null;
}

export function getOrSetDraftToken(req, res) {
  const existing = verify(req.cookies?.[COOKIE]);
  if (existing) return existing;
  const token = crypto.randomUUID();
  res.cookie(COOKIE, sign(token), {
    httpOnly: true, sameSite: 'lax',
    secure: config.env === 'production',
    maxAge: config.draftTtlDays * 86400 * 1000,
  });
  return token;
}
export function readDraftToken(req) {
  return verify(req.cookies?.[COOKIE]);
}

// ── Studio / admin gate ─────────────────────────────────────────────
// Simple bearer/basic password gate for the proofing queue + admin pricing.
// Accepts a bcrypt hash or a plaintext password in env (dev). In production put
// this behind real auth / SSO; the interface stays the same.
async function passwordMatches(supplied, configured) {
  if (!supplied || !configured) return false;
  if (configured.startsWith('$2')) {
    const { default: bcrypt } = await import('bcryptjs');
    return bcrypt.compare(supplied, configured);
  }
  const a = Buffer.from(supplied), b = Buffer.from(configured);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function extractPassword(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  if (h.startsWith('Basic ')) {
    try { return Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':'); }
    catch { return null; }
  }
  return req.headers['x-studio-password'] || req.query.password || null;
}

export function requireStudio(req, res, next) {
  passwordMatches(extractPassword(req), config.studioPassword)
    .then((ok) => ok ? next() : res.status(401).json({ error: 'Studio authentication required.' }))
    .catch(() => res.status(401).json({ error: 'Studio authentication required.' }));
}
export function requireAdmin(req, res, next) {
  passwordMatches(extractPassword(req), config.adminPassword)
    .then((ok) => ok ? next() : res.status(401).json({ error: 'Admin authentication required.' }))
    .catch(() => res.status(401).json({ error: 'Admin authentication required.' }));
}
