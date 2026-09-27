import type { DuckDBConnection } from '@duckdb/node-api';
import type { Catalog } from '@gqlwb/shared';
import { quoteIdent, quoteLiteral } from '../duck/sql-util.ts';
import { fail } from '../errors.ts';

/**
 * Statements the workbench answers itself.
 *
 * `SET` controls how the next fetch behaves, `SHOW`/`DESCRIBE` read the catalog rather than
 * DuckDB's own dictionary (the interesting schema is the endpoint's, not the local cache), and
 * `MATERIALIZE` pins a fetch as a real table so analysis can continue with the endpoint offline.
 * Anything not recognised here is passed straight through to DuckDB, so the full dialect stays
 * available.
 */

export interface SessionSettings {
  pushdown: boolean;
  cache: boolean;
  maxRows?: number;
  pageSize?: number;
  depth?: number;
}

const DEFAULT_SESSION: SessionSettings = { pushdown: true, cache: true };
const sessions = new Map<string, SessionSettings>();

export function getSession(connectionId: string): SessionSettings {
  const existing = sessions.get(connectionId);
  if (existing) return existing;
  const fresh = { ...DEFAULT_SESSION };
  sessions.set(connectionId, fresh);
  return fresh;
}

export function resetSession(connectionId: string): void {
  sessions.set(connectionId, { ...DEFAULT_SESSION });
}

export type Special =
  | { kind: 'set'; setting: keyof SessionSettings; value: boolean | number; message: string }
  | { kind: 'show-tables' }
  | { kind: 'show-snapshots' }
  | { kind: 'show-settings' }
  | { kind: 'describe'; table: string }
  | { kind: 'materialize'; tableExpr: string; name: string }
  | { kind: 'refresh'; name: string }
  | { kind: 'drop-snapshot'; name: string };

const BOOLEAN_SETTINGS = new Set(['pushdown', 'cache']);
const NUMBER_SETTINGS: Record<string, keyof SessionSettings> = {
  max_rows: 'maxRows',
  maxrows: 'maxRows',
  page_size: 'pageSize',
  pagesize: 'pageSize',
  depth: 'depth',
};

function parseBoolean(raw: string): boolean | null {
  const value = raw.trim().toLowerCase().replace(/^'|'$/g, '');
  if (['on', 'true', '1', 'yes', 'enabled'].includes(value)) return true;
  if (['off', 'false', '0', 'no', 'disabled'].includes(value)) return false;
  return null;
}

/**
 * Recognises a workbench statement, or returns null so the statement follows the normal path.
 */
