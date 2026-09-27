/** Server-sent events emitted while a run is in flight. */

import type { FetchPlanEntry, QueryResult } from './query.ts';

export type RunEvent =
  | { type: 'started'; runId: string; statements: number }
  | { type: 'statement'; index: number; sql: string }
  | { type: 'plan'; index: number; plan: FetchPlanEntry[] }
  | { type: 'fetch'; index: number; table: string; pages: number; rows: number; done: boolean }
  | { type: 'shred'; index: number; table: string; rows: number }
  | { type: 'executing'; index: number }
  | { type: 'result'; index: number; result: QueryResult }
  | { type: 'warning'; index: number; message: string }
  | { type: 'error'; index: number | null; message: string; detail?: unknown }
  | { type: 'done'; runId: string; ms: number };

export const SSE_EVENT = 'run';
