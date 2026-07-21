// Re-apply a self-edit recipe to the ORIGINAL at full resolution (§6).
//
// The browser editor (Filerobot) works on a downscaled proxy for responsiveness,
// so its rendered output is not print-quality. Instead we capture Filerobot's
// design state, normalize it into the small recipe below, keep it next to the
// retained original, and re-apply it here to the full-res file when the studio
// approves. The print therefore always derives from the original.
//
// Normalized recipe (all fields optional; safe defaults = no-op):
//   { crop:{left,top,width,height},  // in ORIGINAL pixels
//     rotate: 0|90|180|270,          // whole-turn orientation
//     straighten: -45..45,           // fine angle in degrees
//     flipX: bool, flipY: bool,
//     brightness: 1,                 // multiplier, 1 = neutral
//     saturation: 1,                 // multiplier, 1 = neutral
//     contrast: 1,                   // multiplier, 1 = neutral
//     warmth: 0 }                    // -100..100, + warmer / - cooler

let sharp = null;
try { sharp = (await import('sharp')).default; } catch { /* optional */ }

export function recipeIsNoop(r = {}) {
  if (!r || typeof r !== 'object') return true;
  const { crop, rotate = 0, straighten = 0, flipX, flipY,
          brightness = 1, saturation = 1, contrast = 1, warmth = 0 } = r;
  return !crop && !rotate && !straighten && !flipX && !flipY &&
         brightness === 1 && saturation === 1 && contrast === 1 && warmth === 0;
}

// Apply the recipe to an image buffer and return a print-ready buffer.
// `format` controls output; TIFF keeps 16-bit depth for print, else high-q JPEG.
export async function renderRecipe(inputBuffer, recipe = {}, { format = 'tiff' } = {}) {
  if (!sharp) throw new Error('sharp is not installed; cannot render recipe.');
  const r = recipe || {};
  let img = sharp(inputBuffer, { failOn: 'none' });

  // 1. Orientation, then fine straighten (expand canvas so nothing clips).
  if (r.flipX) img = img.flop();
  if (r.flipY) img = img.flip();
  const angle = (Number(r.rotate) || 0) + (Number(r.straighten) || 0);
  if (angle % 360 !== 0) img = img.rotate(angle, { background: { r: 255, g: 255, b: 255, alpha: 0 } });

  // 2. Crop in ORIGINAL pixels (clamped to bounds after rotation is applied).
  if (r.crop && r.crop.width > 0 && r.crop.height > 0) {
    const meta = await img.metadata();
    const left = Math.max(0, Math.round(r.crop.left || 0));
    const top = Math.max(0, Math.round(r.crop.top || 0));
    const width = Math.min(Math.round(r.crop.width), (meta.width || 0) - left);
    const height = Math.min(Math.round(r.crop.height), (meta.height || 0) - top);
    if (width > 0 && height > 0) img = img.extract({ left, top, width, height });
  }

  // 3. Tone. sharp.modulate handles brightness/saturation; linear handles contrast
  //    around mid-grey; warmth is a gentle channel tilt (R up / B down, or reverse).
  const mod = {};
  if (r.brightness && r.brightness !== 1) mod.brightness = r.brightness;
  if (r.saturation && r.saturation !== 1) mod.saturation = r.saturation;
  if (Object.keys(mod).length) img = img.modulate(mod);

  if (r.contrast && r.contrast !== 1) {
    const a = r.contrast;            // slope
    const b = 128 * (1 - a);         // keep mid-grey fixed
    img = img.linear(a, b);
  }

  if (r.warmth && r.warmth !== 0) {
    const k = Math.max(-100, Math.min(100, r.warmth)) / 100; // -1..1
    const rMul = 1 + 0.15 * k, bMul = 1 - 0.15 * k;
    img = img.linear([rMul, 1, bMul], [0, 0, 0]);
  }

  return format === 'tiff'
    ? img.tiff({ compression: 'lzw' }).toBuffer()
    : img.jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer();
}
