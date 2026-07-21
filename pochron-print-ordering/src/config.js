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
    acceptedMime: list(process.env.ACCEPTED_MIME, [
      'image/jpeg', 'image/tiff', 'image/png',
      'image/vnd.adobe.photoshop', 'application/x-photoshop', 'image/x-photoshop',
    ]),
  },

  payment: {
    driver: process.env.PAYMENT_DRIVER || 'mock',
    stripeSecret: process.env.STRIPE_SECRET_KEY,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  },

  email: {
    driver: process.env.EMAIL_DRIVER || 'console',
    from: process.env.EMAIL_FROM || 'Pochron Studios <info@pochronstudios.com>',
    studioContactUrl: process.env.STUDIO_CONTACT_URL || 'https://www.pochronstudios.com/contactus',
    smtp: {
      host: process.env.SMTP_HOST,
      port: int(process.env.SMTP_PORT, 587),
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  },

  tax: {
    driver: process.env.TAX_DRIVER || 'none',
    flatRate: parseFloat(process.env.TAX_FLAT_RATE || '0'),
  },

  studioPassword: process.env.STUDIO_PASSWORD || 'studio-dev',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin-dev',

  draftTtlDays: int(process.env.DRAFT_TTL_DAYS, 30),
};
