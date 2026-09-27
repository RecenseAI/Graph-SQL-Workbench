import { randomUUID } from 'node:crypto';
import {
  connectionSchema,
  connectionInputSchema,
  type ConnectionConfig,
  type ConnectionInput,
} from '@gqlwb/shared';
import { WORKSPACE_FILE, SECRETS_FILE } from '../env.ts';
import { readJsonFile, writeJsonFile } from './json-file.ts';
import { fail } from '../errors.ts';

interface WorkspaceFile {
  version: 1;
  connections: ConnectionConfig[];
  activeConnectionId?: string;
}

/** Secret values live in their own file so workspace.json can be shared or committed. */
type SecretsFile = Record<string, { token?: string; pass?: string }>;

const EMPTY: WorkspaceFile = { version: 1, connections: [] };

function load(): WorkspaceFile {
  const ws = readJsonFile<WorkspaceFile>(WORKSPACE_FILE, EMPTY);
  return { version: 1, connections: ws.connections ?? [], activeConnectionId: ws.activeConnectionId };
}

function loadSecrets(): SecretsFile {
  return readJsonFile<SecretsFile>(SECRETS_FILE, {});
}

/** Connections as stored: secrets stripped, replaced with a redaction marker for the UI. */
export function listConnections(): ConnectionConfig[] {
  const secrets = loadSecrets();
  return load().connections.map((conn) => ({
    ...conn,
    auth: {
      ...conn.auth,
      token: secrets[conn.id]?.token ? '__stored__' : conn.auth.token,
      pass: secrets[conn.id]?.pass ? '__stored__' : conn.auth.pass,
    },
  }));
}

/** Connection with real secrets substituted in. Server-side only, never serialised to the UI. */
export function getConnection(id: string): ConnectionConfig {
  const conn = load().connections.find((c) => c.id === id);
  if (!conn) fail('NOT_FOUND', `No connection with id ${id}`);
  const secret = loadSecrets()[id];
  return {
    ...conn,
    auth: { ...conn.auth, token: secret?.token ?? conn.auth.token, pass: secret?.pass ?? conn.auth.pass },
  };
}

export function getActiveConnectionId(): string | undefined {
  return load().activeConnectionId;
}

export function setActiveConnectionId(id: string | undefined): void {
  const ws = load();
  writeJsonFile(WORKSPACE_FILE, { ...ws, activeConnectionId: id });
}

function splitSecrets(conn: ConnectionConfig): { stored: ConnectionConfig; secret: { token?: string; pass?: string } } {
  const secret: { token?: string; pass?: string } = {};
  if (conn.auth.token && conn.auth.token !== '__stored__') secret.token = conn.auth.token;
  if (conn.auth.pass && conn.auth.pass !== '__stored__') secret.pass = conn.auth.pass;
  const stored: ConnectionConfig = { ...conn, auth: { ...conn.auth } };
  delete stored.auth.token;
  delete stored.auth.pass;
  return { stored, secret };
}

export function createConnection(input: ConnectionInput): ConnectionConfig {
  const parsed = connectionInputSchema.parse(input);
  const now = new Date().toISOString();
  const conn = connectionSchema.parse({ ...parsed, id: randomUUID(), createdAt: now, updatedAt: now });
  const ws = load();
  const { stored, secret } = splitSecrets(conn);
  writeJsonFile(WORKSPACE_FILE, {
    ...ws,
    connections: [...ws.connections, stored],
    activeConnectionId: ws.activeConnectionId ?? conn.id,
  });
  if (Object.keys(secret).length) writeJsonFile(SECRETS_FILE, { ...loadSecrets(), [conn.id]: secret });
  return conn;
}

export function updateConnection(id: string, input: Partial<ConnectionInput>): ConnectionConfig {
  const ws = load();
  const existing = ws.connections.find((c) => c.id === id);
  if (!existing) fail('NOT_FOUND', `No connection with id ${id}`);
  const merged = connectionSchema.parse({ ...existing, ...input, id, updatedAt: new Date().toISOString() });
  const { stored, secret } = splitSecrets(merged);
  writeJsonFile(WORKSPACE_FILE, {
    ...ws,
    connections: ws.connections.map((c) => (c.id === id ? stored : c)),
  });
  const secrets = loadSecrets();
  // An omitted or redacted secret keeps whatever is already stored.
  const next = { ...secrets[id], ...secret };
  if (Object.keys(next).length) writeJsonFile(SECRETS_FILE, { ...secrets, [id]: next });
  return getConnection(id);
}

export function deleteConnection(id: string): void {
  const ws = load();
  writeJsonFile(WORKSPACE_FILE, {
    ...ws,
    connections: ws.connections.filter((c) => c.id !== id),
    activeConnectionId: ws.activeConnectionId === id ? undefined : ws.activeConnectionId,
  });
  const secrets = loadSecrets();
  if (secrets[id]) {
    delete secrets[id];
    writeJsonFile(SECRETS_FILE, secrets);
  }
}

/** Resolves `${env:VAR}` placeholders in header values at request time. */
export function interpolateEnv(value: string): string {
  return value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => process.env[name] ?? '');
}
