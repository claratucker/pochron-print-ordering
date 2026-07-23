import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each file boots its own server + database, so files must stay isolated.
    isolate: true,
    fileParallelism: false,   // servers bind real ports; run files one at a time
    testTimeout: 30000,
    hookTimeout: 30000,
    include: ['tests/**/*.test.js'],
    setupFiles: ['tests/setup.js'],
    reporters: ['verbose'],
  },
});
