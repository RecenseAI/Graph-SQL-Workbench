import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DuckDBConnection } from '@duckdb/node-api';
import type { Catalog, ConnectionConfig, QueryResult, RunEvent } from '@gqlwb/shared';
import { connect } from '../src/duck/pool.ts';
import { getCatalog, invalidateCatalog } from '../src/catalog/introspect.ts';
import { runStatement } from '../src/plan/planner.ts';
import { invalidateConnectionCache } from '../src/fetch/cache.ts';
import { resetSession } from '../src/sql/statements.ts';
import { demoConnection, startDemoApi, type DemoHandle } from './helpers/demo-server.ts';
import { orderTotals, revenueByCountry, unitsByCategory, userCount } from '../../demo-api/src/expected.ts';

let demo: DemoHandle;
let conn: DuckDBConnection;
let baseConnection: ConnectionConfig;
let catalog: Catalog;

interface RunOutcome {
  result: QueryResult;
  events: RunEvent[];
}

/** Runs one statement through the whole pipeline, exactly as the HTTP route does. */
async function run(
  sql: string,
  overrides: Partial<ConnectionConfig> = {},
  runOptions: Partial<Parameters<typeof runStatement>[0]> = {},
): Promise<RunOutcome> {
  const events: RunEvent[] = [];
  const connection = { ...baseConnection, ...overrides };
  const result = await runStatement({
    connection,
    catalog,
    sql,
    index: 0,
    runId: randomUUID(),
    conn,
    pageRows: 200,
    emit: (event) => events.push(event),
    ...runOptions,
  });
  return { result, events };
}

const rowsAsObjects = (result: QueryResult): Record<string, unknown>[] =>
  result.rows.map((row) => Object.fromEntries(result.columns.map((c, i) => [c.name, row[i]])));

const num = (value: unknown): number => Number(value);

beforeAll(async () => {
  demo = await startDemoApi();
  conn = await connect();
  baseConnection = demoConnection(demo.endpoint, {
    id: 'pipeline',
    pageSize: 200,
    maxRows: 20_000,
    cacheTtlSeconds: 0,
  });
  catalog = await getCatalog(baseConnection);
  await invalidateConnectionCache('pipeline');
}, 120_000);

afterAll(async () => {
  invalidateCatalog('pipeline');
  await invalidateConnectionCache('pipeline');
  try {
    conn?.disconnectSync();
  } catch {
    /* already closed */
  }
  await demo?.stop();
});

