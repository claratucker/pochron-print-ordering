#!/usr/bin/env node
// Clear test/beta data: all orders, their uploaded files and rendered derivatives
// (in R2 or local disk), drafts, the email log, and connector tokens. The editable
// catalog — papers, sizes, prices, shipping, volume tiers, settings — is LEFT ALONE.
//
// Safeguards: backs up the database first, prints exactly what it will remove, and
// requires you to type RESET to proceed (or pass --yes to skip the prompt).
//
//   node scripts/reset-test-data.js
//   node scripts/reset-test-data.js --yes    (non-interactive)
//
// This is a maintenance tool, run from the command line — deliberately NOT exposed
// anywhere in the studio, so it can never be triggered by accident.

import 'dotenv/config';
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { db, DATA_DIR } from '../src/db/index.js';
import { storage } from '../src/adapters/storage.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const YES = process.argv.includes('--yes');

// The order/test data to clear. Order matters for foreign keys: children first.
const WIPE = ['order_events', 'order_messages', 'order_items', 'orders', 'files', 'drafts', 'email_log', 'connector_tokens'];

function count(table) {
  try { return db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c; } catch { return 0; }
}

async function main() {
  const counts = Object.fromEntries(WIPE.map((t) => [t, count(t)]));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  // Storage keys to delete: originals + rendered edit/print derivatives.
  const keys = new Set();
  for (const r of db.prepare('SELECT storage_key FROM files WHERE storage_key IS NOT NULL').all()) keys.add(r.storage_key);
  for (const r of db.prepare('SELECT edit_preview_key, print_file_key FROM order_items').all()) {
    if (r.edit_preview_key) keys.add(r.edit_preview_key);
    if (r.print_file_key) keys.add(r.print_file_key);
  }

  console.log('\nThis will permanently remove:');
  for (const t of WIPE) console.log(`  ${String(counts[t]).padStart(5)}  ${t}`);
  console.log(`  ${String(keys.size).padStart(5)}  stored objects (${storage.name === 's3' ? 'R2' : 'local disk'})`);
  console.log('\nIt will KEEP: papers, sizes, prices, shipping methods, volume tiers, settings.\n');

  if (total === 0 && keys.size === 0) { console.log('Nothing to clear — already empty.\n'); process.exit(0); }

  // Back up the database first (reversible).
  const backupDir = join(DATA_DIR, 'backups');
  mkdirSync(backupDir, { recursive: true });
  const dbPath = join(DATA_DIR, 'pochron.db');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = join(backupDir, `pochron-before-reset-${stamp}.db`);
  if (existsSync(dbPath)) { copyFileSync(dbPath, backup); console.log(`Backed up database to ${backup}\n`); }

  if (!YES) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((res) => rl.question('Type RESET to proceed (anything else cancels): ', res));
    rl.close();
    if (answer.trim() !== 'RESET') { console.log('\nCancelled. Nothing was changed.\n'); process.exit(0); }
  }

  // Delete stored objects (best effort — a missing object is fine).
  let removed = 0, failed = 0;
  for (const key of keys) {
    try { await storage.remove(key); removed++; }
    catch (e) { failed++; console.error(`  could not remove ${key}: ${e.message}`); }
  }

  // Wipe the tables in one transaction.
  const tx = db.transaction(() => { for (const t of WIPE) db.prepare(`DELETE FROM ${t}`).run(); });
  tx();

  console.log(`\nDone. Removed ${removed} stored objects${failed ? ` (${failed} failed)` : ''} and cleared ${total} rows.`);
  console.log(`Database backup kept at ${backup}\n`);
  process.exit(0);
}

main().catch((e) => { console.error('Reset failed:', e.message); process.exit(1); });
