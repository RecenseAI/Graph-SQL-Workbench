import { randomUUID } from 'node:crypto';
import type { HistoryEntry } from '@gqlwb/shared';
import { HISTORY_FILE } from '../env.ts';
import { readJsonFile, writeJsonFile } from './json-file.ts';

/** Query history, newest first. Capped so the file stays small and loads instantly. */
const MAX_ENTRIES = 500;

export function listHistory(): HistoryEntry[] {
  return readJsonFile<HistoryEntry[]>(HISTORY_FILE, []);
}

export function addHistory(entry: Omit<HistoryEntry, 'id' | 'at'>): HistoryEntry {
  const full: HistoryEntry = { ...entry, id: randomUUID(), at: new Date().toISOString() };
  const entries = [full, ...listHistory()].slice(0, MAX_ENTRIES);
  writeJsonFile(HISTORY_FILE, entries);
  return full;
}

export function clearHistory(): void {
  writeJsonFile(HISTORY_FILE, []);
}
