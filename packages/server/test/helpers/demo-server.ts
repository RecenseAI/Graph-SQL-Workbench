import type { FastifyInstance } from 'fastify';
import { connectionSchema, type ConnectionConfig } from '@gqlwb/shared';
import { buildDemoApp } from '../../../demo-api/src/server.ts';

export interface DemoHandle {
  app: FastifyInstance;
  /** Base URL, e.g. http://127.0.0.1:53211 */
  origin: string;
  endpoint: string;
  strictEndpoint: string;
  stop: () => Promise<void>;
  /** Operations the demo API has served since the last reset. */
  requests: () => Promise<{ count: number; requests: { document: string; variables: unknown }[] }>;
  reset: () => Promise<void>;
}

/**
 * Boots the bundled demo API on an ephemeral port. Tests get a real HTTP endpoint -- the
 * fetcher's retry, pagination and cancellation paths only mean something over a real socket.
 */
export async function startDemoApi(): Promise<DemoHandle> {
  const app = buildDemoApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('demo api did not bind a port');
  const origin = `http://127.0.0.1:${address.port}`;

  const handle: DemoHandle = {
    app,
    origin,
    endpoint: `${origin}/graphql`,
    strictEndpoint: `${origin}/graphql-strict`,
    stop: () => app.close(),
    requests: async () => {
      const res = await app.inject({ method: 'GET', url: '/_demo/requests' });
      return res.json();
    },
    reset: async () => {
      await app.inject({ method: 'DELETE', url: '/_demo/requests' });
    },
  };
  await handle.reset();
  return handle;
}

let counter = 0;

/** A connection config pointing at a demo endpoint, with test-friendly defaults. */
export function demoConnection(endpoint: string, overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  counter += 1;
  const now = new Date().toISOString();
  return connectionSchema.parse({
    id: `test-conn-${counter}`,
    name: 'Demo',
    endpoint,
    createdAt: now,
    updatedAt: now,
    // Small pages so pagination loops actually loop in tests.
    pageSize: 50,
    maxRows: 5000,
    timeoutMs: 15_000,
    cacheTtlSeconds: 0,
    ...overrides,
  });
}
