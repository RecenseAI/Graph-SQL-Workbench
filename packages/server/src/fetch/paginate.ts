import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import type { ConnectionConfig } from '@gqlwb/shared';
import { callGraphQL, formatGraphQLErrors, type GraphQLErrorShape } from './client.ts';
import { extractRows, readPath, type DocumentPlan, type FetchSpec } from '../plan/document.ts';
import { cacheFilePath, fetchCacheKey, readCache, writeCache } from './cache.ts';
import { fail } from '../errors.ts';
import { logger } from '../log.ts';

const log = logger('paginate');

/** Hard ceiling on requests for one table, whatever the row budget says. */
const ABSOLUTE_MAX_PAGES = 2000;

export interface FetchTableOptions {
  conn: ConnectionConfig;
  spec: FetchSpec;
  plan: DocumentPlan;
  /** Row budget for this table. Reaching it stops the loop and raises a visible warning. */
  maxRows: number;
  useCache: boolean;
  /** Everything that identifies this fetch, hashed into the cache key. */
  cacheKeyParts: unknown[];
  signal?: AbortSignal;
  extraHeaders?: Record<string, string>;
  onProgress?: (info: { pages: number; rows: number; done: boolean }) => void;
}

export interface FetchTableResult {
  /** NDJSON file holding one row per line, each with an injected `_rowid`. */
  file: string;
  rowCount: number;
  pages: number;
  requests: number;
  retries: number;
  bytes: number;
  ms: number;
  /** The endpoint's own idea of the total, when it reports one. */
  total: number | null;
  truncated: boolean;
  cache: 'hit' | 'miss' | 'off';
  /** GraphQL errors that arrived alongside usable data. */
  errors: GraphQLErrorShape[];
  warnings: string[];
}

/**
 * Fetches every page of one table into an NDJSON file.
 *
 * Rows are streamed to disk as they arrive, so a large result never has to fit in memory, and the
 * file is exactly what the shredder hands to DuckDB's `read_json`. Truncation is always reported
 * rather than silently returning a short result -- a short answer that looks complete is worse
 * than a warning.
 */
