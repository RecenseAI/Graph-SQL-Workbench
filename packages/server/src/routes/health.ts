import type { FastifyInstance } from 'fastify';
import { getDuckVersion } from '../duck/pool.ts';
import { DATA_DIR } from '../env.ts';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => ({
    ok: true,
    name: 'graphql-workbench',
    version: '1.0.0',
    engine: await getDuckVersion(),
    node: process.version,
    platform: process.platform,
    dataDir: DATA_DIR,
    uptimeSeconds: Math.round(process.uptime()),
  }));
}
