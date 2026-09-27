import { randomBytes } from 'node:crypto';
import type { DuckDBConnection } from '@duckdb/node-api';
import type { ResultColumn } from '@gqlwb/shared';
import { withConnection } from './pool.ts';
import { encodeColumns, encodeRows, refineJsonColumns } from './encode.ts';
import { quoteIdent, quoteLiteral } from './sql-util.ts';
import { fail } from '../errors.ts';
import { logger } from '../log.ts';

const log = logger('results');

/**
 * Executed results are materialised into a table in the local database rather than streamed
 * straight to the browser.
 *
 * That one decision buys most of what a Workbench grid needs: paging through a hundred thousand
 * rows without re-running the query (and without re-fetching from the endpoint), sorting and
 * filtering server-side, and exporting to CSV or Parquet later. Temporary tables would vanish
 * between HTTP requests, so these live in their own schema and are pruned by age.
 */

const SCHEMA = 'wb_results';
const KEEP_RESULTS = 60;

/** Statements that produce a row set worth materialising. */
const ROWSET_KEYWORDS = new Set([
  'select', 'with', 'from', 'table', 'values', 'describe', 'show', 'pivot', 'unpivot', 'explain', 'summarize',
]);

/**
 * Skips whitespace, line comments and block comments to find a statement's first keyword.
 * A statement that opens with a comment -- which is how most saved queries are written -- must
 * still be recognised as producing rows.
 */
export function firstKeyword(sql: string): string | null {
  let i = 0;
  while (i < sql.length) {
    const char = sql[i];
    if (char === undefined) break;
    if (/\s/.test(char) || char === '(') {
      i += 1;
      continue;
    }
    if (char === '-' && sql[i + 1] === '-') {
      const newline = sql.indexOf('\n', i);
      if (newline === -1) return null;
      i = newline + 1;
      continue;
    }
    if (char === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      if (close === -1) return null;
      i = close + 2;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i))?.[0];
    return word ? word.toLowerCase() : null;
  }
  return null;
}

export function producesRows(sql: string): boolean {
  const keyword = firstKeyword(sql);
  return keyword ? ROWSET_KEYWORDS.has(keyword) : false;
}

let schemaReady = false;

