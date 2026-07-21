import { Router } from 'express';
import { loadCatalog } from '../lib/catalog.js';
import { config } from '../config.js';

export const catalogRouter = Router();

// GET /api/catalog — everything the front end needs to render options and show
// (display-only) prices. The mockup would fetch this instead of hardcoding
// PAPERS/SIZES/PRICES/VOLUME/etc.
catalogRouter.get('/', (req, res) => {
  const c = loadCatalog();
  res.json({
    papers: c.papers,
    sizes: c.sizes,
    prices: c.prices,
    borders: c.borders,
    shipping: c.shipping,
    volume: c.volume,
    ccAdd: c.ccAdd,
    dpi: { good: c.dpiGood, min: c.dpiMin },
    pxPerIn: c.pxPerIn,
    limits: {
      maxFiles: config.uploads.maxFiles,
      maxBytes: config.uploads.maxBytes,
      acceptedMime: config.uploads.acceptedMime,
    },
    studioContactUrl: config.email.studioContactUrl,
  });
});
