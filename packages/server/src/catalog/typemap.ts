import type { ScalarKind } from '@gqlwb/shared';

/**
 * GraphQL has five built-in scalars and an open set of custom ones. Built-ins map exactly;
 * custom scalars are mapped by name, because that is all a schema tells us about them. Every
 * guess is overridable per connection via `scalarTypeMap`, and unmapped names are reported as
 * warnings rather than silently becoming text.
 */

const BUILTIN: Record<string, { duckType: string; kind: ScalarKind }> = {
  Int: { duckType: 'BIGINT', kind: 'int' },
  Float: { duckType: 'DOUBLE', kind: 'float' },
  String: { duckType: 'VARCHAR', kind: 'string' },
  Boolean: { duckType: 'BOOLEAN', kind: 'boolean' },
  ID: { duckType: 'VARCHAR', kind: 'id' },
};

/**
 * Name-based heuristics for custom scalars, matched case-insensitively against the
 * normalised scalar name (non-alphanumerics stripped).
 */
const CUSTOM_PATTERNS: { match: RegExp; duckType: string }[] = [
  { match: /^(datetime|timestamp|timestamptz|isodatetime|instant|zoneddatetime|offsetdatetime)$/, duckType: 'TIMESTAMP' },
  { match: /^(date|localdate|isodate)$/, duckType: 'DATE' },
  { match: /^(time|localtime|isotime)$/, duckType: 'TIME' },
  { match: /^(duration|interval)$/, duckType: 'INTERVAL' },
  { match: /^(bigint|long|int64|unsignedint64|biginteger)$/, duckType: 'BIGINT' },
  { match: /^(decimal|money|currencyamount|numeric|bigdecimal|amount|price)$/, duckType: 'DECIMAL(38,9)' },
  { match: /^(json|jsonobject|jsonb|jsonstring|object|any)$/, duckType: 'JSON' },
  { match: /^(uuid|guid)$/, duckType: 'UUID' },
  { match: /^(byte|bytes|binary|base64|blob)$/, duckType: 'BLOB' },
  { match: /^(url|uri|email|emailaddress|phone|phonenumber|hexcolor|slug|html|markdown|cursor|hash|ipaddress|port|semver|timezone|locale|countrycode|currencycode|latitude|longitude|postalcode)$/, duckType: 'VARCHAR' },
];

const normalise = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');

export interface ScalarMapping {
  duckType: string;
  kind: ScalarKind;
  /** True when neither a built-in nor a heuristic matched, so the mapping is a fallback. */
  guessed: boolean;
}

export function mapScalar(typeName: string, overrides: Record<string, string> = {}): ScalarMapping {
  const override = overrides[typeName];
  if (override) {
    return { duckType: override, kind: kindForDuckType(override), guessed: false };
  }
  const builtin = BUILTIN[typeName];
  if (builtin) return { ...builtin, guessed: false };

  const key = normalise(typeName);
  for (const pattern of CUSTOM_PATTERNS) {
    if (pattern.match.test(key)) {
      return { duckType: pattern.duckType, kind: 'custom', guessed: false };
    }
  }
  // Unknown custom scalar: VARCHAR preserves whatever the endpoint sends without lying about it.
  return { duckType: 'VARCHAR', kind: 'custom', guessed: true };
}

/** Enums are stored as text so unknown values from a newer server cannot break a query. */
export const ENUM_MAPPING: ScalarMapping = { duckType: 'VARCHAR', kind: 'enum', guessed: false };

function kindForDuckType(duckType: string): ScalarKind {
  const upper = duckType.toUpperCase();
  if (/^(TINYINT|SMALLINT|INTEGER|INT|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT)/.test(upper)) return 'int';
  if (/^(FLOAT|DOUBLE|REAL|DECIMAL|NUMERIC)/.test(upper)) return 'float';
  if (upper.startsWith('BOOLEAN')) return 'boolean';
  if (/^(VARCHAR|TEXT|STRING|CHAR)/.test(upper)) return 'string';
  return 'custom';
}

/** Wraps a DuckDB type in list markers, once per list level in the GraphQL type. */
export function asList(duckType: string, depth = 1): string {
  return duckType + '[]'.repeat(depth);
}

/** Types the shredder can hand to `read_json` verbatim. */
export function isValidDuckType(duckType: string): boolean {
  return /^[A-Za-z0-9_ ()[\],.]+$/.test(duckType);
}
