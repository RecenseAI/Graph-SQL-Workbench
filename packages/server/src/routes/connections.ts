import type { FastifyInstance } from 'fastify';
import { connectionInputSchema } from '@gqlwb/shared';
import {
  listConnections,
  createConnection,
  updateConnection,
  deleteConnection,
  getConnection,
  getActiveConnectionId,
  setActiveConnectionId,
} from '../store/workspace.ts';

export async function connectionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/connections', async () => ({
    connections: listConnections(),
    activeConnectionId: getActiveConnectionId(),
  }));

  app.post('/api/connections', async (req, reply) => {
    const conn = createConnection(connectionInputSchema.parse(req.body));
    reply.code(201);
    return { connection: { ...conn, auth: { ...conn.auth, token: conn.auth.token ? '__stored__' : undefined, pass: undefined } } };
  });

  app.patch<{ Params: { id: string } }>('/api/connections/:id', async (req) => {
    const conn = updateConnection(req.params.id, connectionInputSchema.partial().parse(req.body));
    return { connection: { ...conn, auth: { ...conn.auth, token: conn.auth.token ? '__stored__' : undefined, pass: undefined } } };
  });

  app.delete<{ Params: { id: string } }>('/api/connections/:id', async (req) => {
    deleteConnection(req.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/connections/:id/activate', async (req) => {
    getConnection(req.params.id);
    setActiveConnectionId(req.params.id);
    return { ok: true };
  });
}
