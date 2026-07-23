// Runs once per test FILE, before that file (or anything it imports) is loaded.
// This matters: config.js reads process.env at import time, and static imports
// are hoisted above beforeAll — so the environment has to be ready here, not in
// the test body.
import net from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

// The app logs a banner and prints every outbound email; useful in production,
// noise in tests. TEST_VERBOSE=1 brings it back.
if (!process.env.TEST_VERBOSE) {
  console.log = () => {};
  console.info = () => {};
}
