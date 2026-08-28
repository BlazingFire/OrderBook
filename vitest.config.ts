import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit tests run anywhere; integration tests need a database and are
    // skipped automatically when one is unavailable (see tests/helpers/db.ts).
    // `electron/` is not a workspace, but its `lib/` is pure or node:fs-only
    // and never imports `electron` — so the decisions that used to be
    // untestable inside a 300-line main process now run here like anything else.
    include: ['{shared,master,office,electron}/tests/**/*.test.ts'],
    environment: 'node',
    // Integration tests share one database, so files must not run in parallel.
    fileParallelism: false,
    testTimeout: 30_000,
    // Generous because the first integration run builds a throwaway
    // PostgreSQL cluster, and initdb takes ~35s on Windows. Later runs
    // reuse the cluster and start in a second or two.
    hookTimeout: 180_000,
    coverage: {
      provider: 'v8',
      include: ['{shared,master,office}/src/**/*.ts', 'electron/lib/**/*.ts'],
      exclude: ['**/migrations/**', '**/migrate-cli.ts'],
    },
  },
});
