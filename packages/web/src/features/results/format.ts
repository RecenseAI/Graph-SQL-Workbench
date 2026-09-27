import type { CellType, ResultColumn } from '@gqlwb/shared';

/**
 * Cell formatting rules.
 *
 * A data grid earns its keep by making a value's type legible at a glance, so numbers are aligned
 * right with thousands separators, NULL is visibly not the string "null", timestamps lose their
 * noise, and nested values are previewed rather than dumped. Nothing here changes a value -- the
 * inspector and every export show the original.
 */

export interface FormattedCell {
  text: string;
  className: string;
  align: 'left' | 'right';
  /** True when the full value is worth opening in the inspector. */
  expandable: boolean;
  isNull: boolean;
}

const NUMBER_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 });

const TYPE_CLASS: Record<CellType, string> = {
  number: 'text-num',
  bigint: 'text-num',
  string: 'text-ink-0',
  boolean: 'text-bool',
  timestamp: 'text-temporal',
  date: 'text-temporal',
  time: 'text-temporal',
  json: 'text-gql',
  list: 'text-gql',
  struct: 'text-gql',
  blob: 'text-ink-2',
  null: 'text-nullish',
};

export function formatCell(value: unknown, column: ResultColumn | undefined): FormattedCell {
  const cellType = column?.cellType ?? 'string';

  if (value === null || value === undefined) {
    return { text: 'NULL', className: 'text-nullish italic', align: 'left', expandable: false, isNull: true };
  }

  if (cellType === 'number' || cellType === 'bigint') {
    const text = typeof value === 'number' ? NUMBER_FORMAT.format(value) : String(value);
    return { text, className: `${TYPE_CLASS[cellType]} tnum`, align: 'right', expandable: false, isNull: false };
  }

  if (cellType === 'boolean') {
    return { text: value === true ? 'true' : 'false', className: TYPE_CLASS.boolean, align: 'left', expandable: false, isNull: false };
  }

  if (cellType === 'timestamp') {
    // DuckDB hands back "2024-03-05 10:20:30"; drop a midnight time and a zero fraction.
    const text = String(value).replace(/\.0+$/, '').replace(/ 00:00:00$/, '');
    return { text, className: `${TYPE_CLASS.timestamp} tnum`, align: 'left', expandable: false, isNull: false };
  }

  if (cellType === 'date' || cellType === 'time') {
    return { text: String(value), className: `${TYPE_CLASS[cellType]} tnum`, align: 'left', expandable: false, isNull: false };
  }

  if (cellType === 'list' || cellType === 'struct' || cellType === 'json') {
    return {
      text: preview(value),
      className: TYPE_CLASS[cellType],
      align: 'left',
      expandable: true,
      isNull: false,
    };
  }

  const text = String(value);
  return {
    text,
    className: TYPE_CLASS.string,
    align: 'left',
    expandable: text.length > 80 || text.includes('\n'),
    isNull: false,
  };
}

/** A one-line preview of a nested value, kept short enough to read in a cell. */
export function preview(value: unknown, budget = 90): string {
  if (value === null || value === undefined) return 'NULL';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const inner = value.map((item) => preview(item, 24)).join(', ');
    const text = `[${inner}]`;
    return text.length > budget ? `[${value.length} items]` : text;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    const inner = entries.map(([key, item]) => `${key}: ${preview(item, 20)}`).join(', ');
    const text = `{${inner}}`;
    return text.length > budget ? `{${entries.length} fields}` : text;
  }
  if (typeof value === 'string') return value.length > budget ? `${value.slice(0, budget)}...` : value;
  return String(value);
}

/** The value as text for the clipboard and for the inspector: the original, not the display form. */
export function rawText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

/** A compact type label for a column header. */
export function shortType(duckType: string): string {
  return duckType
    .replace(/^DECIMAL\(\d+,\d+\)$/, 'DECIMAL')
    .replace('TIMESTAMP WITH TIME ZONE', 'TIMESTAMPTZ')
    .replace('VARCHAR', 'TEXT')
    .replace('BIGINT', 'INT8')
    .replace('DOUBLE', 'FLOAT8')
    .replace(/^STRUCT\(.*\)$/, 'STRUCT')
    .replace(/^MAP\(.*\)$/, 'MAP');
}

/** Initial column width, from the header and a sample of values. */
export function estimateWidth(column: ResultColumn, rows: unknown[][], index: number): number {
  const header = column.name.length + shortType(column.duckType).length + 4;
  let widest = header;
  const sample = Math.min(rows.length, 40);
  for (let r = 0; r < sample; r += 1) {
    const value = rows[r]?.[index];
    const formatted = formatCell(value, column);
    widest = Math.max(widest, formatted.text.length);
  }
  const ideal = widest * 7.3 + 22;
  return Math.round(Math.max(76, Math.min(420, ideal)));
}
