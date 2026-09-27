import { defineConfig } from 'vitest/config';
import { join } from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
    reporters: ['default'],
    // Tests get their own data directory, so a running workbench (which holds a lock on its
    // DuckDB file) can never make the suite fail, and the suite never touches real connections.
    env: { GQLWB_DATA_DIR: join(process.cwd(), '.test-data') },
  },
});
