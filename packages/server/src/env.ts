import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

/** Where the workbench keeps connections, history, snapshots and the fetch cache. */
function resolveDataDir(): string {
  if (process.env.GQLWB_DATA_DIR) return process.env.GQLWB_DATA_DIR;
  if (process.platform === 'win32' && process.env.APPDATA) return join(process.env.APPDATA, 'graphql-workbench');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'graphql-workbench');
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'graphql-workbench');
}

export const DATA_DIR = resolveDataDir();
export const TMP_DIR = join(DATA_DIR, 'tmp');
export const CACHE_DB = join(DATA_DIR, 'cache.duckdb');
export const WORKSPACE_FILE = join(DATA_DIR, 'workspace.json');
export const SECRETS_FILE = join(DATA_DIR, 'secrets.json');
export const HISTORY_FILE = join(DATA_DIR, 'history.json');

export const PORT = Number(process.env.PORT ?? 5470);
export const HOST = process.env.HOST ?? '127.0.0.1';
export const IS_PROD = process.env.NODE_ENV === 'production';

/** Called at boot so importing this module never touches the filesystem. */
export function ensureDirs(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
}
