import Fastify from 'fastify';
import { execute, parse, validate, specifiedRules, NoSchemaIntrospectionCustomRule, type GraphQLError } from 'graphql';
import { buildDemoSchema, rootValue, SDL, type DemoContext } from './schema.ts';
import { datasetSummary } from './seed.ts';

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.DEMO_PORT ?? 5471);
const HOST = process.env.DEMO_HOST ?? '127.0.0.1';

const schema = buildDemoSchema();

interface GraphQLBody {
  query?: string;
  variables?: Record<string, unknown> | null;
  operationName?: string | null;
}

/** Every operation the server has served, so tests can assert round-trip counts. */
const requestLog: { document: string; variables: unknown; at: string; ms: number }[] = [];

/** Failure and rate-limit counters, keyed by the caller-supplied x-demo-run value. */
const failureCounts = new Map<string, number>();
const rateWindows = new Map<string, { windowStart: number; count: number }>();

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function formatErrors(errors: readonly GraphQLError[]) {
  return errors.map((err) => ({
    message: err.message,
    path: err.path,
    locations: err.locations,
    extensions: err.extensions,
  }));
}

async function handleGraphQL(
  body: GraphQLBody,
  headers: Record<string, string | string[] | undefined>,
  allowIntrospection: boolean,
): Promise<{ status: number; payload: unknown; retryAfter?: number }> {
  const header = (name: string): string | undefined => {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const runKey = header('x-demo-run') ?? 'default';

  // Simulated rate limiting: the fetcher must honour 429 + Retry-After.
  const rateLimit = Number(header('x-demo-rate-limit') ?? 0);
  if (rateLimit > 0) {
    const now = Date.now();
    const window = rateWindows.get(runKey);
    if (!window || now - window.windowStart >= 1000) {
      rateWindows.set(runKey, { windowStart: now, count: 1 });
    } else if (window.count >= rateLimit) {
      return {
        status: 429,
        retryAfter: 1,
        payload: { errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATE_LIMITED' } }] },
      };
    } else {
      window.count += 1;
    }
  }

  // Simulated transient failures: fail the first N requests for this run key.
  const failFirst = Number(header('x-demo-fail-first') ?? 0);
  if (failFirst > 0) {
    const seen = failureCounts.get(runKey) ?? 0;
    if (seen < failFirst) {
      failureCounts.set(runKey, seen + 1);
      return { status: 503, payload: { errors: [{ message: 'Upstream temporarily unavailable', extensions: { code: 'UNAVAILABLE' } }] } };
    }
  }

  const latency = Number(header('x-demo-latency') ?? 0);
  if (latency > 0) await sleep(Math.min(latency, 10_000));

  if (!body?.query) {
    return { status: 400, payload: { errors: [{ message: 'No GraphQL query provided' }] } };
  }

  const started = Date.now();
  let document;
  try {
    document = parse(body.query);
  } catch (err) {
    return { status: 400, payload: { errors: [{ message: err instanceof Error ? err.message : String(err) }] } };
  }

  const rules = allowIntrospection ? specifiedRules : [...specifiedRules, NoSchemaIntrospectionCustomRule];
  const validationErrors = validate(schema, document, rules);
  if (validationErrors.length) {
    return { status: 400, payload: { errors: formatErrors(validationErrors) } };
  }

  const context: DemoContext = { requestLog: [] };
  const result = await execute({
    schema,
    document,
    rootValue,
    contextValue: context,
    variableValues: body.variables ?? undefined,
    operationName: body.operationName ?? undefined,
  });

  const ms = Date.now() - started;
  requestLog.push({ document: body.query, variables: body.variables ?? null, at: new Date().toISOString(), ms });
  if (requestLog.length > 2000) requestLog.splice(0, requestLog.length - 2000);

  const payload: Record<string, unknown> = {};
  if ('data' in result) payload.data = result.data;
  if (result.errors?.length) payload.errors = formatErrors(result.errors);
  // GraphQL over HTTP: errors alongside data still return 200.
  return { status: 200, payload };
}

export function buildDemoApp() {
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });

app.addHook('onRequest', async (req, reply) => {
  // The workbench UI never calls this directly, but a browser tab might.
  reply.header('access-control-allow-origin', '*');
  reply.header('access-control-allow-headers', '*');
  reply.header('access-control-allow-methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return reply.code(204).send();
  return undefined;
});


app.post('/graphql', async (req, reply) => {
  const out = await handleGraphQL(req.body as GraphQLBody, req.headers, true);
  if (out.retryAfter) reply.header('retry-after', String(out.retryAfter));
  return reply.code(out.status).send(out.payload);
});

/** Same data, introspection refused -- exercises the workbench's SDL fallback path. */
app.post('/graphql-strict', async (req, reply) => {
  const out = await handleGraphQL(req.body as GraphQLBody, req.headers, false);
  if (out.retryAfter) reply.header('retry-after', String(out.retryAfter));
  return reply.code(out.status).send(out.payload);
});

app.get('/graphql', async (_req, reply) =>
  reply.type('text/plain').send(
    [
      'graphql-workbench demo API',
      '',
      'POST /graphql          full endpoint, introspection enabled',
      'POST /graphql-strict   same data, introspection refused (tests the SDL fallback)',
      'GET  /sdl              the schema as SDL',
      'GET  /health           seed counts',
      'GET  /_demo/requests   every operation served so far',
      'DEL  /_demo/requests   reset the log and the failure/rate-limit counters',
      '',
      'Request headers that shape behaviour:',
      '  x-demo-latency: 250        delay each response',
      '  x-demo-fail-first: 2       fail the first N requests with 503',
      '  x-demo-rate-limit: 5       429 + Retry-After beyond N requests/second',
      '  x-demo-run: <key>          scopes the two counters above',
      '',
      `seed: ${JSON.stringify(datasetSummary)}`,
    ].join('\n'),
  ),
);

app.get('/sdl', async (_req, reply) => reply.type('text/plain').send(SDL));

app.get('/health', async () => ({ ok: true, name: 'graphql-workbench-demo', seed: datasetSummary }));

app.get('/_demo/requests', async () => ({ count: requestLog.length, requests: requestLog }));

app.delete('/_demo/requests', async () => {
  requestLog.length = 0;
  failureCounts.clear();
  rateWindows.clear();
  return { ok: true };
});

  return app;
}

async function main(): Promise<void> {
  const app = buildDemoApp();
  await app.listen({ host: HOST, port: PORT });
  const summary = Object.entries(datasetSummary)
    .map(([k, v]) => `${v} ${k}`)
    .join(', ');
  console.log(`demo api   http://${HOST}:${PORT}/graphql  (${summary})`);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((err) => {
    console.error('demo api failed to start:', err);
    process.exit(1);
  });
}
