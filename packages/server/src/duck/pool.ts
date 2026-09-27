import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { availableParallelism } from 'node:os';
import { CACHE_DB, ensureDirs } from '../env.ts';
import { logger } from '../log.ts';
import { fail } from '../errors.ts';

const log = logger('duck');

let instancePromise: Promise<DuckDBInstance> | null = null;

/**
 * One DuckDB instance backs the whole process. It is file-backed so fetch caches and
 * MATERIALIZE snapshots survive restarts, and so large results can spill to disk instead
 * of being bounded by RAM.
 */
export function getInstance(): Promise<DuckDBInstance> {
  if (!instancePromise) {
    ensureDirs();
    instancePromise = DuckDBInstance.create(CACHE_DB, {
      threads: String(Math.max(2, Math.min(8, availableParallelism()))),
      max_memory: process.env.GQLWB_MAX_MEMORY ?? '4GB',
    }).then(
      (instance) => {
        log.info(`opened ${CACHE_DB}`);
        return instance;
      },
      (err: unknown) => {
        instancePromise = null;
        const message = err instanceof Error ? err.message : String(err);
        if (/being used by another process|Conflicting lock|already open/i.test(message)) {
          fail(
            'INTERNAL',
            'Another GraphQL Workbench instance already has the local database open.',
            message,
            `Close the other instance, or start this one with a different store: GQLWB_DATA_DIR=<dir> npm run dev:api`,
          );
        }
        fail('INTERNAL', `Could not open the local DuckDB store at ${CACHE_DB}`, message);
      },
    );
  }
  return instancePromise;
}

/** A fresh connection. Callers own it and must `disconnectSync()` when done. */
export async function connect(): Promise<DuckDBConnection> {
  const instance = await getInstance();
  return instance.connect();
}

/** Runs `fn` with a connection and always releases it. */
export async function withConnection<T>(fn: (conn: DuckDBConnection) => Promise<T>): Promise<T> {
  const conn = await connect();
  try {
    return await fn(conn);
  } finally {
    try {
      conn.disconnectSync();
    } catch (err) {
      log.debug('disconnect failed', err);
    }
  }
}

let cachedVersion: string | null = null;

export async function getDuckVersion(): Promise<string> {
  if (cachedVersion) return cachedVersion;
  cachedVersion = await withConnection(async (conn) => {
    const reader = await conn.runAndReadAll('SELECT version() AS v');
    const row = reader.getRowObjectsJson()[0] as { v?: string } | undefined;
    return row?.v ?? 'unknown';
  });
  return cachedVersion;
}
