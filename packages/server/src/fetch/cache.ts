import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from '../env.ts';
import { withConnection } from '../duck/pool.ts';
import { quoteLiteral } from '../duck/sql-util.ts';
import { logger } from '../log.ts';

const log = logger('cache');

/**
 * Fetched pages are cached as NDJSON files with metadata in DuckDB.
 *
 * Keeping the payload on disk rather than in a table means a cache hit costs nothing to
 * serialise: the shredder reads exactly the same file it would have written, so iterating on
 * analytics SQL over one dataset never touches the endpoint again.
 */

const CACHE_DIR = join(DATA_DIR, 'fetch-cache');

export interface CacheEntry {
  key: string;
  file: string;
  rowCount: number;
  bytes: number;
  pages: number;
  requests: number;
  total: number | null;
  truncated: boolean;
  createdAt: string;
}

let initialised: Promise<void> | null = null;

function ensureDir(): void {
  mkdirSync(CACHE_DIR, { recursive: true });
}

async function init(): Promise<void> {
  if (!initialised) {
    initialised = withConnection(async (conn) => {
      ensureDir();
      await conn.run(`CREATE TABLE IF NOT EXISTS _gqlwb_fetch_cache (
        key VARCHAR PRIMARY KEY,
        connection_id VARCHAR,
        table_name VARCHAR,
        file VARCHAR,
        row_count BIGINT,
        bytes BIGINT,
        pages BIGINT,
        requests BIGINT,
        total BIGINT,
        truncated BOOLEAN,
        created_at TIMESTAMP,
        expires_at TIMESTAMP
      )`);
    });
  }
  return initialised;
}

/** A stable key over everything that changes what a fetch returns. */
export function fetchCacheKey(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 40);
}

export function cacheFilePath(key: string): string {
  ensureDir();
  return join(CACHE_DIR, `${key}.ndjson`);
}

export async function readCache(key: string): Promise<CacheEntry | null> {
  await init();
  return withConnection(async (conn) => {
    const reader = await conn.runAndReadAll(
      `SELECT key, file, row_count, bytes, pages, requests, total, truncated, created_at
       FROM _gqlwb_fetch_cache
       WHERE key = ${quoteLiteral(key)} AND (expires_at IS NULL OR expires_at > now())`,
    );
    const row = reader.getRowObjectsJson()[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    const file = String(row.file);
    // A missing file means the cache was cleared behind our back; treat it as a miss.
    if (!existsSync(file)) {
      await conn.run(`DELETE FROM _gqlwb_fetch_cache WHERE key = ${quoteLiteral(key)}`);
      return null;
    }
    return {
      key: String(row.key),
      file,
      rowCount: Number(row.row_count),
      bytes: Number(row.bytes),
      pages: Number(row.pages),
      requests: Number(row.requests),
      total: row.total === null || row.total === undefined ? null : Number(row.total),
      truncated: row.truncated === true || row.truncated === 'true',
      createdAt: String(row.created_at),
    };
  });
}

export async function writeCache(
  entry: Omit<CacheEntry, 'createdAt'> & { connectionId: string; tableName: string; ttlSeconds: number },
): Promise<void> {
  if (entry.ttlSeconds <= 0) return;
  await init();
  await withConnection(async (conn) => {
    await conn.run(`DELETE FROM _gqlwb_fetch_cache WHERE key = ${quoteLiteral(entry.key)}`);
    await conn.run(`INSERT INTO _gqlwb_fetch_cache VALUES (
      ${quoteLiteral(entry.key)},
      ${quoteLiteral(entry.connectionId)},
      ${quoteLiteral(entry.tableName)},
      ${quoteLiteral(entry.file)},
      ${entry.rowCount},
      ${entry.bytes},
      ${entry.pages},
      ${entry.requests},
      ${entry.total === null ? 'NULL' : entry.total},
      ${entry.truncated ? 'TRUE' : 'FALSE'},
      now(),
      now() + INTERVAL ${Math.round(entry.ttlSeconds)} SECOND
    )`);
  });
}

/** Drops every cached fetch for a connection, used by the Refresh action. */
export async function invalidateConnectionCache(connectionId: string): Promise<number> {
  await init();
  return withConnection(async (conn) => {
    const reader = await conn.runAndReadAll(
      `SELECT file FROM _gqlwb_fetch_cache WHERE connection_id = ${quoteLiteral(connectionId)}`,
    );
    const files = reader.getRowObjectsJson().map((row) => String((row as Record<string, unknown>).file));
    for (const file of files) {
      try {
        rmSync(file, { force: true });
      } catch (err) {
        log.debug(`could not remove ${file}`, err);
      }
    }
    await conn.run(`DELETE FROM _gqlwb_fetch_cache WHERE connection_id = ${quoteLiteral(connectionId)}`);
    return files.length;
  });
}

/** Removes expired entries and their files. Cheap enough to run before each query. */
export async function pruneCache(): Promise<void> {
  await init();
  await withConnection(async (conn) => {
    const reader = await conn.runAndReadAll(
      'SELECT file FROM _gqlwb_fetch_cache WHERE expires_at IS NOT NULL AND expires_at <= now()',
    );
    for (const row of reader.getRowObjectsJson()) {
      const file = String((row as Record<string, unknown>).file);
      try {
        rmSync(file, { force: true });
      } catch {
        /* a file we cannot delete is not worth failing a query over */
      }
    }
    await conn.run('DELETE FROM _gqlwb_fetch_cache WHERE expires_at IS NOT NULL AND expires_at <= now()');
  });
}

export interface CacheStats {
  entries: number;
  bytes: number;
  rows: number;
}

export async function cacheStats(): Promise<CacheStats> {
  await init();
  return withConnection(async (conn) => {
    const reader = await conn.runAndReadAll(
      'SELECT count(*) AS entries, coalesce(sum(bytes), 0) AS bytes, coalesce(sum(row_count), 0) AS rows FROM _gqlwb_fetch_cache',
    );
    const row = reader.getRowObjectsJson()[0] as Record<string, unknown> | undefined;
    return {
      entries: Number(row?.entries ?? 0),
      bytes: Number(row?.bytes ?? 0),
      rows: Number(row?.rows ?? 0),
    };
  });
}

export function fileSizeOrZero(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}
