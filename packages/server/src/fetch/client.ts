import type { ConnectionConfig } from '@gqlwb/shared';
import { interpolateEnv } from '../store/workspace.ts';
import { fail, WorkbenchError } from '../errors.ts';
import { limiterFor } from './limiter.ts';
import { logger } from '../log.ts';

const log = logger('fetch');

export interface GraphQLErrorShape {
  message: string;
  path?: (string | number)[];
  locations?: { line: number; column: number }[];
  extensions?: Record<string, unknown>;
}

export interface GraphQLCallResult {
  data: unknown;
  errors: GraphQLErrorShape[];
  status: number;
  ms: number;
  bytes: number;
  attempts: number;
  retries: number;
}

export interface GraphQLCallOptions {
  document: string;
  variables?: Record<string, unknown>;
  operationName?: string;
  signal?: AbortSignal;
  /** Extra headers merged last, used by tests to drive the demo API's failure switches. */
  extraHeaders?: Record<string, string>;
}

/** Status codes worth trying again: rate limits and transient gateway failures. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);
const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 300;
const MAX_BACKOFF_MS = 8000;

export function buildHeaders(conn: ConnectionConfig, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/graphql-response+json, application/json',
  };

  for (const header of conn.headers) {
    if (header.enabled === false) continue;
    if (!header.name.trim()) continue;
    headers[header.name.toLowerCase()] = interpolateEnv(header.value);
  }

  const auth = conn.auth;
  if (auth.kind === 'bearer' && auth.token) {
    headers.authorization = `Bearer ${interpolateEnv(auth.token)}`;
  } else if (auth.kind === 'basic' && auth.user != null) {
    const raw = `${interpolateEnv(auth.user)}:${interpolateEnv(auth.pass ?? '')}`;
    headers.authorization = `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
  } else if (auth.kind === 'header' && auth.headerName && auth.token) {
    headers[auth.headerName.toLowerCase()] = interpolateEnv(auth.token);
  }

  for (const [name, value] of Object.entries(extra ?? {})) {
    headers[name.toLowerCase()] = value;
  }
  return headers;
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new WorkbenchError('CANCELLED', 'Cancelled while waiting to retry'));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });

/** Honours `Retry-After` as either seconds or an HTTP date. */
function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

/**
 * One GraphQL call, with rate limiting, bounded retries and honest error reporting.
 *
 * A GraphQL endpoint can return errors three different ways -- an HTTP failure, an `errors`
 * array with no data, or an `errors` array alongside partial data. All three are surfaced;
 * only the caller can decide whether partial data is usable.
 */
export async function callGraphQL(conn: ConnectionConfig, options: GraphQLCallOptions): Promise<GraphQLCallResult> {
  const limiter = limiterFor(conn.id, conn.concurrency, conn.requestsPerSecond);
  const headers = buildHeaders(conn, options.extraHeaders);
  const body = JSON.stringify({
    query: options.document,
    ...(options.variables && Object.keys(options.variables).length ? { variables: options.variables } : {}),
    ...(options.operationName ? { operationName: options.operationName } : {}),
  });

  let attempts = 0;
  let lastError: WorkbenchError | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    attempts = attempt;
    if (options.signal?.aborted) fail('CANCELLED', 'Run cancelled');

    const started = Date.now();
    const timeout = AbortSignal.timeout(conn.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

    let response: Response;
    try {
      response = await limiter.run(() => fetch(conn.endpoint, { method: 'POST', headers, body, signal }));
    } catch (err) {
      if (options.signal?.aborted) fail('CANCELLED', 'Run cancelled');
      const message = err instanceof Error ? err.message : String(err);
      const timedOut = /timeout|aborted/i.test(message);
      lastError = new WorkbenchError(
        timedOut ? 'FETCH_FAILED' : 'CONNECTION_FAILED',
        timedOut
          ? `The endpoint did not respond within ${conn.timeoutMs}ms.`
          : `Could not reach ${conn.endpoint}: ${message}`,
        message,
        timedOut ? 'Raise the timeout on the connection, or fetch fewer rows per page.' : 'Check the URL, and whether the endpoint needs a VPN or auth header.',
      );
      // A network failure is worth one more try; a timeout usually is not.
      if (attempt < MAX_ATTEMPTS && !timedOut) {
        await sleep(Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1)), options.signal);
        continue;
      }
      throw lastError;
    }

    const text = await response.text();
    const ms = Date.now() - started;
    const bytes = Buffer.byteLength(text, 'utf8');

    if (!response.ok) {
      const retryable = RETRYABLE_STATUS.has(response.status);
      lastError = new WorkbenchError(
        'FETCH_FAILED',
        `The endpoint returned HTTP ${response.status} ${response.statusText}`.trim(),
        text.slice(0, 2000),
        response.status === 401 || response.status === 403
          ? 'The request was rejected as unauthorised. Check the auth token or header on this connection.'
          : response.status === 429
            ? 'The endpoint is rate limiting. Lower requests-per-second on the connection.'
            : undefined,
      );
      if (retryable && attempt < MAX_ATTEMPTS) {
        const after = retryAfterMs(response.headers.get('retry-after'));
        const backoff = after ?? Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1));
        log.debug(`HTTP ${response.status} from ${conn.endpoint}, retrying in ${backoff}ms (attempt ${attempt})`);
        await sleep(backoff, options.signal);
        continue;
      }
      throw lastError;
    }

    let payload: { data?: unknown; errors?: GraphQLErrorShape[] };
    try {
      payload = text ? (JSON.parse(text) as typeof payload) : {};
    } catch {
      fail(
        'GRAPHQL_ERROR',
        'The endpoint returned a response that is not JSON.',
        text.slice(0, 500),
        'Is this URL really a GraphQL endpoint? A login redirect or HTML error page looks like this.',
      );
    }

    return {
      data: payload.data ?? null,
      errors: payload.errors ?? [],
      status: response.status,
      ms,
      bytes,
      attempts: attempt,
      retries: attempt - 1,
    };
  }

  throw lastError ?? new WorkbenchError('FETCH_FAILED', 'The request failed for an unknown reason.');
}

/** Formats GraphQL errors for a message panel: message plus the path that produced it. */
export function formatGraphQLErrors(errors: GraphQLErrorShape[]): string {
  return errors
    .map((err) => {
      const path = err.path?.length ? ` at ${err.path.join('.')}` : '';
      const code = typeof err.extensions?.code === 'string' ? ` [${err.extensions.code}]` : '';
      return `${err.message}${path}${code}`;
    })
    .join('; ');
}
