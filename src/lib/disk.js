// Disk headroom (§13 operational safety).
//
// With STORAGE_DRIVER=local the originals share a volume with the SQLite
// database. Multi-GB scans can fill it quickly, and a full disk doesn't just
// fail uploads — SQLite cannot write, which risks the order records themselves.
// So uploads are refused while there is still room to operate, and the customer
// is told to contact the studio rather than shown a random failure.
//
// This is a stopgap for local storage. With S3/R2 the originals never touch
// this volume and only the (tiny) database does.

import { statfs } from 'node:fs/promises';
import { config } from '../config.js';

export async function diskStatus(path) {
  try {
    const s = await statfs(path);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return {
      available: true,
      totalBytes: total,
      freeBytes: free,
      usedPct: total ? +(((total - free) / total) * 100).toFixed(1) : null,
    };
  } catch {
    return { available: false };   // unsupported platform — never block on this
  }
}

// Is there room for a file of `sizeBytes`, keeping a reserve free?
export async function hasRoomFor(sizeBytes, path) {
  if (config.storage.driver !== 'local') return { ok: true };   // originals go to the cloud
  const d = await diskStatus(path);
  if (!d.available) return { ok: true };
  // Fall back to a sane reserve if unset — an undefined comparison would
  // silently block every upload.
  const reserve = Number(config.uploads.diskReserveBytes) || 3221225472;
  const ok = d.freeBytes - Number(sizeBytes || 0) > reserve;
  return { ok, freeBytes: d.freeBytes, reserve, usedPct: d.usedPct };
}
