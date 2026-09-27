import type { FastifyInstance } from 'fastify';
import { parse, OperationTypeNode, type OperationDefinitionNode } from 'graphql';
import type { GraphQLRunRequest } from '@gqlwb/shared';
import { getConnection } from '../store/workspace.ts';
import { getCatalog, invalidateCatalog } from '../catalog/introspect.ts';
import { callGraphQL } from '../fetch/client.ts';
import { cacheStats, invalidateConnectionCache } from '../fetch/cache.ts';
import { clearHistory, listHistory } from '../store/history.ts';
import { resetSession } from '../sql/statements.ts';
import { fail } from '../errors.ts';

export async function catalogRoutes(app: FastifyInstance): Promise<void> {
  /** Builds (or rebuilds) the relational catalog for a connection. */
  app.post<{ Params: { id: string }; Body: { refresh?: boolean } }>(
    '/api/connections/:id/introspect',
    async (request) => {
      const connection = getConnection(request.params.id);
      const catalog = await getCatalog(connection, { refresh: request.body?.refresh === true });
      return { catalog };
    },
  );

  /** A cheap round trip that proves the endpoint is reachable and answers GraphQL. */
  app.post<{ Params: { id: string } }>('/api/connections/:id/test', async (request) => {
    const connection = getConnection(request.params.id);
    const started = Date.now();
    try {
      const result = await callGraphQL(connection, { document: '{ __typename }' });
      const ms = Date.now() - started;
      if (result.errors.length > 0) {
        return { ok: false, ms, message: result.errors.map((e) => e.message).join('; ') };
      }
      return { ok: true, ms, message: `Reachable in ${ms}ms.` };
    } catch (err) {
      return {
        ok: false,
        ms: Date.now() - started,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  });

  /** Drops the cached schema, fetched pages and session settings for a connection. */
  app.post<{ Params: { id: string } }>('/api/connections/:id/refresh', async (request) => {
    const connection = getConnection(request.params.id);
    invalidateCatalog(connection.id);
    resetSession(connection.id);
    const removed = await invalidateConnectionCache(connection.id);
    return { ok: true, cachedFetchesRemoved: removed };
  });

  app.get('/api/cache', async () => cacheStats());

  /**
   * Runs a GraphQL document as written. Read-only: a mutation is refused rather than executed,
   * because a SQL workbench that can silently write to an API is a hazard, not a feature.
   */
  app.post<{ Body: GraphQLRunRequest }>('/api/graphql', async (request) => {
    const body = request.body;
    if (!body?.connectionId || typeof body.document !== 'string') {
      fail('BAD_REQUEST', 'connectionId and document are required.');
    }
    const connection = getConnection(body.connectionId);

    let operations: OperationDefinitionNode[];
    try {
      operations = parse(body.document).definitions.filter(
        (definition): definition is OperationDefinitionNode => definition.kind === 'OperationDefinition',
      );
    } catch (err) {
      fail('BAD_REQUEST', `That is not a valid GraphQL document: ${err instanceof Error ? err.message : String(err)}`);
    }

    const selected = body.operationName
      ? operations.filter((op) => op.name?.value === body.operationName)
      : operations;
    const writing = selected.find(
      (op) => op.operation === OperationTypeNode.MUTATION || op.operation === OperationTypeNode.SUBSCRIPTION,
    );
    if (writing) {
      fail(
        'MUTATION_REFUSED',
        `This workbench only runs queries, and that document contains a ${writing.operation}.`,
        undefined,
        'Use your usual GraphQL client for writes. The workbench is deliberately read-only.',
      );
    }

    const started = Date.now();
    const result = await callGraphQL(connection, {
      document: body.document,
      ...(body.variables ? { variables: body.variables } : {}),
      ...(body.operationName ? { operationName: body.operationName } : {}),
    });
    return {
      data: result.data,
      ...(result.errors.length ? { errors: result.errors } : {}),
      status: result.status,
      ms: Date.now() - started,
      bytes: result.bytes,
    };
  });

  app.get('/api/history', async () => ({ entries: listHistory() }));
  app.delete('/api/history', async () => {
    clearHistory();
    return { ok: true };
  });
}
