import type { DuckDBConnection } from '@duckdb/node-api';
import { logger } from '../log.ts';

const log = logger('macros');

/**
 * MySQL habits, made to work.
 *
 * The engine is DuckDB, whose dialect is PostgreSQL-flavoured, but the audience for a tool shaped
 * like Workbench types MySQL. These macros cover the functions people reach for without thinking.
 * They are additive: nothing here shadows a DuckDB builtin with different behaviour, and anyone
 * who prefers the native spelling keeps using it.
 */
const MACROS: { name: string; sql: string }[] = [
  { name: 'ifnull', sql: "CREATE OR REPLACE MACRO ifnull(a, b) AS coalesce(a, b)" },
  { name: 'isnull', sql: "CREATE OR REPLACE MACRO isnull(a) AS (a IS NULL)" },
  { name: 'wb_if', sql: "CREATE OR REPLACE MACRO wb_if(cond, a, b) AS CASE WHEN cond THEN a ELSE b END" },
  { name: 'unix_timestamp', sql: "CREATE OR REPLACE MACRO unix_timestamp(ts) AS epoch(CAST(ts AS TIMESTAMP))" },
  { name: 'from_unixtime', sql: "CREATE OR REPLACE MACRO from_unixtime(seconds) AS to_timestamp(seconds)" },
  { name: 'curdate', sql: "CREATE OR REPLACE MACRO curdate() AS current_date" },
  { name: 'curtime', sql: "CREATE OR REPLACE MACRO curtime() AS current_time" },
  { name: 'datediff_days', sql: "CREATE OR REPLACE MACRO datediff_days(a, b) AS date_diff('day', CAST(b AS DATE), CAST(a AS DATE))" },
  { name: 'char_length', sql: "CREATE OR REPLACE MACRO char_length(s) AS length(s)" },
  { name: 'locate', sql: "CREATE OR REPLACE MACRO locate(needle, haystack) AS position(needle IN haystack)" },
  { name: 'rand', sql: "CREATE OR REPLACE MACRO rand() AS random()" },
  { name: 'truncate_number', sql: "CREATE OR REPLACE MACRO truncate_number(x, d) AS trunc(x * power(10, d)) / power(10, d)" },
  // DATE_FORMAT's MySQL specifiers map onto strftime's, which are the same letters in most cases.
  { name: 'date_format', sql: "CREATE OR REPLACE MACRO date_format(ts, fmt) AS strftime(CAST(ts AS TIMESTAMP), fmt)" },
  { name: 'str_to_date', sql: "CREATE OR REPLACE MACRO str_to_date(s, fmt) AS strptime(s, fmt)" },
  // GROUP_CONCAT with the MySQL argument order, since DuckDB spells it string_agg.
  { name: 'group_concat_sep', sql: "CREATE OR REPLACE MACRO group_concat_sep(x, sep) AS string_agg(x, sep)" },
  // Convenience for the workbench itself: read a value out of the _raw escape-hatch column.
  { name: 'raw_get', sql: "CREATE OR REPLACE MACRO raw_get(raw, path) AS json_extract_string(raw, path)" },
];

let installed = false;

/** Installs the compatibility macros. Failures are logged, never fatal. */
export async function installMacros(conn: DuckDBConnection, force = false): Promise<string[]> {
  if (installed && !force) return [];
  const failures: string[] = [];
  for (const macro of MACROS) {
    try {
      await conn.run(macro.sql);
    } catch (err) {
      // A DuckDB version that already defines the name is fine; anything else is worth knowing.
      failures.push(`${macro.name}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    }
  }
  installed = true;
  if (failures.length) log.debug(`some compatibility macros were skipped: ${failures.join('; ')}`);
  return failures;
}

export const MACRO_NAMES = MACROS.map((m) => m.name);
