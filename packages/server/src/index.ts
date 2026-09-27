import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST, PORT, IS_PROD, ensureDirs, DATA_DIR } from './env.ts';
import { logger } from './log.ts';
import { describeError, WorkbenchError } from './errors.ts';
import { healthRoutes } from './routes/health.ts';
import { connectionRoutes } from './routes/connections.ts';
import { catalogRoutes } from './routes/catalog.ts';
import { runRoutes, abortAllRuns } from './routes/run.ts';
import { resultRoutes } from './routes/result.ts';
import { getInstance } from './duck/pool.ts';

const log = logger('server');
const here = dirname(fileURLToPath(import.meta.url));
const webDist = resolve(here, '..', '..', 'web', 'dist');

export async function buildApp() {
  ensureDirs();
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });

  // The UI is served from this origin in production; in dev Vite runs on another port.
  await app.register(cors, { origin: IS_PROD ? false : true });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof WorkbenchError) {
      const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'BAD_REQUEST' ? 400 : 422;
      return reply.code(status).send({ error: err.toJSON() });
    }
    // zod validation errors arrive as plain Errors carrying an `issues` array
    const issues = (err as { issues?: unknown }).issues;
    if (issues) return reply.code(400).send({ error: { code: 'BAD_REQUEST', message: 'Invalid request body', detail: issues } });
    const described = describeError(err);
    log.error(described.message, described.detail);
    return reply.code(500).send({ error: described });
  });

  await app.register(healthRoutes);
  await app.register(connectionRoutes);
  await app.register(catalogRoutes);
  await app.register(runRoutes);
  await app.register(resultRoutes);

  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/' });
    // SPA fallback: any non-API path renders the app shell.
    app.setNotFoundHandler(async (req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: `No route ${req.url}` } });
      return reply.sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler(async (req, reply) =>
      reply.code(404).send({ error: { code: 'NOT_FOUND', message: `No route ${req.url}` } }),
    );
  }

  return app;
}

async function main(): Promise<void> {
  const app = await buildApp();
  await getInstance();
  try {
    await app.listen({ host: HOST, port: PORT });
  } catch (err) {
    if ((err as { code?: string }).code === 'EADDRINUSE') {
      log.error(`Port ${PORT} is already in use -- another workbench is probably running.`);
      log.error(`Stop it, or start this one on another port: PORT=5480 npm run dev:api`);
      process.exit(1);
    }
    throw err;
  }
  const banner = existsSync(webDist) ? `app + api  http://${HOST}:${PORT}` : `api        http://${HOST}:${PORT}`;
  log.info(banner);
  log.info(`data dir   ${DATA_DIR}`);
  if (!existsSync(webDist)) log.info(`ui         run "npm run dev:ui" (vite serves it on 5173 and proxies /api here)`);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      log.info(`${signal} received, shutting down`);
      abortAllRuns();
      void app.close().then(() => process.exit(0));
    });
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly || process.env.GQLWB_FORCE_START === '1') {
  main().catch((err) => {
    const { message, hint } = describeError(err);
    log.error(`failed to start: ${message}`);
    if (hint) log.error(hint);
    process.exit(1);
  });
}

export { join };
