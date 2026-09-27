/** Plan, statistics and result contracts for one SQL run. */

import type { PaginationStyle } from './catalog.ts';

export interface PushedPredicate {
  /** SQL column the predicate came from. */
  column: string;
  op: string;
  value: unknown;
  /** GraphQL argument it was written into, e.g. `where.status._eq`. */
  arg: string;
  /** Which profile/rule produced the mapping, for display. */
  via: string;
}

export interface SkippedPredicate {
  column: string;
  op: string;
  /** Why this predicate stayed local -- shown in the Plan panel. */
  reason: string;
}

export interface FetchPlanEntry {
  /** Virtual table name from the catalog. */
  table: string;
  /** SQL alias, or the table name when unaliased. */
  alias: string;
  rootField: string;
  /** Arguments actually sent, merged from explicit `table(args)` and pushdown. */
  args: Record<string, unknown>;
  /** Arguments the user wrote explicitly in `table(...)`. */
  explicitArgs: Record<string, unknown>;
  pushed: PushedPredicate[];
  skipped: SkippedPredicate[];
  /** Leaf GraphQL paths selected, dot-joined. `['*']` when everything in depth. */
  projected: string[];
  pagination: PaginationStyle;
  maxRows: number;
  pageSize: number;
  /** The exact GraphQL document sent. */
  document: string;
  variables: Record<string, unknown>;
  /** Child tables materialised from this fetch. */
  childTables: string[];
  cacheKey: string;
}

export interface FetchStats {
  table: string;
  pages: number;
  rows: number;
  bytes: number;
  ms: number;
  cache: 'hit' | 'miss' | 'off';
  /** True when the row budget stopped the pagination loop early. */
  truncated: boolean;
  requests: number;
  retries: number;
}

export type CellType = 'number' | 'bigint' | 'string' | 'boolean' | 'timestamp' | 'date' | 'time' | 'json' | 'list' | 'struct' | 'blob' | 'null';

export interface ResultColumn {
  name: string;
  duckType: string;
  cellType: CellType;
  nullCount: number;
  /** Populated for numeric columns, used by the grid header sparkbar and charts. */
  min?: number;
  max?: number;
  distinctApprox?: number;
}

export interface Timings {
  total: number;
  plan: number;
  fetch: number;
  shred: number;
  execute: number;
}

export interface QueryResult {
  runId: string;
  /** Index of the statement within the submitted script. */
  index: number;
  sql: string;
  /** `select` produces a grid; `command` produces a message (SET, MATERIALIZE, ...). */
  kind: 'select' | 'command';
  resultId: string;
  columns: ResultColumn[];
  /** The first page of rows, row-major. Further pages come from `/api/result/:id/rows`. */
  rows: unknown[][];
  /** Total rows in the result set, not just this page. */
  rowCount: number;
  offset: number;
  message?: string;
  timings: Timings;
  plan: FetchPlanEntry[];
  stats: FetchStats[];
  explain?: string;
  warnings: string[];
}

export interface RunRequest {
  connectionId: string;
  sql: string;
  /** Run only this statement of the script when set. */
  statementIndex?: number;
  /** Per-run overrides. */
  maxRows?: number;
  pushdown?: boolean;
  cache?: boolean;
  explain?: boolean;
  pageRows?: number;
}

export interface GraphQLRunRequest {
  connectionId: string;
  document: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

export interface GraphQLRunResponse {
  data: unknown;
  errors?: { message: string; path?: (string | number)[]; extensions?: Record<string, unknown> }[];
  status: number;
  ms: number;
  bytes: number;
}

export interface HistoryEntry {
  id: string;
  connectionId: string;
  connectionName: string;
  sql: string;
  at: string;
  ms: number;
  rows: number;
  ok: boolean;
  error?: string;
}
