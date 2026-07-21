// Filerobot Image Editor → Pochron self-edit recipe.
//
// The editor runs on a downscaled proxy in the browser; we DON'T print its
// rendered output. Instead we capture its `designState`, normalize it into the
// small recipe the backend understands, and the studio re-applies that recipe
// to the full-resolution original at approval (see src/lib/render.js).
//
// Load Filerobot first (CDN):
//   <script src="https://scaleflex.cloudimg.io/v7/plugins/filerobot-image-editor/latest/filerobot-image-editor.min.js"></script>
// then: openAdjustEditor({ source, ratio, onApply })

// Map Filerobot's designState to our normalized recipe.
// Crop / rotate / flip are exact and matter most for print. Tone finetunes vary
// slightly by Filerobot version, so we read them defensively and clamp; calibrate
// the SCALE constants once against the version you pin.
export function mapDesignStateToRecipe(designState = {}, sourceDims = null) {
  const recipe = {};
  const adj = designState.adjustments || designState || {};

  // --- crop (in ORIGINAL pixels) ---
  const crop = adj.crop || designState.crop;
  if (crop && crop.width && crop.height) {
    // Filerobot may express crop relative to the (possibly downscaled) canvas.
    // If it gives ratios (0..1) and we know the original dims, scale up.
    const isRatio = crop.width <= 1 && crop.height <= 1;
    const W = sourceDims?.width, H = sourceDims?.height;
    if (isRatio && W && H) {
      recipe.crop = {
        left: Math.round((crop.x || 0) * W), top: Math.round((crop.y || 0) * H),
        width: Math.round(crop.width * W), height: Math.round(crop.height * H),
      };
    } else {
      recipe.crop = {
        left: Math.round(crop.x || 0), top: Math.round(crop.y || 0),
        width: Math.round(crop.width), height: Math.round(crop.height),
      };
    }
  }

  // --- orientation ---
  if (adj.rotation) recipe.rotate = ((adj.rotation % 360) + 360) % 360;
  if (adj.isFlippedX) recipe.flipX = true;
  if (adj.isFlippedY) recipe.flipY = true;

  // --- tone (finetunesProps) ---
  const fp = designState.finetunesProps || adj.finetunesProps || {};
  // brightness/contrast/saturation arrive on either a -1..1 or -100..100 scale
  // depending on version; normalize both to a multiplier around 1.
  const toMul = (v) => {
    if (v == null) return 1;
    const n = Math.abs(v) > 1 ? v / 100 : v; // -100..100 → -1..1
    return +(1 + n).toFixed(3);
  };
  if (fp.brightness != null) recipe.brightness = toMul(fp.brightness);
  if (fp.contrast != null) recipe.contrast = toMul(fp.contrast);
  if (fp.saturation != null) recipe.saturation = toMul(fp.saturation);
  else if (fp.hsv?.s != null) recipe.saturation = toMul(fp.hsv.s);
  // warmth stays on a -100..100 scale for the server's channel tilt.
  if (fp.warmth != null) recipe.warmth = Math.round(Math.abs(fp.warmth) <= 1 ? fp.warmth * 100 : fp.warmth);

  return recipe;
}

// Open the editor over `source` (an image URL or object URL of the uploaded
// original). `ratio` locks the crop to the chosen print size, e.g. 8/10.
// `onApply(recipe, editedImageObject, designState)` fires on Save.
export function openAdjustEditor({ source, ratio, onApply, containerId = 'fie-container', sourceDims = null, imageName = 'photo' }) {
  const FIE = window.FilerobotImageEditor;
  if (!FIE) throw new Error('Filerobot Image Editor script not loaded.');
  const { TABS } = FIE;

  let host = document.getElementById(containerId);
  if (host) host.remove();
  host = document.createElement('div');
  host.id = containerId;
  host.style.cssText = 'position:fixed;inset:0;z-index:1000;background:#1b1622';
  document.body.appendChild(host);

  // Our own always-works close control, above the editor chrome.
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = '✕ Cancel';
  cancelBtn.style.cssText = 'position:fixed;top:12px;right:14px;z-index:1001;background:#fff;color:#534270;border:1px solid #6E5B8F;border-radius:3px;padding:8px 14px;font:600 13px system-ui,Segoe UI,Arial;cursor:pointer';
  document.body.appendChild(cancelBtn);

  let editor;
  function cleanup() {
    document.removeEventListener('keydown', onKey);
    cancelBtn.remove();
    try { if (editor) editor.terminate(); } catch (e) { /* ignore */ }
    host.remove();
  }
  function onKey(e) { if (e.key === 'Escape') cleanup(); }
  document.addEventListener('keydown', onKey);
  cancelBtn.onclick = cleanup;

  try {
    editor = new FIE(host, {
      source,
      defaultTabId: TABS.ADJUST,
      tabsIds: [TABS.ADJUST, TABS.FINETUNE],
      // Lock crop to the ordered print ratio (single preset).
      Crop: ratio ? { presetsItems: [{ titleKey: 'printsize', descriptionKey: 'print', ratio }] } : {},
      defaultSavedImageName: String(imageName).replace(/\.[^.]+$/, ''),
      // Skip the file-save modal — fire onSave directly when the user clicks Save.
      onBeforeSave: () => false,
      onSave: (edited, designState) => {
        const recipe = mapDesignStateToRecipe(designState, sourceDims);
        cleanup();
        onApply?.(recipe, edited, designState);
      },
    });
    editor.render({ onClose: () => cleanup() });
  } catch (err) {
    cleanup();
    throw err;
  }
  return { close: cleanup };
}
