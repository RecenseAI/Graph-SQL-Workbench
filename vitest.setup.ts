import { join } from 'node:path';

// DuckDB lets one process hold a database file at a time, and Vitest runs test files in parallel
// worker processes. Each worker therefore gets its own data directory; sharing one made tests
// fail intermittently with a lock error depending on which files happened to overlap.
const worker = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? String(process.pid);
process.env.GQLWB_DATA_DIR = join(process.cwd(), '.test-data', `worker-${worker}`);
