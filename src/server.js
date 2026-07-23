import express from 'express';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from './config.js';
import { diskStatus } from './lib/disk.js';
import { db, DATA_DIR } from './db/index.js';               // opens + migrates on import
import { storage } from './adapters/storage.js';
import { payment } from './adapters/payment.js';
import { email } from './adapters/email.js';
import { sharpAvailable } from './lib/imagemeta.js';

import { catalogRouter } from './routes/catalog.js';
import { uploadsRouter } from './routes/uploads.js';
import { priceRouter } from './routes/price.js';
import { draftRouter } from './routes/draft.js';
import { ordersRouter } from './routes/orders.js';
import { studioRouter } from './routes/studio.js';
import { adminRouter } from './routes/admin.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');

// CORS — the order app (and the mockup during dev) call this API cross-origin.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && config.corsOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Studio-Password');
  res.setHeader('Access-Control-Expose-Headers', 'ETag');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(cookieParser());
// JSON for everything EXCEPT the raw local-upload receiver (which sets its own
// raw() body parser inside the uploads router).
app.use((req, res, next) =>
  req.path.startsWith('/api/uploads/local/') ? next() : express.json({ limit: '2mb' })(req, res, next));

// Health / readiness — reports which adapters are live.
app.get('/api/health', async (req, res) => {
  const catalogRows = db.prepare('SELECT COUNT(*) c FROM prices').get().c;
  res.json({
    ok: true,
    env: config.env,
    adapters: { storage: storage.name, payment: payment.name, email: email.name, sharp: sharpAvailable },
    catalogPriceRows: catalogRows,
    seeded: catalogRows > 0,
    disk: await diskStatus(DATA_DIR),
  });
});

// API routes
app.use('/api/catalog', catalogRouter);
app.use('/api/uploads', uploadsRouter);
app.use('/api/price', priceRouter);
app.use('/api/draft', draftRouter);
app.use('/api/orders', ordersRouter);
app.use('/api/studio', studioRouter);
app.use('/api/admin', adminRouter);

// Order front-end assets (the Filerobot self-edit demo + mapping module).
app.use('/order', express.static(join(__dirname, '..', 'public', 'order')));

// Studio proofing/approval page (static; calls /api/studio with the studio password).
app.use('/studio', express.static(join(__dirname, '..', 'public', 'studio')));

// Admin pricing page (static; calls /api/admin with the admin password).
app.use('/admin', express.static(join(__dirname, '..', 'public', 'admin')));

// 404 + error handler
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

if (db.prepare('SELECT COUNT(*) c FROM prices').get().c === 0) {
  console.warn('⚠  Catalog is empty. Run `npm run seed` before taking orders.');
}

app.listen(config.port, () => {
  console.log(`\nPochron print-ordering backend on http://localhost:${config.port}`);
  console.log(`  adapters: storage=${storage.name} payment=${payment.name} email=${email.name} sharp=${sharpAvailable}`);
  console.log(`  studio:   http://localhost:${config.port}/studio   (proofing & approvals)`);
  console.log(`  admin:    http://localhost:${config.port}/admin    (pricing)\n`);
});

export { app };
