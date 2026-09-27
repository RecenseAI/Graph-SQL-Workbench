import type { DuckDBResultReader } from '@duckdb/node-api';
import type { CellType, ResultColumn } from '@gqlwb/shared';

/**
 * Converts a DuckDB result into JSON the browser can hold without losing meaning.
 *
 * DuckDB's JSON converter hands back BIGINT, HUGEINT and DECIMAL as strings, because they can
 * exceed what a JS number represents. Silently coercing all of them to numbers would corrupt large
 * ids; leaving them all as strings would break sorting and charts. So each value is converted when
 * it is exactly representable and left as a string when it is not -- and the column's declared
 * type travels alongside, so the grid always knows how to align and format it.
 */

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

export function cellTypeFor(duckType: string): CellType {
  const upper = duckType.toUpperCase();
  if (upper.endsWith('[]') || upper.startsWith('LIST')) return 'list';
  if (upper.startsWith('STRUCT') || upper.startsWith('MAP') || upper.startsWith('UNION')) return 'struct';
  if (upper === 'JSON') return 'json';
  if (upper.startsWith('TIMESTAMP') || upper.startsWith('DATETIME')) return 'timestamp';
  if (upper === 'DATE') return 'date';
  if (upper.startsWith('TIME')) return 'time';
  if (upper === 'BOOLEAN') return 'boolean';
  if (upper === 'BLOB' || upper === 'BYTEA' || upper === 'BIT') return 'blob';
  if (/^(HUGEINT|UHUGEINT)/.test(upper)) return 'bigint';
  if (/^(BIGINT|UBIGINT)/.test(upper)) return 'bigint';
  if (/^(TINYINT|SMALLINT|INTEGER|INT|UTINYINT|USMALLINT|UINTEGER)/.test(upper)) return 'number';
  if (/^(FLOAT|DOUBLE|REAL|DECIMAL|NUMERIC)/.test(upper)) return 'number';
  if (/^(VARCHAR|TEXT|STRING|CHAR|UUID|ENUM|INTERVAL)/.test(upper)) return 'string';
  return 'string';
}

/** True for types whose values arrive as strings but represent numbers. */
function isNumericText(cellType: CellType): boolean {
  return cellType === 'number' || cellType === 'bigint';
}

/**
 * Narrows a numeric string to a number when that is lossless. Anything bigger than 2^53-1, or
 * carrying more precision than a double holds, stays a string so no digits are invented or lost.
 */
export function normaliseNumeric(value: unknown, cellType: CellType): unknown {
  if (typeof value === 'number' || value === null || value === undefined) return value;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return value;
  if (Math.abs(parsed) > MAX_SAFE) return value;
  if (cellType === 'bigint') {
    // Integers only: a round trip must reproduce the original digits exactly.
    return String(parsed) === trimmed ? parsed : value;
  }
  // DECIMAL arrives padded with trailing zeros ("7181.890000000"), so a string round trip never
  // matches. A double holds 15 significant digits exactly; beyond that, keep the text.
  return countSignificantDigits(trimmed) <= 15 ? parsed : value;
}

function countSignificantDigits(text: string): number {
  return text.replace(/[-+.]/g, '').replace(/^0+/, '').replace(/0+$/, '').length || 1;
}

export interface EncodedPage {
  columns: ResultColumn[];
  rows: unknown[][];
}

/** Column metadata for a reader, before any statistics are attached. */
export function encodeColumns(reader: DuckDBResultReader): ResultColumn[] {
  const names = reader.columnNames();
  const types = reader.columnTypes().map((t) => String(t));
  return names.map((name, index) => ({
    name,
    duckType: types[index] ?? 'VARCHAR',
    cellType: cellTypeFor(types[index] ?? 'VARCHAR'),
    nullCount: 0,
  }));
}

/** Rows as a row-major array, with each value made JSON-safe for its column type. */
export function encodeRows(reader: DuckDBResultReader, columns: ResultColumn[]): unknown[][] {
  const raw = reader.getRowsJson() as unknown[][];
  return raw.map((row) =>
    row.map((value, index) => {
      const column = columns[index];
      if (!column) return value;
      if (value === null || value === undefined) return null;
      if (isNumericText(column.cellType)) return normaliseNumeric(value, column.cellType);
      if (column.cellType === 'json' && typeof value === 'string') {
        // JSON columns arrive as text; parsing them lets the grid render and expand them.
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      }
      if (column.cellType === 'list' || column.cellType === 'struct') return normaliseNested(value);
      return value;
    }),
  );
}

/** Numbers hidden inside lists and structs get the same treatment as top-level values. */
function normaliseNested(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normaliseNested);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, normaliseNested(v)]));
  }
  if (typeof value === 'string') {
    // Only convert when the whole string is a plain number, so ids and codes stay text.
    if (/^-?\d+$/.test(value)) {
      const parsed = Number(value);
      return Number.isSafeInteger(parsed) ? parsed : value;
    }
    if (/^-?\d+\.\d+$/.test(value)) {
      const parsed = Number(value);
      return Number.isFinite(parsed) && Math.abs(parsed) <= MAX_SAFE ? parsed : value;
    }
  }
  return value;
}

export function encodePage(reader: DuckDBResultReader): EncodedPage {
  const columns = encodeColumns(reader);
  const rows = encodeRows(reader, columns);
  refineJsonColumns(columns, rows);
  return { columns, rows };
}

/**
 * DuckDB's JSON logical type is reported as VARCHAR, so a column holding JSON documents is
 * indistinguishable from one holding text -- including the `_raw` escape-hatch column, which is
 * always JSON. Sampling the page settles it: if every value examined parses as a JSON object or
 * array, the column is treated as JSON so the grid can pretty-print and expand it. Ordinary text
 * is never mistaken for JSON, because a bare word or number does not parse as either shape.
 */
export function refineJsonColumns(columns: ResultColumn[], rows: unknown[][]): void {
  const SAMPLE = 20;
  columns.forEach((column, index) => {
    if (column.cellType !== 'string') return;
    let examined = 0;
    let parsed = 0;
    for (let r = 0; r < rows.length && examined < SAMPLE; r += 1) {
      const value = rows[r]?.[index];
      if (value === null || value === undefined) continue;
      examined += 1;
      if (typeof value !== 'string') return;
      const trimmed = value.trim();
      if (!(trimmed.startsWith('{') && trimmed.endsWith('}')) && !(trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        return;
      }
      try {
        JSON.parse(trimmed);
        parsed += 1;
      } catch {
        return;
      }
    }
    if (examined === 0 || parsed !== examined) return;
    column.cellType = 'json';
    // Convert the whole page, not just the sample.
    for (let r = 0; r < rows.length; r += 1) {
      const value = rows[r]?.[index];
      if (typeof value !== 'string') continue;
      try {
        const row = rows[r];
        if (row) row[index] = JSON.parse(value);
      } catch {
        /* leave the original text in place */
      }
    }
  });
}