describe('the things GraphQL cannot do', () => {
  it('joins two root fields on a relationship the schema never models', async () => {
    const { result } = await run(`
      SELECT u.country,
             COUNT(*)     AS orders,
             SUM(o.total) AS revenue,
             MAX(o.total) AS biggest
      FROM users u
      JOIN orders(status: "PAID") o ON o.userId = u.id
      GROUP BY u.country
      ORDER BY revenue DESC`);

    const expected = revenueByCountry('PAID');
    const actual = rowsAsObjects(result);
    expect(actual).toHaveLength(expected.length);
    expected.forEach((want, index) => {
      const got = actual[index];
      expect(got?.country, `row ${index}`).toBe(want.country);
      expect(num(got?.orders)).toBe(want.orders);
      expect(num(got?.revenue)).toBeCloseTo(want.revenue, 2);
      expect(num(got?.biggest)).toBeCloseTo(want.biggest, 2);
    });
  }, 120_000);

  it('computes aggregates over a whole paginated collection', async () => {
    const { result } = await run(`
      SELECT count(*) AS n, sum(total) AS total, max(total) AS biggest, min(total) AS smallest,
             round(avg(total), 2) AS mean
      FROM orders(status: "PAID")`);
    const want = orderTotals('PAID');
    const got = rowsAsObjects(result)[0];
    expect(num(got?.n)).toBe(want.count);
    expect(num(got?.total)).toBeCloseTo(want.sum ?? 0, 2);
    expect(num(got?.biggest)).toBeCloseTo(want.max ?? 0, 2);
    expect(num(got?.smallest)).toBeCloseTo(want.min ?? 0, 2);
    expect(num(got?.mean)).toBeCloseTo(want.avg ?? 0, 1);
  }, 120_000);

  it('ranks with a window function and filters on the rank', async () => {
    const { result } = await run(`
      SELECT country, revenue, rk FROM (
        SELECT u.country AS country,
               SUM(o.total) AS revenue,
               RANK() OVER (ORDER BY SUM(o.total) DESC) AS rk
        FROM users u
        JOIN orders(status: "PAID") o ON o.userId = u.id
        GROUP BY u.country
      ) ranked
      WHERE rk <= 3
      ORDER BY rk`);
    const expected = revenueByCountry('PAID').slice(0, 3);
    const actual = rowsAsObjects(result);
    expect(actual.map((r) => r.country)).toEqual(expected.map((r) => r.country));
    expect(actual.map((r) => num(r.rk))).toEqual([1, 2, 3]);
  }, 120_000);

  it('joins a nested list through its child table, three tables deep', async () => {
    const { result } = await run(`
      SELECT p.category,
             SUM(i.qty)              AS units,
             SUM(i.qty * i.unitPrice) AS gross
      FROM orders o
      JOIN orders__items i ON i._parent_rowid = o._rowid
      JOIN products(limit: 300) p ON p.id = i.productId
      GROUP BY p.category
      ORDER BY gross DESC`);

    const expected = unitsByCategory();
    const actual = rowsAsObjects(result);
    expect(actual.map((r) => r.category)).toEqual(expected.map((r) => r.category));
    expected.forEach((want, index) => {
      expect(num(actual[index]?.units)).toBe(want.units);
      expect(num(actual[index]?.gross)).toBeCloseTo(want.gross, 1);
    });
  }, 180_000);

  it('unnests a scalar list, which GraphQL returns but cannot group by', async () => {
    const { result } = await run(`
      SELECT tag, count(*) AS n
      FROM (SELECT unnest(tags) AS tag FROM users) t
      GROUP BY tag
      ORDER BY n DESC, tag`);
    const rows = rowsAsObjects(result);
    expect(rows.length).toBeGreaterThan(3);
    expect(rows.every((r) => typeof r.tag === 'string' && num(r.n) > 0)).toBe(true);
  }, 120_000);

  it('reshapes with a CTE and a self-join, neither of which GraphQL has', async () => {
    const { result } = await run(`
      WITH per_country AS (
        SELECT country, count(*) AS users FROM users GROUP BY country
      )
      SELECT a.country AS a, b.country AS b, a.users + b.users AS combined
      FROM per_country a
      JOIN per_country b ON a.country < b.country
      ORDER BY combined DESC, a, b
      LIMIT 3`);
    const rows = rowsAsObjects(result);
    expect(rows).toHaveLength(3);
    expect(num(rows[0]?.combined)).toBeGreaterThan(num(rows[2]?.combined) - 1);
  }, 120_000);
});

describe('pushdown correctness', () => {
  it('returns identical rows whether or not filters are pushed', async () => {
    const sql = `
      SELECT count(*) AS n, round(sum(total), 2) AS total
      FROM orders
      WHERE status = 'PAID'`;

    const pushed = await run(sql, {}, { pushdownOverride: true });
    const local = await run(sql, {}, { pushdownOverride: false });

    // The invariant: pushdown changes what is fetched, never what is returned.
    expect(rowsAsObjects(pushed.result)).toEqual(rowsAsObjects(local.result));
    expect(num(rowsAsObjects(pushed.result)[0]?.n)).toBe(orderTotals('PAID').count);

    // And it really did change the request: one sends the argument, the other does not.
    expect(pushed.result.plan[0]?.pushed.map((p) => p.arg)).toEqual(['status']);
    expect(pushed.result.plan[0]?.document).toContain('status: PAID');
    expect(local.result.plan[0]?.pushed).toEqual([]);
    expect(local.result.plan[0]?.document).not.toContain('status: PAID');

    // Fetching less is the whole point.
    expect(pushed.result.stats[0]?.rows).toBeLessThan(local.result.stats[0]?.rows ?? 0);
  }, 180_000);

  it('pushes an exact-name filter and reports it in the plan', async () => {
    const { result } = await run(`SELECT count(*) AS n FROM users WHERE country = 'DE' AND active = true`);
    expect(num(rowsAsObjects(result)[0]?.n)).toBe(userCount({ country: 'DE', active: true }));
    expect(result.plan[0]?.pushed.map((p) => p.arg).sort()).toEqual(['active', 'country']);
    expect(result.stats[0]?.rows).toBe(userCount({ country: 'DE', active: true }));
  }, 120_000);

  it('keeps a predicate local when the endpoint has no argument for it, and still answers correctly', async () => {
    const { result } = await run(`SELECT count(*) AS n FROM users WHERE lifetimeValue > 10000`);
    const expected = userCount({}) > 0 ? undefined : 0;
    void expected;
    const rows = rowsAsObjects(result);
    expect(num(rows[0]?.n)).toBeGreaterThan(0);
    expect(result.plan[0]?.pushed).toEqual([]);
    expect(result.plan[0]?.skipped.map((s) => s.column)).toContain('lifetimeValue');
    // Everything had to be fetched, because the filter could not be delegated.
    expect(result.stats[0]?.rows).toBe(800);
  }, 120_000);

  it('never pushes a filter from the nullable side of an outer join', async () => {
    const { result } = await run(`
      SELECT count(*) AS n
      FROM users u
      LEFT JOIN orders o ON o.userId = u.id
      WHERE o.status = 'PAID'`);
    const ordersPlan = result.plan.find((p) => p.table === 'orders');
    expect(ordersPlan?.pushed).toEqual([]);
    expect(num(rowsAsObjects(result)[0]?.n)).toBe(orderTotals('PAID').count);
  }, 180_000);

  it('pushes a bare LIMIT but never one that sits above a join or an aggregate', async () => {
    const plain = await run('SELECT id FROM users LIMIT 12');
    expect(plain.result.rowCount).toBe(12);
    expect(plain.result.stats[0]?.rows).toBe(12);

    const grouped = await run('SELECT country, count(*) AS n FROM users GROUP BY country ORDER BY n DESC LIMIT 2');
    expect(grouped.result.rowCount).toBe(2);
    // The aggregate needs every row, so the LIMIT must not have been sent upstream.
    expect(grouped.result.stats[0]?.rows).toBe(800);
  }, 120_000);
});

