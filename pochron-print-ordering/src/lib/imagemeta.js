// Extract real pixel dimensions, embedded color profile, and bit depth from an
// uploaded file (§4). These power the server-side DPI warnings — computed from
// real file data, never trusted from the client. Uses sharp; degrades safely if
// sharp isn't available or the format is unreadable.

let sharp = null;
try { ({ default: sharp } = await import('sharp')); } catch { /* optional */ }

export async function extractMeta(buffer) {
  if (!sharp) return { width: null, height: null, colorProfile: null, bitDepth: null, ok: false };
  try {
    const m = await sharp(buffer, { limitInputPixels: false }).metadata();
    return {
      width: m.width ?? null,
      height: m.height ?? null,
      // sharp exposes ICC presence via `icc`/`hasProfile`; report space + profile hint.
      colorProfile: m.icc ? (m.space ? `${m.space} (ICC embedded)` : 'ICC embedded')
                          : (m.space || null),
      bitDepth: depthToBits(m.depth),
      ok: true,
    };
  } catch (e) {
    return { width: null, height: null, colorProfile: null, bitDepth: null, ok: false, error: e.message };
  }
}

// Header-only variant for very large files: sharp reads dimensions/profile from
// the leading bytes without decoding the whole image. JPEG/PNG carry dimensions
// early, so a few MB is plenty; some TIFF/PSD layouts put the IFD elsewhere, in
// which case this returns ok:false and the caller defers to a background pass.
export async function extractMetaFromHeader(headerBuffer) {
  const meta = await extractMeta(headerBuffer);
  if (!meta.ok || meta.width == null) return { ...meta, ok: false, deferred: true };
  return { ...meta, partial: true };
}

function depthToBits(depth) {
  const map = { uchar: 8, char: 8, ushort: 16, short: 16, uint: 32, int: 32, float: 32, double: 64 };
  return map[depth] ?? null;
}

export const sharpAvailable = !!sharp;
