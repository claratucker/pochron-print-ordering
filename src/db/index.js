import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(join(DATA_DIR, 'pochron.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Schema ─────────────────────────────────────────────────────────────
// Editable catalog (prices change; admin edits these, not code — §7).
db.exec(`
CREATE TABLE IF NOT EXISTS papers (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, fam TEXT NOT NULL,
  descr TEXT, sort INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sizes (
  size TEXT PRIMARY KEY, sort INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS prices (
  fam TEXT NOT NULL, size TEXT NOT NULL, price REAL NOT NULL,
  PRIMARY KEY (fam, size)
);
CREATE TABLE IF NOT EXISTS shipping_methods (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, cost REAL NOT NULL, sort INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS volume_tiers (
  min_qty INTEGER PRIMARY KEY, rate REAL, label TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);

-- Uploaded files. Metadata (w/h/profile/depth/dpi) is extracted server-side.
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  owner_token TEXT,                 -- guest draft token that uploaded it
  order_id INTEGER,                 -- set once attached to a submitted order
  storage_key TEXT NOT NULL,        -- key/path in object storage
  original_name TEXT NOT NULL,
  mime TEXT,
  bytes INTEGER,
  width INTEGER,
  height INTEGER,
  color_profile TEXT,
  bit_depth INTEGER,
  best_dpi INTEGER,                 -- highest dpi across offered sizes
  scan_status TEXT DEFAULT 'pending', -- pending | clean | infected | error
  status TEXT DEFAULT 'initialized',  -- initialized | uploaded | validated | rejected | processing
  reject_reason TEXT,
  multipart_upload_id TEXT,          -- set while a resumable multipart upload is in progress
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_files_owner ON files(owner_token);

-- Server-side draft / autosave (§5). Guests keyed by cookie token.
CREATE TABLE IF NOT EXISTS drafts (
  token TEXT PRIMARY KEY,
  data TEXT NOT NULL,               -- JSON: line items (file refs + config) + flags
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Orders + lifecycle (§6).
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted', -- draft|submitted|on_hold|approved|in_production|shipped|complete|cancelled
  customer_name TEXT, email TEXT, phone TEXT,
  ship_name TEXT, ship_addr1 TEXT, ship_addr2 TEXT,
  ship_city TEXT, ship_state TEXT, ship_zip TEXT, ship_country TEXT,
  ship_method TEXT, white_label INTEGER DEFAULT 0,
  low_res_ack INTEGER DEFAULT 0,
  subtotal REAL, discount_rate REAL, discount_amount REAL,
  shipping_cost REAL, tax REAL, total REAL,
  payment_ref TEXT,                 -- Stripe PaymentIntent id (auth) 
  payment_status TEXT,              -- authorized | captured | partially_captured | voided | failed | manual_quote
  tracking TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  file_id TEXT REFERENCES files(id),
  original_name TEXT,
  paper TEXT, size TEXT, border TEXT, qty INTEGER,
  color_path TEXT,                  -- none | studio | self
  adjust_recipe TEXT,               -- JSON self-edit recipe (kept WITH the original)
  pos_x REAL, pos_y REAL,
  unit_price REAL, cc_fee REAL, line_total REAL,
  width INTEGER, height INTEGER, dpi INTEGER, dpi_flag TEXT, -- ok|soft|too_small
  item_status TEXT DEFAULT 'pending', -- pending|approved|held (per-photo, for partial capture §9)
  captured_amount REAL DEFAULT 0,
  print_file_key TEXT               -- rendered full-res print file (recipe re-applied to original)
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);

-- Studio <-> customer hold/message thread tied to the order (§6/§11).
CREATE TABLE IF NOT EXISTS order_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,          -- studio_to_customer | customer_to_studio | system
  body TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Lifecycle audit trail.
CREATE TABLE IF NOT EXISTS order_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status TEXT, to_status TEXT, note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

// Lightweight forward migrations for databases created before a column existed.
function ensureColumn(table, column, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}
ensureColumn('order_items', 'print_file_key', 'TEXT');
ensureColumn('files', 'multipart_upload_id', 'TEXT');

export { DATA_DIR };