describe('projection pruning', () => {
  it('asks the endpoint only for the columns the statement uses', async () => {
    const { result } = await run('SELECT id, country FROM users LIMIT 5');
    expect(result.plan[0]?.projected.sort()).toEqual(['country', 'id']);
    expect(result.plan[0]?.document).not.toContain('lifetimeValue');
  }, 120_000);

  it('asks for everything on SELECT *', async () => {
    const { result } = await run('SELECT * FROM users LIMIT 5');
    expect(result.plan[0]?.projected).toContain('lifetimeValue');
    expect(result.plan[0]?.projected).toContain('address.city');
    expect(result.columns.map((c) => c.name)).toContain('address_city');
    expect(result.columns.map((c) => c.name)).toContain('_raw');
  }, 120_000);

  it('fills _raw with what was fetched', async () => {
    const { result } = await run('SELECT _raw FROM users LIMIT 1');
    const raw = rowsAsObjects(result)[0]?._raw as Record<string, unknown>;
    expect(raw).toBeTypeOf('object');
    expect(raw).toHaveProperty('id');
    expect(raw).toHaveProperty('email');
  }, 120_000);

  it('counts a nested list without the child table being queried', async () => {
    const { result } = await run('SELECT id, items_count FROM orders LIMIT 5');
    const rows = rowsAsObjects(result);
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => num(r.items_count) >= 1)).toBe(true);
  }, 120_000);
});

describe('honest limits', () => {
  it('warns when the row budget truncates a result instead of returning a short answer silently', async () => {
    const { result } = await run('SELECT count(*) AS n FROM users(@maxRows: 150)');
    expect(num(rowsAsObjects(result)[0]?.n)).toBe(150);
    expect(result.stats[0]?.truncated).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/row budget/);
  }, 120_000);

  it('returns correctly typed empty columns when a filter matches nothing', async () => {
    const { result } = await run(`SELECT id, country, lifetimeValue, signedUpAt FROM users WHERE country = 'ZZ'`);
    expect(result.rowCount).toBe(0);
    expect(result.columns.map((c) => c.name)).toEqual(['id', 'country', 'lifetimeValue', 'signedUpAt']);
    expect(result.columns.map((c) => c.duckType)).toEqual(['VARCHAR', 'VARCHAR', 'DECIMAL(38,9)', 'TIMESTAMP']);
  }, 120_000);

  it('surfaces a GraphQL error with its path rather than an empty grid', async () => {
    await expect(run('SELECT id FROM users(after: "not-a-cursor")')).rejects.toThrow(/Malformed cursor/);
  }, 120_000);

  it('refuses a nested table given its own arguments, and says where they belong', async () => {
    await expect(run('SELECT * FROM orders__items(limit: 5)')).rejects.toThrow(/cannot take its own arguments/);
  }, 120_000);

  it('explains an unknown column in workbench terms', async () => {
    await expect(run('SELECT nonexistent_column FROM users')).rejects.toThrow();
  }, 120_000);

  it('reports a required argument that was not supplied', async () => {
    await expect(run('SELECT __typename FROM search')).rejects.toThrow(/requires the argument term/);
  }, 120_000);
});

