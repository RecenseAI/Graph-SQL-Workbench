/** Errors carrying a stable code so the UI can render them without string matching. */
export type ErrorCode =
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'CONNECTION_FAILED'
  | 'INTROSPECTION_FAILED'
  | 'SCHEMA_INVALID'
  | 'SQL_PARSE_FAILED'
  | 'UNKNOWN_TABLE'
  | 'UNKNOWN_COLUMN'
  | 'GRAPHQL_ERROR'
  | 'FETCH_FAILED'
  | 'SHRED_FAILED'
  | 'EXECUTE_FAILED'
  | 'CANCELLED'
  | 'MUTATION_REFUSED'
  | 'INTERNAL';

export class WorkbenchError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly detail?: unknown,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'WorkbenchError';
  }
  toJSON() {
    return { code: this.code, message: this.message, detail: this.detail, hint: this.hint };
  }
}

export function fail(code: ErrorCode, message: string, detail?: unknown, hint?: string): never {
  throw new WorkbenchError(code, message, detail, hint);
}

export function describeError(err: unknown): { code: ErrorCode; message: string; detail?: unknown; hint?: string } {
  if (err instanceof WorkbenchError) return err.toJSON();
  if (err instanceof Error) return { code: 'INTERNAL', message: err.message, detail: err.stack };
  return { code: 'INTERNAL', message: String(err) };
}
