import type {
  Catalog,
  ResultColumn,
  ConnectionConfig,
  ConnectionInput,
  GraphQLRunRequest,
  GraphQLRunResponse,
  HistoryEntry,
  QueryResult,
  RunEvent,
  RunRequest,
} from '@gqlwb/shared';

export interface ApiErrorShape {
  code: string;
  message: string;
  detail?: unknown;
  hint?: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly payload: ApiErrorShape,
  ) {
    super(payload.message);
    this.name = 'ApiError';
  }
  get code(): string {
    return this.payload.code;
  }
  get hint(): string | undefined {
    return this.payload.hint;
  }
  get detail(): unknown {
    return this.payload.detail;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (err) {
    throw new ApiError(0, {
      code: 'OFFLINE',
      message: 'Cannot reach the workbench API.',
      hint: 'Is the server running? Start it with "npm run dev:api".',
      detail: err instanceof Error ? err.message : err,
    });
  }
  const text = await res.text();
  const body: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const shape = (body as { error?: ApiErrorShape } | null)?.error;
    throw new ApiError(res.status, shape ?? { code: 'HTTP_' + res.status, message: res.statusText || 'Request failed' });
  }
  return body as T;
}

export interface HealthInfo {
  ok: boolean;
  name: string;
  version: string;
  engine: string;
  node: string;
  platform: string;
  dataDir: string;
  uptimeSeconds: number;
}

export const api = {
  health: () => request<HealthInfo>('/api/health'),

  listConnections: () => request<{ connections: ConnectionConfig[]; activeConnectionId?: string }>('/api/connections'),
  createConnection: (input: ConnectionInput) =>
    request<{ connection: ConnectionConfig }>('/api/connections', { method: 'POST', body: JSON.stringify(input) }),
  updateConnection: (id: string, input: Partial<ConnectionInput>) =>
    request<{ connection: ConnectionConfig }>(`/api/connections/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  deleteConnection: (id: string) => request<{ ok: true }>(`/api/connections/${id}`, { method: 'DELETE' }),
  activateConnection: (id: string) => request<{ ok: true }>(`/api/connections/${id}/activate`, { method: 'POST' }),

  testConnection: (id: string) =>
    request<{ ok: boolean; ms: number; message?: string }>(`/api/connections/${id}/test`, { method: 'POST' }),
  /** Drops the cached schema, fetched pages and session settings for a connection. */
  refreshConnection: (id: string) =>
    request<{ ok: true; cachedFetchesRemoved: number }>(`/api/connections/${id}/refresh`, { method: 'POST' }),
  cacheStats: () => request<{ entries: number; bytes: number; rows: number }>('/api/cache'),

  introspect: (id: string, opts?: { refresh?: boolean }) =>
    request<{ catalog: Catalog }>(`/api/connections/${id}/introspect`, {
      method: 'POST',
      body: JSON.stringify(opts ?? {}),
    }),

  runGraphQL: (body: GraphQLRunRequest) =>
    request<GraphQLRunResponse>('/api/graphql', { method: 'POST', body: JSON.stringify(body) }),

  resultRows: (resultId: string, offset: number, limit: number) =>
    request<{ rows: unknown[][]; offset: number; rowCount: number }>(
      `/api/result/${resultId}/rows?offset=${offset}&limit=${limit}`,
    ),
  /** Sorting and filtering run in DuckDB over the whole result, not just the loaded page. */
  sortResult: (
    resultId: string,
    orderBy: string | null,
    descending: boolean,
    filter: string,
    offset = 0,
    limit = 300,
  ) =>
    request<{ rows: unknown[][]; columns: ResultColumn[]; offset: number; rowCount: number; totalRowCount: number }>(
      `/api/result/${resultId}/view`,
      { method: 'POST', body: JSON.stringify({ orderBy, descending, filter, offset, limit }) },
    ),

  cancelRun: (runId: string) => request<{ ok: boolean }>(`/api/run/${runId}/cancel`, { method: 'POST' }),

  history: () => request<{ entries: HistoryEntry[] }>('/api/history'),
  clearHistory: () => request<{ ok: true }>('/api/history', { method: 'DELETE' }),

  exportUrl: (resultId: string, format: 'csv' | 'json' | 'parquet' | 'markdown' | 'sql') =>
    `/api/result/${resultId}/export?format=${format}`,
};

/**
 * Streams a run over SSE. Returns an abort handle; `onEvent` sees every server event in
 * order, so the UI can show the plan and fetch progress before any rows exist.
 */
export function runSql(
  body: RunRequest,
  onEvent: (event: RunEvent) => void,
): { abort: () => void; done: Promise<void> } {
  const controller = new AbortController();
  const done = (async () => {
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      let payload: ApiErrorShape = { code: 'HTTP_' + res.status, message: res.statusText || 'Run failed' };
      try {
        const parsed = JSON.parse(text) as { error?: ApiErrorShape };
        if (parsed.error) payload = parsed.error;
      } catch {
        /* keep the fallback */
      }
      throw new ApiError(res.status, payload);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done: finished, value } = await reader.read();
      if (finished) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line; each frame may carry several data: lines.
      let split = buffer.indexOf('\n\n');
      while (split !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const payload = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('');
        if (payload) {
          try {
            onEvent(JSON.parse(payload) as RunEvent);
          } catch {
            /* ignore malformed frames rather than killing the stream */
          }
        }
        split = buffer.indexOf('\n\n');
      }
    }
  })();
  return { abort: () => controller.abort(), done };
}

export type { QueryResult };