export function classifyStatement(sql: string): Special | null {
  const trimmed = sql.trim().replace(/;\s*$/, '');

  const set = /^set\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|\s+to\s+)\s*(.+)$/is.exec(trimmed);
  if (set) {
    const rawName = (set[1] ?? '').toLowerCase();
    const rawValue = set[2] ?? '';
    if (BOOLEAN_SETTINGS.has(rawName)) {
      const value = parseBoolean(rawValue);
      if (value === null) {
        fail('BAD_REQUEST', `SET ${rawName} takes on or off, not ${rawValue.trim()}.`);
      }
      return {
        kind: 'set',
        setting: rawName as keyof SessionSettings,
        value,
        message: `${rawName} is now ${value ? 'on' : 'off'} for this connection.`,
      };
    }
    const numberKey = NUMBER_SETTINGS[rawName];
    if (numberKey) {
      const value = Number(rawValue.trim().replace(/^'|'$/g, '').replace(/_/g, ''));
      if (!Number.isFinite(value) || value <= 0) {
        fail('BAD_REQUEST', `SET ${rawName} needs a positive number, not ${rawValue.trim()}.`);
      }
      return {
        kind: 'set',
        setting: numberKey,
        value: Math.floor(value),
        message: `${rawName} is now ${Math.floor(value).toLocaleString('en-US')} for this connection.`,
      };
    }
    // Not one of ours: let DuckDB handle its own settings.
    return null;
  }

  if (/^show\s+tables$/i.test(trimmed)) return { kind: 'show-tables' };
  if (/^show\s+snapshots$/i.test(trimmed)) return { kind: 'show-snapshots' };
  if (/^show\s+settings$/i.test(trimmed)) return { kind: 'show-settings' };

  const describe = /^(?:describe|desc)\s+(?:table\s+)?["']?([A-Za-z_][A-Za-z0-9_]*)["']?$/i.exec(trimmed);
  if (describe?.[1]) return { kind: 'describe', table: describe[1] };

  const showColumns = /^show\s+columns\s+(?:from|in)\s+["']?([A-Za-z_][A-Za-z0-9_]*)["']?$/i.exec(trimmed);
  if (showColumns?.[1]) return { kind: 'describe', table: showColumns[1] };

  const materialize = /^materialize\s+(.+?)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/is.exec(trimmed);
  if (materialize?.[1] && materialize[2]) {
    return { kind: 'materialize', tableExpr: materialize[1].trim(), name: materialize[2] };
  }

  const refresh = /^refresh\s+(?:snapshot\s+)?["']?([A-Za-z_][A-Za-z0-9_]*)["']?$/i.exec(trimmed);
  if (refresh?.[1]) return { kind: 'refresh', name: refresh[1] };

  const dropSnapshot = /^drop\s+snapshot\s+(?:if\s+exists\s+)?["']?([A-Za-z_][A-Za-z0-9_]*)["']?$/i.exec(trimmed);
  if (dropSnapshot?.[1]) return { kind: 'drop-snapshot', name: dropSnapshot[1] };

  return null;
}

/** A row set built from in-memory values, so catalog answers flow through the normal result path. */
export function valuesQuery(columns: string[], rows: (string | number | boolean | null)[][]): string {
  const columnList = columns.map(quoteIdent).join(', ');
  if (rows.length === 0) {
    // An empty result still needs its columns, so select zero rows of correctly named NULLs.
    const nulls = columns.map((c) => `NULL::VARCHAR AS ${quoteIdent(c)}`).join(', ');
    return `SELECT ${nulls} WHERE false`;
  }
  const tuples = rows
    .map(
      (row) =>
        `(${row
          .map((cell) => {
            if (cell === null) return 'NULL';
            if (typeof cell === 'number') return String(cell);
            if (typeof cell === 'boolean') return cell ? 'TRUE' : 'FALSE';
            return quoteLiteral(cell);
          })
          .join(', ')})`,
    )
    .join(', ');
  return `SELECT * FROM (VALUES ${tuples}) AS t(${columnList})`;
}

export function showTablesQuery(catalog: Catalog): string {
  const rows = catalog.tables.map((table) => [
    table.name,
    table.isChild ? 'child' : 'table',
    table.pagination.style,
    table.columns.filter((c) => !c.synthetic).length,
    table.rowTypeName,
    table.primaryKey ?? null,
    table.isChild ? (table.parent ?? null) : null,
    table.description ? table.description.replace(/\s+/g, ' ').slice(0, 160) : null,
  ]);
  return valuesQuery(
    ['table_name', 'kind', 'pagination', 'columns', 'graphql_type', 'primary_key', 'parent', 'description'],
    rows,
  );
}

export function describeTableQuery(catalog: Catalog, tableName: string): string {
  const table = catalog.tables.find((t) => t.name.toLowerCase() === tableName.toLowerCase());
  if (!table) {
    fail(
      'UNKNOWN_TABLE',
      `There is no table called "${tableName}" in this schema.`,
      undefined,
      'Run SHOW TABLES, or expand the schema tree in the sidebar.',
    );
  }
  const rows = table.columns.map((column) => [
    column.name,
    column.duckType,
    column.graphqlType,
    column.nullable ? 'YES' : 'NO',
    column.path.length ? column.path.join('.') : null,
    column.synthetic ? 'workbench' : 'endpoint',
    column.enumValues?.length ? column.enumValues.join(' | ') : null,
    column.deprecationReason ?? null,
    column.description ? column.description.replace(/\s+/g, ' ').slice(0, 160) : null,
  ]);
  return valuesQuery(
    ['column_name', 'duckdb_type', 'graphql_type', 'nullable', 'graphql_path', 'source', 'enum_values', 'deprecated', 'description'],
    rows,
  );
}

export function showSettingsQuery(session: SessionSettings, defaults: { maxRows: number; pageSize: number; depth: number }): string {
  const rows: (string | number | boolean | null)[][] = [
    ['pushdown', session.pushdown ? 'on' : 'off', 'Send WHERE filters to the endpoint as arguments where possible'],
    ['cache', session.cache ? 'on' : 'off', 'Reuse previously fetched pages'],
    ['max_rows', String(session.maxRows ?? defaults.maxRows), 'Row budget per table per statement'],
    ['page_size', String(session.pageSize ?? defaults.pageSize), 'Rows requested per GraphQL page'],
    ['depth', String(session.depth ?? defaults.depth), 'How deep nested objects are flattened into columns'],
  ];
  return valuesQuery(['setting', 'value', 'meaning'], rows);
}

/* ---------------------------------------------------------------- snapshots */

const SNAPSHOT_REGISTRY = '_gqlwb_snapshots';

export async function ensureSnapshotRegistry(conn: DuckDBConnection): Promise<void> {
  await conn.run(`CREATE TABLE IF NOT EXISTS ${quoteIdent(SNAPSHOT_REGISTRY)} (
    name VARCHAR PRIMARY KEY,
    connection_id VARCHAR,
    table_name VARCHAR,
    table_expr VARCHAR,
    row_count BIGINT,
    created_at TIMESTAMP
  )`);
}

export interface SnapshotRecord {
  name: string;
  connectionId: string;
  tableName: string;
  tableExpr: string;
  rowCount: number;
  createdAt: string;
}

export async function recordSnapshot(conn: DuckDBConnection, record: Omit<SnapshotRecord, 'createdAt'>): Promise<void> {
  await ensureSnapshotRegistry(conn);
  await conn.run(`DELETE FROM ${quoteIdent(SNAPSHOT_REGISTRY)} WHERE name = ${quoteLiteral(record.name)}`);
  await conn.run(
    `INSERT INTO ${quoteIdent(SNAPSHOT_REGISTRY)} VALUES (
      ${quoteLiteral(record.name)},
      ${quoteLiteral(record.connectionId)},
      ${quoteLiteral(record.tableName)},
      ${quoteLiteral(record.tableExpr)},
      ${record.rowCount},
      now()
    )`,
  );
}

export async function getSnapshot(conn: DuckDBConnection, name: string): Promise<SnapshotRecord | null> {
  await ensureSnapshotRegistry(conn);
  const reader = await conn.runAndReadAll(
    `SELECT * FROM ${quoteIdent(SNAPSHOT_REGISTRY)} WHERE lower(name) = ${quoteLiteral(name.toLowerCase())}`,
  );
  const row = reader.getRowObjectsJson()[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    name: String(row.name),
    connectionId: String(row.connection_id),
    tableName: String(row.table_name),
    tableExpr: String(row.table_expr),
    rowCount: Number(row.row_count),
    createdAt: String(row.created_at),
  };
}

export async function listSnapshots(conn: DuckDBConnection): Promise<SnapshotRecord[]> {
  await ensureSnapshotRegistry(conn);
  const reader = await conn.runAndReadAll(`SELECT * FROM ${quoteIdent(SNAPSHOT_REGISTRY)} ORDER BY created_at DESC`);
  return reader.getRowObjectsJson().map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      name: String(row.name),
      connectionId: String(row.connection_id),
      tableName: String(row.table_name),
      tableExpr: String(row.table_expr),
      rowCount: Number(row.row_count),
      createdAt: String(row.created_at),
    };
  });
}