export async function fetchTable(options: FetchTableOptions): Promise<FetchTableResult> {
  const { conn, spec, plan, maxRows } = options;
  const started = Date.now();
  const warnings: string[] = [];

  const key = fetchCacheKey(options.cacheKeyParts);
  const cacheEnabled = options.useCache && conn.cacheTtlSeconds > 0;

  if (cacheEnabled) {
    const hit = await readCache(key);
    if (hit) {
      log.debug(`cache hit for ${spec.table.name} (${hit.rowCount} rows)`);
      options.onProgress?.({ pages: hit.pages, rows: hit.rowCount, done: true });
      return {
        file: hit.file,
        rowCount: hit.rowCount,
        pages: hit.pages,
        requests: 0,
        retries: 0,
        bytes: hit.bytes,
        ms: Date.now() - started,
        total: hit.total,
        truncated: hit.truncated,
        cache: 'hit',
        errors: [],
        warnings: hit.truncated
          ? [`${spec.table.name} was truncated at ${hit.rowCount} rows when it was cached. Refresh to re-fetch.`]
          : [],
      };
    }
  }

  const file = cacheFilePath(key);
  const stream = createWriteStream(file, { encoding: 'utf8' });

  let rowCount = 0;
  let pages = 0;
  let requests = 0;
  let retries = 0;
  let bytes = 0;
  let total: number | null = null;
  let truncated = false;
  const errors: GraphQLErrorShape[] = [];

  const variables: Record<string, unknown> = { ...plan.variables };
  const pageSize = Math.max(1, spec.pageSize);
  // When the endpoint picks its own page size, pages may be far smaller than requested, so the
  // page count is bounded only by the absolute cap; the row budget still stops the loop.
  const maxPages =
    plan.pageSizeKnown === false
      ? ABSOLUTE_MAX_PAGES
      : Math.min(ABSOLUTE_MAX_PAGES, Math.ceil(maxRows / pageSize) + 5);
  let previousCursor: string | null = null;

  const write = (line: string): void => {
    if (!stream.write(line)) {
      // Backpressure is handled by awaiting drain at the end of each page.
      pendingDrain = true;
    }
  };
  let pendingDrain = false;

  try {
    for (;;) {
      if (options.signal?.aborted) fail('CANCELLED', 'Run cancelled');
      if (pages >= maxPages) {
        truncated = true;
        warnings.push(
          `${spec.table.name} stopped after ${pages} requests, the safety limit for one table. Narrow the query or raise the row budget.`,
        );
        break;
      }

      const call = await callGraphQL(conn, {
        document: plan.document,
        variables,
        operationName: 'WorkbenchFetch',
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.extraHeaders ? { extraHeaders: options.extraHeaders } : {}),
      });
      pages += 1;
      requests += call.attempts;
      retries += call.retries;
      bytes += call.bytes;

      const root = readPath(call.data, [plan.rootAlias]);
      const pageRows = extractRows(root, plan.nodesPath);

      if (call.errors.length > 0) {
        if (pageRows.length === 0 && rowCount === 0) {
          fail(
            'GRAPHQL_ERROR',
            `The endpoint rejected the query for ${spec.table.name}: ${formatGraphQLErrors(call.errors)}`,
            call.errors,
            'Open the Generated GraphQL panel to see exactly what was sent.',
          );
        }
        errors.push(...call.errors);
        warnings.push(
          `${spec.table.name} returned ${call.errors.length} GraphQL error(s) alongside data; fetching stopped early to avoid mixing partial pages.`,
        );
      }

      if (root === undefined) {
        fail(
          'GRAPHQL_ERROR',
          `The response contained no "${plan.rootAlias}" field for ${spec.table.name}.`,
          call.data,
          'The endpoint may have returned an error instead of data. Check the Messages panel.',
        );
      }

      if (plan.totalField && total === null) {
        const reported = readPath(root, [plan.totalField]);
        if (typeof reported === 'number') total = reported;
      }

      const room = maxRows - rowCount;
      const accepted = pageRows.length > room ? pageRows.slice(0, room) : pageRows;
      for (const row of accepted) {
        // _rowid is injected here so row identity is fixed at fetch time, independent of how
        // DuckDB later parallelises reading the file.
        write(JSON.stringify({ ...(row as Record<string, unknown>), _rowid: rowCount }) + '\n');
        rowCount += 1;
      }
      if (pendingDrain) {
        await once(stream, 'drain');
        pendingDrain = false;
      }
      options.onProgress?.({ pages, rows: rowCount, done: false });

      if (accepted.length < pageRows.length) {
        truncated = true;
        warnings.push(
          `${spec.table.name} hit the ${maxRows.toLocaleString('en-US')} row budget. Results are based on the first ${rowCount.toLocaleString('en-US')} rows only.`,
        );
        break;
      }
      if (errors.length > 0) break;

      // Decide whether another page exists, per pagination style.
      if (!plan.pageVariable) break;

      if (plan.pageVariable.kind === 'cursor') {
        const info = plan.pageInfoPath ? readPath(root, plan.pageInfoPath) : undefined;
        const hasNext = plan.hasNextField ? readPath(info, [plan.hasNextField]) === true : false;
        const cursorValue = plan.endCursorField ? readPath(info, [plan.endCursorField]) : undefined;
        const cursor = typeof cursorValue === 'string' ? cursorValue : null;
        if (!hasNext) break;
        if (!cursor) {
          warnings.push(
            `${spec.table.name} reports another page but returned no cursor, so fetching stopped at ${rowCount} rows.`,
          );
          truncated = true;
          break;
        }
        if (cursor === previousCursor) {
          warnings.push(
            `${spec.table.name} returned the same cursor twice, so fetching stopped at ${rowCount} rows to avoid looping forever.`,
          );
          truncated = true;
          break;
        }
        previousCursor = cursor;
        variables[plan.pageVariable.name] = cursor;
        if (rowCount >= maxRows) {
          truncated = true;
          warnings.push(
            `${spec.table.name} hit the ${maxRows.toLocaleString('en-US')} row budget with more rows available upstream.`,
          );
          break;
        }
        continue;
      }

      // An empty page always ends the loop.
      if (pageRows.length === 0) break;

      if (plan.pageVariable.kind === 'page' && plan.nextPagePath) {
        // The endpoint says itself whether there is more: `next: 3` / `next: null`,
        // or `hasNextPage: true/false`. That beats any guess from the page's length.
        const next = readPath(root, plan.nextPagePath);
        if (next === null || next === undefined || next === false) break;
      } else if (plan.pageSizeKnown !== false && pageRows.length < pageSize) {
        // Offset and sized page styles stop on a short page.
        break;
      }
      if (rowCount >= maxRows) {
        truncated = true;
        warnings.push(
          `${spec.table.name} hit the ${maxRows.toLocaleString('en-US')} row budget with more rows available upstream.`,
        );
        break;
      }
      if (plan.pageVariable.kind === 'offset') {
        variables[plan.pageVariable.name] = rowCount;
      } else {
        variables[plan.pageVariable.name] = Number(variables[plan.pageVariable.name] ?? 1) + 1;
      }
    }
  } finally {
    stream.end();
    await once(stream, 'close');
  }

  options.onProgress?.({ pages, rows: rowCount, done: true });

  if (cacheEnabled) {
    await writeCache({
      key,
      file,
      rowCount,
      bytes,
      pages,
      requests,
      total,
      truncated,
      connectionId: conn.id,
      tableName: spec.table.name,
      ttlSeconds: conn.cacheTtlSeconds,
    });
  }

  log.debug(`fetched ${spec.table.name}: ${rowCount} rows in ${pages} page(s), ${bytes} bytes`);

  return {
    file,
    rowCount,
    pages,
    requests,
    retries,
    bytes,
    ms: Date.now() - started,
    total,
    truncated,
    cache: cacheEnabled ? 'miss' : 'off',
    errors,
    warnings,
  };
}
