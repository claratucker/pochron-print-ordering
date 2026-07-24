// Runs once per test FILE, before that file (or anything it imports) is loaded.
// This matters: config.js reads process.env at import time, and static imports
// are hoisted above beforeAll — so the environment has to be ready here, not in
// the test body.
import net from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Do NOT read the machine's .env. config.js calls dotenv, so without this the
// suite inherits whatever is deployed — and a test would pass on a laptop with
// no credentials and fail on the server that has them. Tests must assert
// against a known environment, so point dotenv at nothing and set every value
// the tests depend on explicitly below.
process.env.DOTENV_CONFIG_PATH = '/dev/null';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'pochron-test-'));
process.env.PORT = String(await freePort());
process.env.NODE_ENV = 'test';
process.env.STUDIO_PASSWORD = 'test-studio-pw';
process.env.ADMIN_PASSWORD = 'test-admin-pw';
process.env.APP_SECRET = 'test-secret-not-for-production';
process.env.EMAIL_DRIVER = 'console';
process.env.STORAGE_DRIVER = 'local';
process.env.PAYMENT_DRIVER = process.env.PAYMENT_DRIVER || 'mock';
process.env.TAX_DRIVER = 'none';
// Connector credentials are explicitly absent unless a test sets them, so the
// "unconfigured" behaviour is what gets tested rather than the deployment's.
delete process.env.LIGHTROOM_CLIENT_ID;
delete process.env.LIGHTROOM_CLIENT_SECRET;
delete process.env.DROPBOX_APP_KEY;

// The app logs a banner and prints every outbound email; useful in production,
// noise in tests. TEST_VERBOSE=1 brings it back.
if (!process.env.TEST_VERBOSE) {
  console.log = () => {};
  console.info = () => {};
}
