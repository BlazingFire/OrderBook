import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit tests run anywhere; integration tests need a database and are
    // skipped automatically when one is unavailable (see tests/helpers/db.ts).
    include: ['{shared,master,office}/tests/**/*.test.ts'],
    environment: 'node',
    // Integration tests share one database, so files must not run in parallel.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['{shared,master,office}/src/**/*.ts'],
      exclude: ['**/migrations/**', '**/migrate-cli.ts'],
    },
  },
});
