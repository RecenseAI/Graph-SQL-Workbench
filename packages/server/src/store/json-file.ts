import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { ensureDirs } from '../env.ts';
import { logger } from '../log.ts';

const log = logger('store');

/** Reads JSON, returning the fallback when the file is missing or corrupt. */
export function readJsonFile<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch (err) {
    log.warn(`could not read ${basename(file)}, using defaults`, err instanceof Error ? err.message : err);
    return fallback;
  }
}

/** Writes via a temp file + rename so a crash mid-write cannot truncate the store. */
export function writeJsonFile(file: string, value: unknown): void {
  ensureDirs();
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmp, file);
}
