import { createHash } from 'node:crypto';
import {
  buildClientSchema,
  buildSchema,
  getIntrospectionQuery,
  type GraphQLSchema,
  type IntrospectionQuery,
} from 'graphql';
import type { Catalog, ConnectionConfig } from '@gqlwb/shared';
import { callGraphQL, formatGraphQLErrors } from '../fetch/client.ts';
import { buildCatalog } from './build.ts';
import { fail, WorkbenchError } from '../errors.ts';
import { logger } from '../log.ts';

const log = logger('catalog');

/**
 * Introspection is the happy path, but plenty of production endpoints disable it. When that
 * happens the user can paste SDL onto the connection instead, and everything downstream behaves
 * identically -- the catalog does not care where the schema came from.
 */

/** Progressively more conservative introspection queries, for servers that reject newer fields. */
function introspectionVariants(): { label: string; query: string }[] {
  return [
    {
      label: 'full',
      query: getIntrospectionQuery({
        descriptions: true,
        specifiedByUrl: false,
        directiveIsRepeatable: false,
        schemaDescription: false,
        inputValueDeprecation: false,
      }),
    },
    { label: 'no-descriptions', query: getIntrospectionQuery({ descriptions: false }) },
  ];
}

export async function introspectSchema(
  conn: ConnectionConfig,
  signal?: AbortSignal,
): Promise<{ schema: GraphQLSchema; source: 'introspection' | 'sdl' }> {
  // An explicit SDL override wins: the user has told us not to trust introspection.
  if (conn.sdl && conn.sdl.trim()) {
    try {
      return { schema: buildSchema(conn.sdl, { assumeValidSDL: false }), source: 'sdl' };
    } catch (err) {
      fail(
        'SCHEMA_INVALID',
        'The SDL saved on this connection could not be parsed.',
        err instanceof Error ? err.message : err,
        'Fix or clear the SDL on the connection to fall back to introspection.',
      );
    }
  }

  const failures: string[] = [];
  for (const variant of introspectionVariants()) {
    try {
      const result = await callGraphQL(conn, { document: variant.query, signal });
      if (result.errors.length && !result.data) {
        failures.push(`${variant.label}: ${formatGraphQLErrors(result.errors)}`);
        continue;
      }
      const introspection = result.data as IntrospectionQuery | null;
      if (!introspection?.__schema) {
        failures.push(`${variant.label}: the response contained no __schema`);
        continue;
      }
      const schema = buildClientSchema(introspection);
      log.debug(`introspected ${conn.endpoint} using the ${variant.label} query`);
      return { schema, source: 'introspection' };
    } catch (err) {
      if (err instanceof WorkbenchError && err.code === 'CANCELLED') throw err;
      failures.push(`${variant.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  fail(
    'INTROSPECTION_FAILED',
    `Could not read the schema from ${conn.endpoint}.`,
    failures,
    'If introspection is disabled on this endpoint, paste its SDL into the connection and the workbench will use that instead.',
  );
}

interface CachedCatalog {
  catalog: Catalog;
  /** Fingerprint of every setting that changes the shape of the catalog. */
  key: string;
}

const cache = new Map<string, CachedCatalog>();

function catalogKey(conn: ConnectionConfig): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        conn.endpoint,
        conn.maxDepth,
        conn.pageSize,
        conn.scalarTypeMap,
        conn.sdl ?? '',
        conn.auth.kind,
        conn.headers.filter((h) => h.enabled !== false).map((h) => h.name),
      ]),
    )
    .digest('hex');
}

/** The catalog for a connection, introspecting only when something relevant has changed. */
export async function getCatalog(
  conn: ConnectionConfig,
  options: { refresh?: boolean; signal?: AbortSignal } = {},
): Promise<Catalog> {
  const key = catalogKey(conn);
  const cached = cache.get(conn.id);
  if (!options.refresh && cached && cached.key === key) return cached.catalog;

  const { schema, source } = await introspectSchema(conn, options.signal);
  const catalog = buildCatalog(schema, {
    connectionId: conn.id,
    endpoint: conn.endpoint,
    maxDepth: conn.maxDepth,
    pageSize: conn.pageSize,
    scalarTypeMap: conn.scalarTypeMap,
    source,
  });
  cache.set(conn.id, { catalog, key });
  log.info(
    `catalog for ${conn.name}: ${catalog.tables.filter((t) => !t.isChild).length} tables, ${catalog.tables.filter((t) => t.isChild).length} child tables, ${catalog.warnings.length} warnings`,
  );
  return catalog;
}

/** Drops the cached catalog, used when a connection is edited or deleted. */
export function invalidateCatalog(connectionId: string): void {
  cache.delete(connectionId);
}

/** The already-built catalog, if any, without touching the network. */
export function peekCatalog(connectionId: string): Catalog | undefined {
  return cache.get(connectionId)?.catalog;
}