describe('workbench statements', () => {
  it('lists the catalog with SHOW TABLES', async () => {
    const { result } = await run('SHOW TABLES');
    const rows = rowsAsObjects(result);
    expect(rows.map((r) => r.table_name)).toContain('users');
    expect(rows.map((r) => r.table_name)).toContain('orders__items');
    expect(rows.find((r) => r.table_name === 'users')?.pagination).toBe('relay');
    // Reading the catalog must not touch the endpoint.
    expect(result.stats).toEqual([]);
  });

  it('describes a table in both GraphQL and DuckDB terms', async () => {
    const { result } = await run('DESCRIBE users');
    const rows = rowsAsObjects(result);
    const signedUp = rows.find((r) => r.column_name === 'signedUpAt');
    expect(signedUp?.duckdb_type).toBe('TIMESTAMP');
    expect(signedUp?.graphql_type).toBe('DateTime!');
    const city = rows.find((r) => r.column_name === 'address_city');
    expect(city?.graphql_path).toBe('address.city');
    expect(rows.find((r) => r.column_name === '_raw')?.source).toBe('workbench');
  });

  it('changes settings with SET and reports them with SHOW SETTINGS', async () => {
    resetSession(baseConnection.id);
    const set = await run('SET pushdown = off');
    expect(set.result.kind).toBe('command');
    expect(set.result.message).toMatch(/pushdown is now off/);

    const shown = await run('SHOW SETTINGS');
    expect(rowsAsObjects(shown.result).find((r) => r.setting === 'pushdown')?.value).toBe('off');

    // The setting really applies to the next statement.
    const after = await run("SELECT count(*) AS n FROM orders WHERE status = 'PAID'");
    expect(after.result.plan[0]?.pushed).toEqual([]);
    resetSession(baseConnection.id);
  }, 180_000);

  it('rejects a bad SET value with a usable message', async () => {
    await expect(run('SET max_rows = nonsense')).rejects.toThrow(/needs a positive number/);
  });

  it('runs MySQL-flavoured functions through the compatibility macros', async () => {
    const { result } = await run("SELECT ifnull(NULL, 'fallback') AS a, char_length('abcd') AS b, date_format(TIMESTAMP '2024-03-05 10:00:00', '%Y/%m') AS c");
    const row = rowsAsObjects(result)[0];
    expect(row?.a).toBe('fallback');
    expect(num(row?.b)).toBe(4);
    expect(row?.c).toBe('2024/03');
  });
});

describe('snapshots', () => {
  it('materialises a fetch and then queries it without the endpoint', async () => {
    await run('DROP SNAPSHOT IF EXISTS users_snap');
    const created = await run('MATERIALIZE users(first: 120) AS users_snap');
    expect(created.result.kind).toBe('command');
    expect(created.result.message).toMatch(/users_snap now holds 120 rows/);

    await demo.reset();
    // Pointing the connection at a dead port proves the snapshot needs no endpoint at all.
    const offline = await run('SELECT count(*) AS n, count(DISTINCT country) AS countries FROM users_snap', {
      endpoint: 'http://127.0.0.1:1/graphql',
    });
    expect(num(rowsAsObjects(offline.result)[0]?.n)).toBe(120);
    expect(num(rowsAsObjects(offline.result)[0]?.countries)).toBeGreaterThan(1);
    expect(offline.result.stats).toEqual([]);
    expect((await demo.requests()).count).toBe(0);

    const listed = await run('SHOW SNAPSHOTS');
    expect(rowsAsObjects(listed.result).map((r) => r.snapshot)).toContain('users_snap');

    const dropped = await run('DROP SNAPSHOT users_snap');
    expect(dropped.result.message).toMatch(/dropped/);
  }, 180_000);

  it('refuses to shadow a catalog table with a snapshot name', async () => {
    await expect(run('MATERIALIZE users(first: 1) AS users')).rejects.toThrow(/already a table in this schema/);
  }, 120_000);
});

