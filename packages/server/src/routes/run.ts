import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { RunEvent, RunRequest } from '@gqlwb/shared';
import { getConnection } from '../store/workspace.ts';
import { getCatalog } from '../catalog/introspect.ts';
import { splitStatements } from '../sql/lexer.ts';
import { runStatement } from '../plan/planner.ts';
import { connect } from '../duck/pool.ts';
import { pruneResults } from '../duck/results.ts';
import { pruneCache } from '../fetch/cache.ts';
import { addHistory } from '../store/history.ts';
import { describeError } from '../errors.ts';
import { logger } from '../log.ts';

const log = logger('run');

/** In-flight runs, so the Stop button has something to cancel. */
const active = new Map<string, AbortController>();

/**
 * Runs a script over Server-Sent Events.
 *
 * Streaming matters because the interesting part of a SQL-over-GraphQL query happens before any
 * rows exist: the client sees the fetch plan first, then page-by-page progress, then the result.
 * A single JSON response would leave the user staring at a spinner with no idea whether the
 * endpoint is slow, paginating, or about to return a million rows.
 */
export async function runRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: RunRequest }>('/api/run', async (request, reply) => {
    const body = request.body;
    if (!body?.connectionId || typeof body.sql !== 'string') {
      return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'connectionId and sql are required.' } });
    }

    const connection = getConnection(body.connectionId);
    const runId = randomUUID();
    const controller = new AbortController();
    active.set(runId, controller);

    // The client can vanish mid-run, and there is no point fetching pages nobody will read.
    // This must watch the RESPONSE socket: on a POST, the request stream closes as soon as the
    // body has been received, which would otherwise cancel every run the instant it started.
    let finished = false;
    reply.raw.on('close', () => {
      if (finished) return;
      controller.abort();
      active.delete(runId);
    });

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const send = (event: RunEvent): void => {
      if (reply.raw.writableEnded) return;
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const startedAt = Date.now();
    let duck: Awaited<ReturnType<typeof connect>> | null = null;

    try {
      const statements = splitStatements(body.sql).filter((s) => s.sql.trim().length > 0);
      const selected =
        body.statementIndex === undefined
          ? statements
          : statements.filter((_, index) => index === body.statementIndex);

      if (selected.length === 0) {
        send({ type: 'started', runId, statements: 0 });
        send({ type: 'done', runId, ms: 0 });
        reply.raw.end();
        return reply;
      }

      send({ type: 'started', runId, statements: selected.length });

      const catalog = await getCatalog(connection, { signal: controller.signal });
      duck = await connect();

      for (const [index, statement] of selected.entries()) {
        send({ type: 'statement', index, sql: statement.sql });
        const statementStarted = Date.now();
        try {
          const result = await runStatement({
            connection,
            catalog,
            sql: statement.sql,
            index,
            runId,
            conn: duck,
            pageRows: Math.min(Math.max(body.pageRows ?? 200, 1), 2000),
            ...(body.pushdown !== undefined ? { pushdownOverride: body.pushdown } : {}),
            ...(body.cache !== undefined ? { cacheOverride: body.cache } : {}),
            ...(body.maxRows !== undefined ? { maxRowsOverride: body.maxRows } : {}),
            ...(body.explain ? { explain: true } : {}),
            signal: controller.signal,
            emit: send,
          });
          for (const warning of result.warnings) send({ type: 'warning', index, message: warning });
          send({ type: 'result', index, result });
          addHistory({
            connectionId: connection.id,
            connectionName: connection.name,
            sql: statement.sql,
            ms: Date.now() - statementStarted,
            rows: result.rowCount,
            ok: true,
          });
        } catch (err) {
          const described = describeError(err);
          send({ type: 'error', index, message: described.message, detail: { ...described } });
          addHistory({
            connectionId: connection.id,
            connectionName: connection.name,
            sql: statement.sql,
            ms: Date.now() - statementStarted,
            rows: 0,
            ok: false,
            error: described.message,
          });
          // A failed statement stops the script, as it would in any SQL client.
          break;
        }
      }

      send({ type: 'done', runId, ms: Date.now() - startedAt });
    } catch (err) {
      const described = describeError(err);
      log.error(`run ${runId} failed: ${described.message}`);
      send({ type: 'error', index: null, message: described.message, detail: { ...described } });
      send({ type: 'done', runId, ms: Date.now() - startedAt });
    } finally {
      finished = true;
      active.delete(runId);
      if (duck) {
        try {
          duck.disconnectSync();
        } catch {
          /* already gone */
        }
      }
      if (!reply.raw.writableEnded) reply.raw.end();
      // Housekeeping after the response is closed, so it never delays a result.
      void pruneResults().catch(() => undefined);
      void pruneCache().catch(() => undefined);
    }
    return reply;
  });

  app.post<{ Params: { runId: string } }>('/api/run/:runId/cancel', async (request) => {
    const controller = active.get(request.params.runId);
    if (!controller) return { ok: false, message: 'That run has already finished.' };
    controller.abort();
    active.delete(request.params.runId);
    return { ok: true };
  });

  app.get('/api/run/active', async () => ({ runIds: [...active.keys()] }));
}

/** Used by the shutdown path so a restart does not leave work running. */
export function abortAllRuns(): void {
  for (const controller of active.values()) controller.abort();
  active.clear();
}

export type { FastifyReply };
