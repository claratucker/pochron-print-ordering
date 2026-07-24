import 'dotenv/config';

const int = (v, d) => (v === undefined ? d : parseInt(v, 10));
const list = (v, d) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : d);

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: int(process.env.PORT, 4000),
  corsOrigins: list(process.env.CORS_ORIGINS, ['http://localhost:4000']),
  appSecret: process.env.APP_SECRET || 'dev-only-change-me',

  storage: {
    driver: process.env.STORAGE_DRIVER || 'local',
    region: process.env.AWS_REGION || 'auto',        // R2 uses 'auto'
    bucket: process.env.S3_BUCKET,
    cdnBase: process.env.S3_CDN_BASE,
    // S3-compatible endpoint (Cloudflare R2, Backblaze B2, MinIO). Leave unset for AWS S3.
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    accessKeyId: process.env.S3_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY,
    presignTtl: int(process.env.PRESIGN_TTL_SECONDS, 3600),  // part URLs need headroom for slow links
  },

  uploads: {
    maxFiles: int(process.env.MAX_FILES, 12),
    // Default 20 GB: high-end scans are routinely multi-GB. Raise/lower per plan.
    maxBytes: int(process.env.MAX_BYTES, 21474836480),
    // Chunk size for resumable multipart. 64 MB × 10,000 parts ≈ 640 GB ceiling.
    partSize: int(process.env.UPLOAD_PART_SIZE, 67108864),
    maxParts: int(process.env.UPLOAD_MAX_PARTS, 10000),
    // Files at/above this size skip in-request processing: header-only metadata
    // via a ranged read, and the malware scan is deferred to a background pass
    // so a multi-GB upload never blocks the request or the app server memory.
    inlineProcessMaxBytes: int(process.env.INLINE_PROCESS_MAX_BYTES, 268435456), // 256 MB
    // How many header bytes to pull for dimension/metadata extraction on big files.
    headerReadBytes: int(process.env.HEADER_READ_BYTES, 8388608), // 8 MB
    // Never let uploads consume the last of the volume — SQLite needs room to
    // write, so a full disk is a data-loss risk, not just a failed upload.
    diskReserveBytes: int(process.env.DISK_RESERVE_BYTES, 3221225472), // 3 GB
    // Cloud-connector imports are buffered, so they are capped well below the
    // direct-upload limit; bigger files should use the resumable direct path.
    importMaxBytes: int(process.env.IMPORT_MAX_BYTES, 1073741824),   // 1 GB
    importTimeoutMs: int(process.env.IMPORT_TIMEOUT_MS, 120000),
    enabledConnectors: list(process.env.ENABLED_CONNECTORS, ['dropbox', 'google_drive']),
    // Dropbox Chooser app key. Public by design — it is embedded in the page
    // and only works from domains allowlisted in the Dropbox app console.
    dropboxAppKey: process.env.DROPBOX_APP_KEY || null,
    // Google Picker needs all three in the browser. All are public: the OAuth
    // client is restricted by authorized origin and the API key by referrer,
    // which is what actually secures them.
    googleClientId: process.env.GOOGLE_CLIENT_ID || null,
    googleApiKey: process.env.GOOGLE_API_KEY || null,
    googleAppId: process.env.GOOGLE_APP_ID || null,
    acceptedMime: list(process.env.ACCEPTED_MIME, [
      'image/jpeg', 'image/tiff', 'image/png',
      'image/vnd.adobe.photoshop', 'application/x-photoshop', 'image/x-photoshop',
    ]),
  },

  payment: {
    driver: process.env.PAYMENT_DRIVER || 'mock',
    // Card authorizations expire. Stripe cancels an uncaptured PaymentIntent
    // after ~7 days, and some issuers release the hold sooner. The studio
    // reviews unhurriedly by design, so this clock has to be visible.
    authWindowDays: int(process.env.AUTH_WINDOW_DAYS, 7),
    authWarnDays: int(process.env.AUTH_WARN_DAYS, 5),
    stripeSecret: process.env.STRIPE_SECRET_KEY,
    stripePublishable: process.env.STRIPE_PUBLISHABLE_KEY,   // safe to send to the browser
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  },

  // Fulfillment / packaging (§10). White-label orders ship with a neutral return
  // address and no studio branding or inserts.
  fulfillment: {
    studioReturnAddress: process.env.STUDIO_RETURN_ADDRESS
      || 'Pochron Studios\n117 9th Street, Rm #210\nBrooklyn, NY 11215',
    // White-label parcels ship from the same place but under the CUSTOMER's
    // own business name, so only the street portion is configured here.
    dropAddress: process.env.DROP_ADDRESS
      || '117 9th Street, Rm #210\nBrooklyn, NY 11215',
  },

  // Email verification (§8 layer 3). none | kickbox | zerobounce
  // Cloud connectors needing server-side credentials (see CONNECTORS.md).
  connectors: {
    lightroom: {
      clientId: process.env.LIGHTROOM_CLIENT_ID,
      clientSecret: process.env.LIGHTROOM_CLIENT_SECRET,
      redirectUri: process.env.LIGHTROOM_REDIRECT_URI
        || 'https://order.pochronstudios.com/api/connectors/lightroom/callback',
    },
  },

  emailVerify: {
    driver: process.env.EMAIL_VERIFY_DRIVER || 'none',
    apiKey: process.env.EMAIL_VERIFY_API_KEY,
  },

  email: {
    driver: process.env.EMAIL_DRIVER || 'console',
    from: process.env.EMAIL_FROM || 'Pochron Studios <info@pochronstudios.com>',
    studioContactUrl: process.env.STUDIO_CONTACT_URL || 'https://www.pochronstudios.com/contactus',
    orderBaseUrl: process.env.ORDER_BASE_URL || 'https://order.pochronstudios.com',
    smtp: {
      host: process.env.SMTP_HOST,
      port: int(process.env.SMTP_PORT, 587),
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  },

  tax: {
    stripeTaxCode: process.env.STRIPE_TAX_CODE || 'txcd_99999999',
    driver: process.env.TAX_DRIVER || 'none',
    flatRate: parseFloat(process.env.TAX_FLAT_RATE || '0'),
  },

  studioPassword: process.env.STUDIO_PASSWORD || 'studio-dev',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin-dev',

  draftTtlDays: int(process.env.DRAFT_TTL_DAYS, 30),
};
