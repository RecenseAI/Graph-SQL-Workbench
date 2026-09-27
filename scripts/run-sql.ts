/**
 * Runs one SQL statement against any GraphQL endpoint through the real engine, and prints what
 * happened at every stage: the catalog entry, the generated GraphQL, what was pushed down, what
 * was fetched, and the result. The fastest way to reproduce a bug report.
 *
 *   npx tsx scripts/run-sql.ts <endpoint> "<sql>" [options]
 *
 * Options:
 *   --profile auto|hasura|strapi|flat|none   pushdown profile (default auto)
 *   --header "Name: value"                   extra request header, repeatable
 *   --bearer <token>                         Authorization: Bearer <token>
 *   --depth <n>  --page-size <n>  --max-rows <n>
 *   --no-pushdown                            fetch everything, filter locally
 *   --sdl <file>                             use SDL instead of introspection
 *
 * Example:
 *   npx tsx scripts/run-sql.ts https://countries.trevorblades.com/ "SELECT name FROM countries WHERE code = 'DE'"
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

process.env.GQLWB_DATA_DIR ??= join(process.cwd(), '.probe-data');

const { connectionSchema } = await import('@gqlwb/shared');
const { getCatalog } = await import('../packages/server/src/catalog/introspect.ts');
const { runStatement } = await import('../packages/server/src/plan/planner.ts');
const { connect } = await import('../packages/server/src/duck/pool.ts');
const { prepass } = await import('../packages/server/src/sql/prepass.ts');

const argv = process.argv.slice(2);
const positional: string[] = [];
const headers: { name: string; value: string; enabled: boolean }[] = [];
const flags: Record<string, string | boolean> = {};
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i] as string;
  if (arg === '--header') {
    const raw = argv[++i] ?? '';
    const at = raw.indexOf(':');
    headers.push({ name: raw.slice(0, at).trim(), value: raw.slice(at + 1).trim(), enabled: true });
  } else if (arg === '--no-pushdown') {
    flags.noPushdown = true;
  } else if (arg.startsWith('--')) {
    flags[arg.slice(2)] = argv[++i] ?? '';
  } else {
    positional.push(arg);
  }
}

const [endpoint, sql] = positional;
if (!endpoint || !sql) {
  console.error('usage: npx tsx scripts/run-sql.ts <endpoint> "<sql>" [--profile hasura] [--header "K: v"] [--bearer T]');
  process.exit(2);
}

const now = new Date().toISOString();
const connection = connectionSchema.parse({
  id: `run-sql-${Buffer.from(endpoint).toString('hex').slice(0, 24)}`,
  name: 'run-sql',
  endpoint,
  headers,
  auth: flags.bearer ? { kind: 'bearer', token: String(flags.bearer) } : { kind: 'none' },
  pushdownProfile: (flags.profile as string) || 'auto',
  maxDepth: flags.depth ? Number(flags.depth) : 3,
  pageSize: flags['page-size'] ? Number(flags['page-size']) : 100,
  maxRows: flags['max-rows'] ? Number(flags['max-rows']) : 10_000,
  cacheTtlSeconds: 0,
  ...(flags.sdl ? { sdl: readFileSync(String(flags.sdl), 'utf8') } : {}),
  createdAt: now,
  updatedAt: now,
});

const section = (title: string) => console.log(`\n--- ${title} ${'-'.repeat(Math.max(0, 60 - title.length))}`);

const catalog = await getCatalog(connection);
section('catalog');
console.log(`${catalog.tables.filter((t) => !t.isChild).length} tables, ${catalog.tables.filter((t) => t.isChild).length} child tables, source=${catalog.source}`);

const referenced = prepass(sql, catalog.tables.map((t) => t.name)).bindings;
for (const binding of referenced) {
  const table = catalog.tables.find((t) => t.name === binding.table);
  if (!table) continue;
  console.log(`\n${table.name}  (field ${table.rootField} -> ${table.rowTypeName}, pagination ${table.pagination.style})`);
  console.log(`  pagination: ${JSON.stringify(table.pagination)}`);
  console.log(`  args: ${table.args.map((a) => `${a.name}${a.required ? '!' : ''}:${a.graphqlType}`).join(', ') || '(none)'}`);
  console.log(`  columns: ${table.columns.filter((c) => !c.synthetic).map((c) => `${c.name}:${c.duckType}`).join(', ')}`);
  if (table.childTables.length) console.log(`  child tables: ${table.childTables.join(', ')}`);
}

const duck = await connect();
try {
  const result = await runStatement({
    connection,
    catalog,
    sql,
    index: 0,
    runId: randomUUID(),
    conn: duck,
    pageRows: 20,
    ...(flags.noPushdown ? { pushdownOverride: false } : {}),
    emit: () => undefined,
  });

  for (const entry of result.plan) {
    section(`graphql for ${entry.alias}`);
    console.log(entry.document);
    if (Object.keys(entry.variables).length) console.log('variables:', JSON.stringify(entry.variables));
    for (const pushed of entry.pushed) console.log(`pushed: ${pushed.column} ${pushed.op} ${JSON.stringify(pushed.value)} -> ${pushed.arg} (${pushed.via})`);
    for (const skipped of entry.skipped) console.log(`local:  ${skipped.column} ${skipped.op} -- ${skipped.reason}`);
  }

  section('fetch');
  for (const stat of result.stats) {
    console.log(`${stat.table}: rows=${stat.rows} pages=${stat.pages} requests=${stat.requests} retries=${stat.retries} cache=${stat.cache} truncated=${stat.truncated} ${stat.ms}ms`);
  }
  console.log(`timings: ${JSON.stringify(result.timings)}`);

  section(`result (${result.rowCount} rows)`);
  console.log(result.columns.map((c) => `${c.name}:${c.duckType}`).join(' | '));
  for (const row of result.rows) console.log(JSON.stringify(row));
  if (result.message) console.log(result.message);

  if (result.warnings.length) {
    section('warnings');
    for (const warning of result.warnings) console.log(`! ${warning}`);
  }
} catch (err) {
  section('FAILED');
  console.log(err instanceof Error ? err.message : err);
  const extra = err as { code?: string; hint?: string; detail?: unknown };
  if (extra.code) console.log('code:', extra.code);
  if (extra.hint) console.log('hint:', extra.hint);
  if (extra.detail) console.log('detail:', JSON.stringify(extra.detail).slice(0, 1500));
  process.exitCode = 1;
} finally {
  duck.disconnectSync();
}