async function ensureSchema(conn: DuckDBConnection): Promise<void> {
  if (schemaReady) return;
  await conn.run(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(SCHEMA)}`);
  schemaReady = true;
}

const resultTable = (resultId: string): string => `${quoteIdent(SCHEMA)}.${quoteIdent(resultId)}`;

export interface StoredResult {
  resultId: string;
  columns: ResultColumn[];
  rowCount: number;
  rows: unknown[][];
  /** True when the statement returned no row set, only a message. */
  command: boolean;
  message?: string;
}

export interface ExecuteOptions {
  pageRows: number;
  /** Collect per-column null counts and numeric ranges for the grid header and charts. */
  withStats?: boolean;
  explain?: boolean;
}

/**
 * Runs one statement. Row-producing statements are stored and their first page returned;
 * everything else (SET, CREATE, a snapshot refresh) reports what it did.
 */
export async function executeStatement(
  conn: DuckDBConnection,
  sql: string,
  options: ExecuteOptions,
): Promise<StoredResult & { explain?: string }> {
  await ensureSchema(conn);

  if (!producesRows(sql)) {
    try {
      const reader = await conn.runAndReadAll(sql);
      // Some commands do return a row (e.g. an INSERT with a count), which is worth showing.
      const rowCount = reader.currentRowCount;
      if (rowCount > 0 && reader.columnNames().length > 0) {
        const columns = encodeColumns(reader);
        return {
          resultId: '',
          columns,
          rows: encodeRows(reader, columns),
          rowCount,
          command: true,
          message: 'Statement completed.',
        };
      }
      return { resultId: '', columns: [], rows: [], rowCount: 0, command: true, message: 'Statement completed.' };
    } catch (err) {
      fail('EXECUTE_FAILED', duckMessage(err), err instanceof Error ? err.stack : err);
    }
  }

  const resultId = `r_${randomBytes(8).toString('hex')}`;
  let explain: string | undefined;

  if (options.explain) {
    try {
      const reader = await conn.runAndReadAll(`EXPLAIN ${sql}`);
      explain = reader
        .getRowsJson()
        .map((row) => (row as unknown[]).map((cell) => String(cell ?? '')).join('  '))
        .join('\n');
    } catch (err) {
      explain = `EXPLAIN failed: ${duckMessage(err)}`;
    }
  }

  try {
    await conn.run(`CREATE OR REPLACE TABLE ${resultTable(resultId)} AS ${sql}`);
  } catch (err) {
    fail('EXECUTE_FAILED', duckMessage(err), err instanceof Error ? err.stack : err, hintForDuckError(err));
  }

  const countReader = await conn.runAndReadAll(`SELECT count(*) AS n FROM ${resultTable(resultId)}`);
  const rowCount = Number((countReader.getRowObjectsJson()[0] as Record<string, unknown>)?.n ?? 0);

  const pageReader = await conn.runAndReadAll(
    `SELECT * FROM ${resultTable(resultId)} LIMIT ${Math.max(1, options.pageRows)}`,
  );
  const columns = encodeColumns(pageReader);
  const rows = encodeRows(pageReader, columns);
  refineJsonColumns(columns, rows);

  if (options.withStats !== false) {
    await attachStats(conn, resultId, columns, rowCount);
  }

  const result: StoredResult & { explain?: string } = { resultId, columns, rows, rowCount, command: false };
  if (explain !== undefined) result.explain = explain;
  return result;
}

/**
 * One pass over the stored result produces null counts for every column and ranges for the
 * numeric ones, which the grid uses for its header bars and the chart tab uses for axes.
 */
async function attachStats(
  conn: DuckDBConnection,
  resultId: string,
  columns: ResultColumn[],
  rowCount: number,
): Promise<void> {
  if (rowCount === 0 || columns.length === 0 || columns.length > 80) return;
  const parts: string[] = [];
  columns.forEach((column, index) => {
    parts.push(`count(*) - count(${quoteIdent(column.name)}) AS ${quoteIdent(`n${index}`)}`);
    if (column.cellType === 'number' || column.cellType === 'bigint') {
      parts.push(`min(${quoteIdent(column.name)})::DOUBLE AS ${quoteIdent(`lo${index}`)}`);
      parts.push(`max(${quoteIdent(column.name)})::DOUBLE AS ${quoteIdent(`hi${index}`)}`);
    }
  });
  try {
    const reader = await conn.runAndReadAll(`SELECT ${parts.join(', ')} FROM ${resultTable(resultId)}`);
    const row = reader.getRowObjectsJson()[0] as Record<string, unknown> | undefined;
    if (!row) return;
    columns.forEach((column, index) => {
      column.nullCount = Number(row[`n${index}`] ?? 0);
      const lo = row[`lo${index}`];
      const hi = row[`hi${index}`];
      if (lo !== undefined && lo !== null) column.min = Number(lo);
      if (hi !== undefined && hi !== null) column.max = Number(hi);
    });
  } catch (err) {
    // Statistics are a nicety; a column type that will not aggregate must not fail the query.
    log.debug('column statistics skipped', err);
  }
}

export interface PageOptions {
  offset: number;
  limit: number;
  /** Column to order by. Validated against the stored result's real columns. */
  orderBy?: string;
  descending?: boolean;
  /** Case-insensitive substring match across all columns. */
  filter?: string;
}

export interface Page {
  rows: unknown[][];
  columns: ResultColumn[];
  offset: number;
  /** Rows matching the filter, which is what the grid scrolls through. */
  rowCount: number;
  totalRowCount: number;
}

export async function readResultPage(resultId: string, options: PageOptions): Promise<Page> {
  assertResultId(resultId);
  return withConnection(async (conn) => {
    await ensureSchema(conn);
    const exists = await resultExists(conn, resultId);
    if (!exists) {
      fail(
        'NOT_FOUND',
        'That result is no longer available.',
        undefined,
        'Results are kept for the most recent queries only. Run the statement again.',
      );
    }

    const columnsReader = await conn.runAndReadAll(`SELECT * FROM ${resultTable(resultId)} LIMIT 0`);
    const columns = encodeColumns(columnsReader);
    const columnNames = new Set(columns.map((c) => c.name));

    let where = '';
    if (options.filter && options.filter.trim().length > 0) {
      const needle = quoteLiteral(`%${options.filter.trim().toLowerCase()}%`);
      const tests = columns.map((c) => `lower(CAST(${quoteIdent(c.name)} AS VARCHAR)) LIKE ${needle}`);
      where = tests.length ? ` WHERE ${tests.join(' OR ')}` : '';
    }

    let orderBy = '';
    if (options.orderBy && columnNames.has(options.orderBy)) {
      // NULLS LAST in both directions keeps empty cells out of the way while scanning.
      orderBy = ` ORDER BY ${quoteIdent(options.orderBy)} ${options.descending ? 'DESC' : 'ASC'} NULLS LAST`;
    }

    const totalReader = await conn.runAndReadAll(`SELECT count(*) AS n FROM ${resultTable(resultId)}`);
    const totalRowCount = Number((totalReader.getRowObjectsJson()[0] as Record<string, unknown>)?.n ?? 0);

    const matchedReader = where
      ? await conn.runAndReadAll(`SELECT count(*) AS n FROM ${resultTable(resultId)}${where}`)
      : totalReader;
    const rowCount = Number((matchedReader.getRowObjectsJson()[0] as Record<string, unknown>)?.n ?? 0);

    const reader = await conn.runAndReadAll(
      `SELECT * FROM ${resultTable(resultId)}${where}${orderBy} LIMIT ${Math.max(1, Math.min(options.limit, 5000))} OFFSET ${Math.max(0, options.offset)}`,
    );
    const pageColumns = encodeColumns(reader);
    const pageRows = encodeRows(reader, pageColumns);
    refineJsonColumns(pageColumns, pageRows);
    return {
      rows: pageRows,
      columns: pageColumns,
      offset: Math.max(0, options.offset),
      rowCount,
      totalRowCount,
    };
  });
}

export type ExportFormat = 'csv' | 'json' | 'parquet' | 'markdown' | 'sql';

/** Streams a stored result to a file in the requested format, using DuckDB's own writers. */
export async function exportResult(
  resultId: string,
  format: ExportFormat,
  destination: string,
  tableName: string,
): Promise<{ bytes: number }> {
  assertResultId(resultId);
  return withConnection(async (conn) => {
    await ensureSchema(conn);
    if (!(await resultExists(conn, resultId))) {
      fail('NOT_FOUND', 'That result is no longer available to export.');
    }
    const source = resultTable(resultId);

    if (format === 'csv') {
      await conn.run(`COPY (SELECT * FROM ${source}) TO ${quoteLiteral(destination)} (FORMAT csv, HEADER true)`);
    } else if (format === 'json') {
      await conn.run(`COPY (SELECT * FROM ${source}) TO ${quoteLiteral(destination)} (FORMAT json, ARRAY true)`);
    } else if (format === 'parquet') {
      await conn.run(`COPY (SELECT * FROM ${source}) TO ${quoteLiteral(destination)} (FORMAT parquet)`);
    } else if (format === 'markdown') {
      // A real Markdown table: header, alignment row, escaped pipes. Numeric columns are aligned
      // right so a pasted table reads the way the grid does.
      const reader = await conn.runAndReadAll(`SELECT * FROM ${source}`);
      const columns = encodeColumns(reader);
      const rows = encodeRows(reader, columns);
      const cell = (value: unknown): string => {
        if (value === null || value === undefined) return '';
        const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
        return text.replaceAll('|', '\\|').replace(/\s*[\r\n]+\s*/g, ' ');
      };
      const numeric = (index: number): boolean => {
        const type = columns[index]?.cellType;
        return type === 'number' || type === 'bigint';
      };
      const lines = [
        `| ${columns.map((c) => cell(c.name)).join(' | ')} |`,
        `| ${columns.map((_, i) => (numeric(i) ? '---:' : ':---')).join(' | ')} |`,
        ...rows.map((row) => `| ${row.map((value) => cell(value)).join(' | ')} |`),
      ];
      const { writeFileSync } = await import('node:fs');
      writeFileSync(destination, lines.join('\n') + '\n', 'utf8');
    } else {
      // INSERT statements, so a result can be replayed into any SQL database.
      const reader = await conn.runAndReadAll(`SELECT * FROM ${source}`);
      const columns = encodeColumns(reader);
      const rows = reader.getRowsJson() as unknown[][];
      const lines = rows.map((row) => {
        const values = row.map((value, index) => {
          if (value === null || value === undefined) return 'NULL';
          const cellType = columns[index]?.cellType;
          if (cellType === 'number' || cellType === 'bigint' || cellType === 'boolean') return String(value);
          if (typeof value === 'object') return quoteLiteral(JSON.stringify(value));
          return quoteLiteral(String(value));
        });
        return `INSERT INTO ${quoteIdent(tableName)} (${columns.map((c) => quoteIdent(c.name)).join(', ')}) VALUES (${values.join(', ')});`;
      });
      const { writeFileSync } = await import('node:fs');
      writeFileSync(destination, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
    }

    const { statSync } = await import('node:fs');
    return { bytes: statSync(destination).size };
  });
}

async function resultExists(conn: DuckDBConnection, resultId: string): Promise<boolean> {
  const reader = await conn.runAndReadAll(
    `SELECT count(*) AS n FROM duckdb_tables() WHERE schema_name = ${quoteLiteral(SCHEMA)} AND table_name = ${quoteLiteral(resultId)}`,
  );
  return Number((reader.getRowObjectsJson()[0] as Record<string, unknown>)?.n ?? 0) > 0;
}

function assertResultId(resultId: string): void {
  if (!/^r_[0-9a-f]{16}$/.test(resultId)) fail('BAD_REQUEST', 'That is not a valid result id.');
}

/** Keeps the most recent results and drops the rest, so the local database does not grow forever. */
export async function pruneResults(): Promise<number> {
  return withConnection(async (conn) => {
    await ensureSchema(conn);
    const reader = await conn.runAndReadAll(
      `SELECT table_name FROM duckdb_tables() WHERE schema_name = ${quoteLiteral(SCHEMA)} ORDER BY table_oid DESC`,
    );
    const names = reader.getRowObjectsJson().map((row) => String((row as Record<string, unknown>).table_name));
    const stale = names.slice(KEEP_RESULTS);
    for (const name of stale) {
      try {
        await conn.run(`DROP TABLE IF EXISTS ${quoteIdent(SCHEMA)}.${quoteIdent(name)}`);
      } catch (err) {
        log.debug(`could not drop stale result ${name}`, err);
      }
    }
    return stale.length;
  });
}

/** DuckDB error text, trimmed to the part a user can act on. */
export function duckMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const firstLine = raw.split('\n')[0]?.trim() ?? raw;
  return firstLine.replace(/^(Binder|Catalog|Parser|Conversion|Invalid Input|Out of Range) Error:\s*/, '');
}

function hintForDuckError(err: unknown): string | undefined {
  const message = err instanceof Error ? err.message : String(err);
  if (/Table with name .* does not exist/i.test(message)) {
    return 'Table names come from the endpoint\'s Query fields. Check the schema tree in the sidebar.';
  }
  if (/Referenced column .* not found/i.test(message)) {
    return 'Column names are the flattened GraphQL paths, for example address_city. Expand the table in the sidebar to see them.';
  }
  if (/QUALIFY with GROUP BY ALL/i.test(message)) {
    return 'DuckDB cannot combine QUALIFY with GROUP BY ALL. List the grouping columns explicitly.';
  }
  if (/syntax error/i.test(message)) {
    return 'The dialect is DuckDB SQL. GraphQL arguments belong in the FROM clause, e.g. FROM users(first: 100).';
  }
  return undefined;
}
