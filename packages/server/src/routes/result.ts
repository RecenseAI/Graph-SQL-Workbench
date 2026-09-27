import { createReadStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { TMP_DIR, ensureDirs } from '../env.ts';
import { exportResult, readResultPage, type ExportFormat } from '../duck/results.ts';
import { fail } from '../errors.ts';

const FORMATS: Record<ExportFormat, { extension: string; contentType: string }> = {
  csv: { extension: 'csv', contentType: 'text/csv; charset=utf-8' },
  json: { extension: 'json', contentType: 'application/json; charset=utf-8' },
  parquet: { extension: 'parquet', contentType: 'application/vnd.apache.parquet' },
  markdown: { extension: 'md', contentType: 'text/markdown; charset=utf-8' },
  sql: { extension: 'sql', contentType: 'application/sql; charset=utf-8' },
};

export async function resultRoutes(app: FastifyInstance): Promise<void> {
  /** A page of a stored result, optionally sorted and filtered. */
  app.get<{
    Params: { resultId: string };
    Querystring: { offset?: string; limit?: string; orderBy?: string; desc?: string; filter?: string };
  }>('/api/result/:resultId/rows', async (request) => {
    const query = request.query;
    return readResultPage(request.params.resultId, {
      offset: Number(query.offset ?? 0) || 0,
      limit: Math.min(Math.max(Number(query.limit ?? 200) || 200, 1), 5000),
      ...(query.orderBy ? { orderBy: query.orderBy } : {}),
      descending: query.desc === 'true' || query.desc === '1',
      ...(query.filter ? { filter: query.filter } : {}),
    });
  });

  /** Same as above, as a POST, so a long filter string is not squeezed into a URL. */
  app.post<{
    Params: { resultId: string };
    Body: { offset?: number; limit?: number; orderBy?: string | null; descending?: boolean; filter?: string };
  }>('/api/result/:resultId/view', async (request) => {
    const body = request.body ?? {};
    return readResultPage(request.params.resultId, {
      offset: body.offset ?? 0,
      limit: Math.min(Math.max(body.limit ?? 200, 1), 5000),
      ...(body.orderBy ? { orderBy: body.orderBy } : {}),
      descending: body.descending === true,
      ...(body.filter ? { filter: body.filter } : {}),
    });
  });

  /**
   * Exports a stored result. DuckDB writes the file, then it is streamed and deleted, so a large
   * export never has to be held in memory on either side.
   */
  app.get<{ Params: { resultId: string }; Querystring: { format?: string; name?: string } }>(
    '/api/result/:resultId/export',
    async (request, reply) => {
      const format = (request.query.format ?? 'csv') as ExportFormat;
      const spec = FORMATS[format];
      if (!spec) {
        fail('BAD_REQUEST', `Unsupported export format "${request.query.format}".`, undefined, `Try one of: ${Object.keys(FORMATS).join(', ')}.`);
      }
      const tableName = (request.query.name ?? 'result').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 60) || 'result';

      ensureDirs();
      const destination = join(TMP_DIR, `export_${randomBytes(6).toString('hex')}.${spec.extension}`);
      await exportResult(request.params.resultId, format, destination, tableName);

      reply.header('content-type', spec.contentType);
      reply.header('content-disposition', `attachment; filename="${tableName}.${spec.extension}"`);
      const stream = createReadStream(destination);
      stream.on('close', () => {
        void rm(destination, { force: true });
      });
      return reply.send(stream);
    },
  );
}