export async function dropSnapshot(conn: DuckDBConnection, name: string): Promise<boolean> {
  const existing = await getSnapshot(conn, name);
  if (!existing) return false;
  await conn.run(`DROP TABLE IF EXISTS ${quoteIdent(existing.name)}`);
  await conn.run(`DELETE FROM ${quoteIdent(SNAPSHOT_REGISTRY)} WHERE name = ${quoteLiteral(existing.name)}`);
  return true;
}

export function showSnapshotsQuery(snapshots: SnapshotRecord[]): string {
  return valuesQuery(
    ['snapshot', 'source', 'rows', 'created_at'],
    snapshots.map((s) => [s.name, s.tableExpr, s.rowCount, s.createdAt]),
  );
}

/** Snapshot names must not shadow a catalog table, or the same SQL would mean two things. */
export function assertSnapshotName(name: string, catalog: Catalog): void {
  if (catalog.tables.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
    fail(
      'BAD_REQUEST',
      `"${name}" is already a table in this schema, so a snapshot cannot use that name.`,
      undefined,
      `Try MATERIALIZE ... AS ${name}_snapshot instead.`,
    );
  }
  if (/^(wb_|_gqlwb)/i.test(name)) {
    fail('BAD_REQUEST', `Snapshot names cannot start with "wb_" or "_gqlwb", which the workbench reserves.`);
  }
}
