/**
 * Helpers for building SQL text safely. Nothing user-controlled is ever concatenated without
 * going through one of these: identifiers get quoted and internal quotes doubled, string literals
 * likewise. DuckDB follows the SQL standard here, so a backslash inside a literal is just a
 * backslash -- which is why Windows paths can be embedded verbatim.
 */

export function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

export function quoteLiteral(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

/** A qualified reference like "schema"."table". */
export function qualify(...parts: string[]): string {
  return parts.map(quoteIdent).join('.');
}

/**
 * Validates a DuckDB type before it is interpolated into a `read_json(columns := ...)` clause.
 * Types come from the catalog rather than from user input, but this is the one place a bad
 * scalar override could reach SQL text, so it is checked.
 */
export function assertSafeDuckType(duckType: string): string {
  if (!/^[A-Za-z0-9_ ()[\],.]+$/.test(duckType)) {
    throw new Error(`Refusing to use "${duckType}" as a DuckDB type: it contains unexpected characters.`);
  }
  return duckType;
}
