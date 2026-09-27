import { defineConfig } from '@playwright/test';
import { join } from 'node:path';

/**
 * The UI suite runs against the real thing: the real server, the real DuckDB engine and the
 * bundled demo GraphQL API. Nothing is mocked, because the interesting failures in this app live
 * exactly where the layers meet.
 *
 * A dedicated data directory keeps the tests away from whatever is in the developer's workspace.
 */
const DATA_DIR = join(process.cwd(), '.playwright-data');

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5470',
    viewport: { width: 1500, height: 920 },
    colorScheme: 'dark',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'npx tsx packages/demo-api/src/server.ts',
      url: 'http://127.0.0.1:5471/health',
      reuseExistingServer: true,
      stdout: 'ignore',
      stderr: 'pipe',
      timeout: 60_000,
    },
    {
      // The UI has to be built first; the server serves it from packages/web/dist.
      command: 'npm run build && npx tsx packages/server/src/index.ts',
      url: 'http://127.0.0.1:5470/api/health',
      reuseExistingServer: true,
      stdout: 'ignore',
      stderr: 'pipe',
      timeout: 180_000,
      env: { GQLWB_DATA_DIR: DATA_DIR },
    },
  ],
});
