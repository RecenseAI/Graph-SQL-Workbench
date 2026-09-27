/**
 * Runs the real engine against public GraphQL APIs.
 *
 * The unit suite proves the pipeline against the bundled demo API; this proves it against schemas
 * nobody here designed. Usage:
 *
 *   npx tsx scripts/probe-apis.ts            # catalog summary for every API
 *   npx tsx scripts/probe-apis.ts countries  # one API, catalog plus its queries
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

process.env.GQLWB_DATA_DIR ??= join(process.cwd(), '.probe-data');

const { connectionSchema } = await import('@gqlwb/shared');
const { getCatalog } = await import('../packages/server/src/catalog/introspect.ts');
const { runStatement } = await import('../packages/server/src/plan/planner.ts');
const { connect } = await import('../packages/server/src/duck/pool.ts');

interface Probe {
  name: string;
  endpoint: string;
  profile?: 'auto' | 'hasura' | 'none';
  pageSize?: number;
  queries: string[];
}

export const PROBES: Probe[] = [
  {
    name: 'countries',
    endpoint: 'https://countries.trevorblades.com/',
    queries: [
      'SELECT continent_name, count(*) AS countries FROM countries GROUP BY 1 ORDER BY 2 DESC',
      'SELECT c.name, count(*) AS languages FROM countries c JOIN countries__languages l ON l._parent_rowid = c._rowid GROUP BY 1 ORDER BY 2 DESC LIMIT 5',
      "SELECT name, capital, currency FROM countries WHERE code = 'DE'",
    ],
  },
  {
    name: 'rickandmorty',
    endpoint: 'https://rickandmortyapi.com/graphql',
    queries: [
      'SELECT count(*) AS characters FROM characters',
      'SELECT species, status, count(*) AS n FROM characters GROUP BY ALL ORDER BY n DESC LIMIT 8',
    ],
  },
  {
    name: 'swapi',
    endpoint: 'https://swapi-graphql.netlify.app/graphql',
    queries: [
      'SELECT count(*) AS people FROM allPeople',
      'SELECT title, releaseDate, episodeID FROM allFilms ORDER BY episodeID',
    ],
  },
  {
    name: 'pokeapi',
    endpoint: 'https://beta.pokeapi.co/graphql/v1beta',
    profile: 'hasura',
    queries: [
      'SELECT count(*) AS n FROM pokemon_v2_pokemon(limit: 300)',
      'SELECT name, height, weight FROM pokemon_v2_pokemon(limit: 50) WHERE height > 15 ORDER BY weight DESC LIMIT 5',
    ],
  },
  {
    name: 'anilist',
    endpoint: 'https://graphql.anilist.co',
    queries: [],
  },
  {
    name: 'spacex',
    endpoint: 'https://spacex-production.up.railway.app/',
    queries: [
      'SELECT count(*) AS launches FROM launches',
      'SELECT rocket_rocket_name AS rocket, count(*) AS n FROM launches GROUP BY 1 ORDER BY 2 DESC',
    ],
  },
];

const only = process.argv[2];
const probes = only ? PROBES.filter((p) => p.name === only) : PROBES;
const duck = await connect();

for (const probe of probes) {
  const now = new Date().toISOString();
  const connection = connectionSchema.parse({
    id: `probe-${probe.name}`,
    name: probe.name,
    endpoint: probe.endpoint,
    pushdownProfile: probe.profile ?? 'auto',
    pageSize: probe.pageSize ?? 50,
    maxRows: 2000,
    cacheTtlSeconds: 0,
    timeoutMs: 20_000,
    createdAt: now,
    updatedAt: now,
  });

  console.log(`\n=================== ${probe.name}  ${probe.endpoint}`);
  let catalog;
  try {
    catalog = await getCatalog(connection);
  } catch (err) {
    console.log(`  CATALOG FAILED: ${err instanceof Error ? err.message : err}`);
    const detail = (err as { detail?: unknown }).detail;
    if (detail) console.log('  detail:', JSON.stringify(detail).slice(0, 400));
    continue;
  }

  const roots = catalog.tables.filter((t) => !t.isChild);
  const children = catalog.tables.filter((t) => t.isChild);
  console.log(`  ${roots.length} tables, ${children.length} child tables, source=${catalog.source}`);
  for (const table of roots.slice(0, 25)) {
    const required = table.args.filter((a) => a.required).map((a) => a.name);
    console.log(
      `   - ${table.name.padEnd(34)} ${table.pagination.style.padEnd(6)} cols=${String(table.columns.filter((c) => !c.synthetic).length).padEnd(3)}` +
        (required.length ? ` requires ${required.join(',')}` : '') +
        (table.pagination.nodesPath.length ? ` nodes=${table.pagination.nodesPath.join('.')}` : ''),
    );
  }
  if (roots.length > 25) console.log(`   ... ${roots.length - 25} more`);
  console.log(`  warnings (${catalog.warnings.length}):`);
  for (const warning of catalog.warnings.slice(0, 8)) console.log(`   ! ${warning.slice(0, 160)}`);

  if (only) {
    for (const sql of probe.queries) {
      console.log(`\n  SQL> ${sql}`);
      try {
        const result = await runStatement({
          connection,
          catalog,
          sql,
          index: 0,
          runId: randomUUID(),
          conn: duck,
          pageRows: 10,
          emit: () => undefined,
        });
        console.log(`  rows=${result.rowCount}  cols=${result.columns.map((c) => `${c.name}:${c.duckType}`).join(', ')}`);
        for (const row of result.rows.slice(0, 6)) console.log('   ', JSON.stringify(row).slice(0, 160));
        for (const stat of result.stats) {
          console.log(`   fetched ${stat.table}: rows=${stat.rows} pages=${stat.pages} requests=${stat.requests} truncated=${stat.truncated}`);
        }
        for (const entry of result.plan) {
          if (entry.pushed.length) console.log(`   pushed: ${entry.pushed.map((p) => `${p.column} ${p.op} -> ${p.arg}`).join('; ')}`);
        }
        for (const warning of result.warnings) console.log(`   ! ${warning.slice(0, 200)}`);
      } catch (err) {
        console.log(`  FAILED: ${err instanceof Error ? err.message : err}`);
        const hint = (err as { hint?: string }).hint;
        if (hint) console.log(`  hint: ${hint}`);
      }
    }
  }
}

duck.disconnectSync();