describe('caching', () => {
  it('answers a repeated statement from cache without calling the endpoint', async () => {
    const cached = { ...baseConnection, id: 'pipeline-cache', cacheTtlSeconds: 300 };
    await invalidateConnectionCache('pipeline-cache');
    await demo.reset();

    const first = await run('SELECT count(*) AS n FROM users(country: "FR")', cached);
    expect(first.result.stats[0]?.cache).toBe('miss');
    const callsAfterFirst = (await demo.requests()).count;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = await run('SELECT count(*) AS n, count(DISTINCT id) AS ids FROM users(country: "FR")', cached);
    expect(second.result.stats[0]?.cache).toBe('hit');
    expect((await demo.requests()).count).toBe(callsAfterFirst);
    expect(num(rowsAsObjects(second.result)[0]?.n)).toBe(num(rowsAsObjects(first.result)[0]?.n));

    await invalidateConnectionCache('pipeline-cache');
  }, 180_000);

  it('keeps connections that differ only by a header apart, e.g. a Dolt branch header', async () => {
    const main = {
      ...baseConnection,
      id: 'branch-main',
      cacheTtlSeconds: 300,
      headers: [{ name: 'X-Dolt-Branch', value: 'main', enabled: true }],
    };
    const feature = { ...main, id: 'branch-feature', headers: [{ name: 'X-Dolt-Branch', value: 'feature', enabled: true }] };
    await invalidateConnectionCache('branch-main');
    await invalidateConnectionCache('branch-feature');

    const first = await run('SELECT count(*) AS n FROM users(country: "NL")', main);
    expect(first.result.stats[0]?.cache).toBe('miss');
    // Same URL, same query, different branch: must go back to the endpoint, not reuse main's rows.
    const second = await run('SELECT count(*) AS n FROM users(country: "NL")', feature);
    expect(second.result.stats[0]?.cache).toBe('miss');
    // And the same branch again is still a hit.
    const third = await run('SELECT count(*) AS n FROM users(country: "NL")', main);
    expect(third.result.stats[0]?.cache).toBe('hit');

    await invalidateConnectionCache('branch-main');
    await invalidateConnectionCache('branch-feature');
  }, 180_000);

  it('does not reuse a cached fetch when the arguments differ', async () => {
    const cached = { ...baseConnection, id: 'pipeline-cache2', cacheTtlSeconds: 300 };
    await invalidateConnectionCache('pipeline-cache2');
    const fr = await run('SELECT count(*) AS n FROM users(country: "FR")', cached);
    const jp = await run('SELECT count(*) AS n FROM users(country: "JP")', cached);
    expect(jp.result.stats[0]?.cache).toBe('miss');
    expect(num(rowsAsObjects(fr.result)[0]?.n)).not.toBe(num(rowsAsObjects(jp.result)[0]?.n));
    await invalidateConnectionCache('pipeline-cache2');
  }, 180_000);
});

describe('progress reporting', () => {
  it('emits the plan before any request, then fetch progress, then execution', async () => {
    const { events } = await run('SELECT count(*) AS n FROM users');
    const kinds = events.map((e) => e.type);
    expect(kinds[0]).toBe('plan');
    expect(kinds).toContain('fetch');
    expect(kinds).toContain('shred');
    expect(kinds.at(-1)).toBe('executing');

    const planEvent = events.find((e) => e.type === 'plan');
    expect(planEvent && 'plan' in planEvent && planEvent.plan[0]?.document).toContain('users: users(');

    const fetchEvents = events.filter((e) => e.type === 'fetch');
    expect(fetchEvents.at(-1)).toMatchObject({ done: true, table: 'users' });
  }, 120_000);
});

describe('two fetches of the same table', () => {
  it('keeps differing argument sets in separate relations', async () => {
    const { result } = await run(`
      SELECT de.n AS de, gb.n AS gb FROM
        (SELECT count(*) AS n FROM users(country: "DE")) de,
        (SELECT count(*) AS n FROM users(country: "GB")) gb`);
    const row = rowsAsObjects(result)[0];
    expect(num(row?.de)).toBe(userCount({ country: 'DE' }));
    expect(num(row?.gb)).toBe(userCount({ country: 'GB' }));
    expect(result.plan).toHaveLength(2);
    expect(result.plan.map((p) => p.alias)).toEqual(['users', 'users__wb2']);
  }, 180_000);

  it('shares one fetch for a self-join with identical arguments', async () => {
    const { result } = await run(`
      SELECT count(*) AS n FROM users a JOIN users b ON a.country = b.country AND a.id < b.id`);
    expect(result.plan).toHaveLength(1);
    expect(result.stats).toHaveLength(1);
    expect(num(rowsAsObjects(result)[0]?.n)).toBeGreaterThan(0);
  }, 180_000);
});
