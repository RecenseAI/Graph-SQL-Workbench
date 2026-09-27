import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
    reporters: ['default'],
    // Tests get their own data directory, one per worker (see vitest.setup.ts), so neither a
    // running workbench nor a parallel test file can hold the DuckDB lock the suite needs.
    setupFiles: ['./vitest.setup.ts'],
  },
});
