import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Catalog, CatalogTable } from '@gqlwb/shared';
import { getCatalog, invalidateCatalog } from '../src/catalog/introspect.ts';
import { buildFetchDocument, extractRows, toValueNode } from '../src/plan/document.ts';
import { fetchTable } from '../src/fetch/paginate.ts';
import { invalidateConnectionCache } from '../src/fetch/cache.ts';
import { demoConnection, startDemoApi, type DemoHandle } from './helpers/demo-server.ts';
import { print, parse, Kind, type FieldNode, type OperationDefinitionNode } from 'graphql';

let demo: DemoHandle;
let catalog: Catalog;

const table = (name: string): CatalogTable => {
  const found = catalog.tables.find((t) => t.name === name);
  if (!found) throw new Error(`No table ${name}`);
  return found;
};

/** All non-synthetic leaf paths for a table, which is what SELECT * projects. */
const allPaths = (t: CatalogTable): string[][] =>
  t.columns.filter((c) => !c.synthetic && c.path.length > 0).map((c) => c.path);

const readRows = (file: string): Record<string, unknown>[] =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

const printValue = (value: unknown, arg?: Parameters<typeof toValueNode>[1]): string =>
  print(toValueNode(value, arg) as never);

/**
 * graphql's printer reformats long argument lists (dropping commas and wrapping), so structural
 * assertions parse the document and inspect the AST rather than matching printed text.
 */
function rootArgsOf(document: string): Record<string, string> {
  const op = parse(document).definitions[0] as OperationDefinitionNode;
  const field = op.selectionSet.selections[0] as FieldNode;
  const out: Record<string, string> = {};
  for (const arg of field.arguments ?? []) out[arg.name.value] = print(arg.value);
  return out;
}

function rootFieldOf(document: string): { alias?: string; name: string } {
  const op = parse(document).definitions[0] as OperationDefinitionNode;
  const field = op.selectionSet.selections[0] as FieldNode;
  return { alias: field.alias?.value, name: field.name.value };
}

beforeAll(async () => {
  demo = await startDemoApi();
  catalog = await getCatalog(demoConnection(demo.endpoint, { id: 'fetch-catalog' }));
});

afterAll(async () => {
  invalidateCatalog('fetch-catalog');
  await demo?.stop();
});

describe('GraphQL literal rendering', () => {
  it('quotes strings and escapes what needs escaping', () => {
    expect(printValue('plain')).toBe('"plain"');
    expect(printValue('with "quotes" and \\ backslash')).toBe('"with \\"quotes\\" and \\\\ backslash"');
    expect(printValue('new\nline')).toContain('\\n');
  });

  it('renders an enum bare rather than quoted, using the argument metadata', () => {
    const roleArg = table('users').args.find((a) => a.name === 'role');
    expect(roleArg?.kind).toBe('enum');
    expect(printValue('ADMIN', roleArg)).toBe('ADMIN');
    // Without metadata it stays a string, which is the safe default.
    expect(printValue('ADMIN')).toBe('"ADMIN"');
  });

  it('renders numbers, booleans, null and lists', () => {
    expect(printValue(42)).toBe('42');
    expect(printValue(1.5)).toBe('1.5');
    expect(printValue(true)).toBe('true');
    expect(printValue(null)).toBe('null');
    expect(printValue([1, 2, 3])).toBe('[1, 2, 3]');
  });

  it('renders a nested input object, keeping enum fields bare', () => {
    const whereArg = table('products').args.find((a) => a.name === 'where');
    // Parsed back, the literal must carry exactly the intended shape and types.
    const rendered = printValue({ category: { _eq: 'Audio' }, price: { _gt: 100 } }, whereArg);
    const reparsed = parse(`{ products(where: ${rendered}) { id } }`);
    const field = (reparsed.definitions[0] as OperationDefinitionNode).selectionSet.selections[0] as FieldNode;
    const value = field.arguments?.[0]?.value;
    expect(value?.kind).toBe(Kind.OBJECT);
    expect(rendered).toMatch(/_eq:\s*"Audio"/);
    expect(rendered).toMatch(/_gt:\s*100/);
    expect(rendered).not.toMatch(/"100"/);
  });

  it('never emits an unquoted string that could be mistaken for a variable', () => {
    expect(printValue('$injected')).toBe('"$injected"');
    expect(toValueNode('$injected').kind).toBe(Kind.STRING);
  });
});

describe('document generation', () => {
  it('builds a Relay query with pageInfo and a cursor variable', () => {
    const plan = buildFetchDocument({
      table: table('users'),
      alias: 'users',
      args: { country: 'DE' },
      projection: [['id'], ['name'], ['address', 'city']],
      childPaths: [],
      pageSize: 50,
    });
    expect(plan.document).toBe(
      [
        'query WorkbenchFetch($after_users: String) {',
        '  users: users(country: "DE", first: 50, after: $after_users) {',
        '    edges {',
        '      node {',
        '        id',
        '        name',
        '        address {',
        '          city',
        '        }',
        '      }',
        '    }',
        '    pageInfo {',
        '      hasNextPage',
        '      endCursor',
        '    }',
        '    totalCount',
        '  }',
        '}',
      ].join('\n'),
    );
    expect(plan.variables).toEqual({ after_users: null });
    expect(plan.pageVariable).toEqual({ name: 'after_users', kind: 'cursor' });
    expect(plan.nodesPath).toEqual(['edges', 'node']);
  });

  it('builds an offset query with a limit and an offset variable', () => {
    const plan = buildFetchDocument({
      table: table('orders'),
      alias: 'o0',
      args: { status: 'PAID' },
      projection: [['id'], ['total']],
      childPaths: [],
      pageSize: 25,
    });
    expect(rootFieldOf(plan.document)).toEqual({ alias: 'o0', name: 'orders' });
    expect(rootArgsOf(plan.document)).toEqual({ status: 'PAID', limit: '25', offset: '$offset_o0' });
    expect(plan.document).toContain('nodes {');
    expect(plan.document).toContain('totalCount');
    expect(plan.pageVariable).toEqual({ name: 'offset_o0', kind: 'offset' });
    expect(plan.variables).toEqual({ offset_o0: 0 });
  });

  it('builds a page/perPage query', () => {
    const plan = buildFetchDocument({
      table: table('productsPaged'),
      alias: 'p0',
      args: {},
      projection: [['id']],
      childPaths: [],
      pageSize: 10,
    });
    expect(rootArgsOf(plan.document)).toEqual({ perPage: '10', page: '$page_p0' });
    expect(plan.pageVariable).toEqual({ name: 'page_p0', kind: 'page' });
  });

  it('builds a bare-list query with no envelope', () => {
    const plan = buildFetchDocument({
      table: table('products'),
      alias: 'pr',
      args: { where: { category: { _eq: 'Audio' } } },
      projection: [['id'], ['price']],
      childPaths: [],
      pageSize: 100,
    });
    const args = rootArgsOf(plan.document);
    expect(Object.keys(args).sort()).toEqual(['limit', 'offset', 'where']);
    expect(args.limit).toBe('100');
    expect(args.offset).toBe('$offset_pr');
    expect(args.where).toMatch(/_eq:\s*"Audio"/);
    expect(plan.nodesPath).toEqual([]);
    expect(plan.document).not.toContain('pageInfo');
  });

  it('builds a single-object query with no pagination at all', () => {
    const plan = buildFetchDocument({
      table: table('me'),
      alias: 'me',
      args: {},
      projection: [['id'], ['name']],
      childPaths: [],
      pageSize: 50,
    });
    expect(plan.pageVariable).toBeUndefined();
    expect(plan.variables).toEqual({});
    expect(plan.document).toContain('me: me {');
  });

  it('includes child-table selections in the parent document', () => {
    const items = table('orders__items');
    const plan = buildFetchDocument({
      table: table('orders'),
      alias: 'o0',
      args: {},
      projection: [['id']],
      childPaths: items.columns.filter((c) => !c.synthetic).map((c) => ['items', ...c.path]),
      pageSize: 50,
    });
    expect(plan.document).toContain('items {');
    expect(plan.document).toContain('sku');
    expect(plan.document).toContain('unitPrice');
  });

  it('prunes the projection to only what was asked for', () => {
    const plan = buildFetchDocument({
      table: table('users'),
      alias: 'u',
      args: {},
      projection: [['id']],
      childPaths: [],
      pageSize: 50,
    });
    expect(plan.document).toContain('id');
    expect(plan.document).not.toContain('lifetimeValue');
    expect(plan.document).not.toContain('address');
  });

  it('falls back to the primary key when no columns are needed', () => {
    const plan = buildFetchDocument({
      table: table('users'),
      alias: 'u',
      args: {},
      projection: [],
      childPaths: [],
      pageSize: 50,
    });
    // COUNT(*) needs no columns, but GraphQL still requires a selection.
    expect(plan.document).toContain('id');
  });

  it('refuses to invent a required argument, and says how to supply it', () => {
    expect(() =>
      buildFetchDocument({ table: table('search'), alias: 's', args: {}, projection: [['__typename']], childPaths: [], pageSize: 10 }),
    ).toThrow(/requires the argument term/);
    expect(() =>
      buildFetchDocument({ table: table('search'), alias: 's', args: {}, projection: [['__typename']], childPaths: [], pageSize: 10 }),
    ).toThrow();
  });

  it('refuses to fetch a child table on its own', () => {
    expect(() =>
      buildFetchDocument({ table: table('orders__items'), alias: 'i', args: {}, projection: [['sku']], childPaths: [], pageSize: 10 }),
    ).toThrow(/child table/);
  });

  it('honours an explicit page size from the user over the connection default', () => {
    const plan = buildFetchDocument({
      table: table('users'),
      alias: 'u',
      args: { first: 7 },
      projection: [['id']],
      childPaths: [],
      pageSize: 50,
    });
    expect(rootArgsOf(plan.document).first).toBe('7');
  });
});

describe('row extraction', () => {
  it('unwraps edges/node, nodes and bare lists alike', () => {
    expect(extractRows({ edges: [{ node: { id: 1 } }, { node: { id: 2 } }] }, ['edges', 'node'])).toEqual([{ id: 1 }, { id: 2 }]);
    expect(extractRows({ nodes: [{ id: 1 }] }, ['nodes'])).toEqual([{ id: 1 }]);
    expect(extractRows([{ id: 1 }], [])).toEqual([{ id: 1 }]);
    expect(extractRows({ id: 1 }, [])).toEqual([{ id: 1 }]);
  });

  it('treats absent and null values as no rows rather than throwing', () => {
    expect(extractRows(null, [])).toEqual([]);
    expect(extractRows(undefined, ['edges', 'node'])).toEqual([]);
    expect(extractRows({ edges: null }, ['edges', 'node'])).toEqual([]);
    expect(extractRows({ edges: [{ node: null }] }, ['edges', 'node'])).toEqual([]);
  });
});

describe('pagination against a live endpoint', () => {
  it('walks every page of a Relay connection', async () => {
    const conn = demoConnection(demo.endpoint, { pageSize: 50, maxRows: 5000 });
    const spec = { table: table('users'), alias: 'u', args: {}, projection: [['id'], ['country']], childPaths: [], pageSize: 50 };
    const plan = buildFetchDocument(spec);
    const progress: { pages: number; rows: number }[] = [];

    const result = await fetchTable({
      conn,
      spec,
      plan,
      maxRows: 5000,
      useCache: false,
      cacheKeyParts: ['relay-all'],
      onProgress: (info) => progress.push({ pages: info.pages, rows: info.rows }),
    });

    expect(result.rowCount).toBe(800);
    expect(result.pages).toBe(16);
    expect(result.truncated).toBe(false);
    expect(result.total).toBe(800);
    expect(result.cache).toBe('off');
    expect(progress.length).toBeGreaterThan(10);

    const rows = readRows(result.file);
    expect(rows).toHaveLength(800);
    expect(rows[0]?.id).toBe('u-0001');
    expect(rows[799]?.id).toBe('u-0800');
    // _rowid is assigned at fetch time so row identity never depends on DuckDB read order.
    expect(rows.map((r) => r._rowid).slice(0, 3)).toEqual([0, 1, 2]);
  });

  it('walks every page of an offset list', async () => {
    const conn = demoConnection(demo.endpoint, { pageSize: 100 });
    const spec = { table: table('orders'), alias: 'o', args: { status: 'PAID' }, projection: [['id'], ['total']], childPaths: [], pageSize: 100 };
    const result = await fetchTable({
      conn,
      spec,
      plan: buildFetchDocument(spec),
      maxRows: 5000,
      useCache: false,
      cacheKeyParts: ['offset-all'],
    });
    expect(result.rowCount).toBe(1486);
    expect(result.pages).toBe(15);
    expect(result.total).toBe(1486);
    expect(result.truncated).toBe(false);
  });

  it('walks every page of a page/perPage list', async () => {
    const conn = demoConnection(demo.endpoint, { pageSize: 40 });
    const spec = { table: table('productsPaged'), alias: 'p', args: {}, projection: [['id']], childPaths: [], pageSize: 40 };
    const result = await fetchTable({
      conn,
      spec,
      plan: buildFetchDocument(spec),
      maxRows: 5000,
      useCache: false,
      cacheKeyParts: ['page-all'],
    });
    expect(result.rowCount).toBe(300);
    expect(result.pages).toBe(8);
  });

  it('stops at the row budget and warns instead of returning a short result silently', async () => {
    const conn = demoConnection(demo.endpoint, { pageSize: 50 });
    const spec = { table: table('users'), alias: 'u', args: {}, projection: [['id']], childPaths: [], pageSize: 50 };
    const result = await fetchTable({
      conn,
      spec,
      plan: buildFetchDocument(spec),
      maxRows: 120,
      useCache: false,
      cacheKeyParts: ['budget'],
    });
    expect(result.rowCount).toBe(120);
    expect(result.truncated).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/row budget/);
    expect(readRows(result.file)).toHaveLength(120);
  });

  it('fetches a single object as exactly one row', async () => {
    const conn = demoConnection(demo.endpoint);
    const spec = { table: table('me'), alias: 'me', args: {}, projection: [['id'], ['name']], childPaths: [], pageSize: 50 };
    const result = await fetchTable({ conn, spec, plan: buildFetchDocument(spec), maxRows: 100, useCache: false, cacheKeyParts: ['me'] });
    expect(result.rowCount).toBe(1);
    expect(result.pages).toBe(1);
    expect(readRows(result.file)[0]?.id).toBe('u-0001');
  });

  it('fetches nested child rows inside the parent payload', async () => {
    const conn = demoConnection(demo.endpoint, { pageSize: 50 });
    const spec = {
      table: table('orders'),
      alias: 'o',
      args: {},
      projection: [['id']],
      childPaths: [['items', 'sku'], ['items', 'qty']],
      childTables: [],
      pageSize: 50,
    };
    const result = await fetchTable({
      conn,
      spec,
      plan: buildFetchDocument(spec),
      maxRows: 100,
      useCache: false,
      cacheKeyParts: ['children'],
    });
    const rows = readRows(result.file);
    expect(rows).toHaveLength(100);
    const items = rows[0]?.items as { sku: string; qty: number }[];
    expect(Array.isArray(items)).toBe(true);
    expect(items[0]).toHaveProperty('sku');
    expect(items[0]).toHaveProperty('qty');
  });

  it('pushes a filter argument through and gets fewer rows back', async () => {
    const conn = demoConnection(demo.endpoint, { pageSize: 200 });
    const spec = { table: table('users'), alias: 'u', args: { country: 'DE', active: true }, projection: [['id'], ['country']], childPaths: [], pageSize: 200 };
    const result = await fetchTable({
      conn,
      spec,
      plan: buildFetchDocument(spec),
      maxRows: 5000,
      useCache: false,
      cacheKeyParts: ['filtered'],
    });
    expect(result.rowCount).toBe(65);
    expect(readRows(result.file).every((r) => r.country === 'DE')).toBe(true);
  });
});

describe('resilience', () => {
  it('retries a transient 503 and still returns the data', async () => {
    const conn = demoConnection(demo.endpoint, { pageSize: 200 });
    const spec = { table: table('users'), alias: 'u', args: {}, projection: [['id']], childPaths: [], pageSize: 200 };
    const result = await fetchTable({
      conn,
      spec,
      plan: buildFetchDocument(spec),
      maxRows: 200,
      useCache: false,
      cacheKeyParts: ['retry'],
      extraHeaders: { 'x-demo-fail-first': '2', 'x-demo-run': 'retry-test' },
    });
    expect(result.rowCount).toBe(200);
    expect(result.retries).toBeGreaterThanOrEqual(2);
    expect(result.requests).toBeGreaterThan(result.pages);
  });

  it('honours Retry-After on a 429 rather than hammering the endpoint', async () => {
    const conn = demoConnection(demo.endpoint, { pageSize: 100 });
    const spec = { table: table('users'), alias: 'u', args: {}, projection: [['id']], childPaths: [], pageSize: 100 };
    const started = Date.now();
    const result = await fetchTable({
      conn,
      spec,
      plan: buildFetchDocument(spec),
      maxRows: 300,
      useCache: false,
      cacheKeyParts: ['ratelimit'],
      extraHeaders: { 'x-demo-rate-limit': '2', 'x-demo-run': 'rl-test' },
    });
    expect(result.rowCount).toBe(300);
    // One 429 forces at least a one-second wait, which proves Retry-After was read.
    expect(Date.now() - started).toBeGreaterThan(900);
    expect(result.retries).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('gives up with a clear message when the endpoint is unreachable', async () => {
    const conn = demoConnection('http://127.0.0.1:1/graphql', { timeoutMs: 2000 });
    const spec = { table: table('users'), alias: 'u', args: {}, projection: [['id']], childPaths: [], pageSize: 10 };
    await expect(
      fetchTable({ conn, spec, plan: buildFetchDocument(spec), maxRows: 10, useCache: false, cacheKeyParts: ['unreachable'] }),
    ).rejects.toThrow(/Could not reach|did not respond/);
  }, 30_000);

  it('surfaces a GraphQL error instead of pretending there are no rows', async () => {
    const conn = demoConnection(demo.endpoint);
    const spec = { table: table('users'), alias: 'u', args: { after: 'not-a-cursor' }, projection: [['id']], childPaths: [], pageSize: 10 };
    await expect(
      fetchTable({ conn, spec, plan: buildFetchDocument(spec), maxRows: 10, useCache: false, cacheKeyParts: ['gqlerror'] }),
    ).rejects.toThrow(/Malformed cursor/);
  });

  it('stops immediately when the run is cancelled', async () => {
    const conn = demoConnection(demo.endpoint, { pageSize: 10, concurrency: 1 });
    const spec = { table: table('users'), alias: 'u', args: {}, projection: [['id']], childPaths: [], pageSize: 10 };
    const controller = new AbortController();
    const promise = fetchTable({
      conn,
      spec,
      plan: buildFetchDocument(spec),
      maxRows: 5000,
      useCache: false,
      cacheKeyParts: ['cancel'],
      signal: controller.signal,
      extraHeaders: { 'x-demo-latency': '40' },
      onProgress: (info) => {
        if (info.pages >= 2) controller.abort();
      },
    });
    await expect(promise).rejects.toThrow(/[Cc]ancel/);
  }, 30_000);
});

describe('caching', () => {
  it('serves a second identical fetch from cache without calling the endpoint', async () => {
    const conn = demoConnection(demo.endpoint, { id: 'cache-conn', pageSize: 100, cacheTtlSeconds: 120 });
    const spec = { table: table('users'), alias: 'u', args: {}, projection: [['id']], childPaths: [], pageSize: 100 };
    const plan = buildFetchDocument(spec);
    await invalidateConnectionCache('cache-conn');
    await demo.reset();

    const first = await fetchTable({ conn, spec, plan, maxRows: 300, useCache: true, cacheKeyParts: ['cache-demo'] });
    expect(first.cache).toBe('miss');
    const callsAfterFirst = (await demo.requests()).count;
    expect(callsAfterFirst).toBe(3);

    const second = await fetchTable({ conn, spec, plan, maxRows: 300, useCache: true, cacheKeyParts: ['cache-demo'] });
    expect(second.cache).toBe('hit');
    expect(second.rowCount).toBe(first.rowCount);
    expect(second.file).toBe(first.file);
    expect((await demo.requests()).count).toBe(callsAfterFirst);

    // Refreshing drops the entry, so the next fetch goes back to the endpoint.
    await invalidateConnectionCache('cache-conn');
    const third = await fetchTable({ conn, spec, plan, maxRows: 300, useCache: true, cacheKeyParts: ['cache-demo'] });
    expect(third.cache).toBe('miss');
    expect((await demo.requests()).count).toBeGreaterThan(callsAfterFirst);
    await invalidateConnectionCache('cache-conn');
  });

  it('does not let a different key reuse another fetch', async () => {
    const conn = demoConnection(demo.endpoint, { id: 'cache-conn-2', pageSize: 100, cacheTtlSeconds: 120 });
    const spec = { table: table('users'), alias: 'u', args: {}, projection: [['id']], childPaths: [], pageSize: 100 };
    const plan = buildFetchDocument(spec);
    await invalidateConnectionCache('cache-conn-2');
    const a = await fetchTable({ conn, spec, plan, maxRows: 100, useCache: true, cacheKeyParts: ['k-a'] });
    const b = await fetchTable({ conn, spec, plan, maxRows: 100, useCache: true, cacheKeyParts: ['k-b'] });
    expect(a.file).not.toBe(b.file);
    expect(b.cache).toBe('miss');
    await invalidateConnectionCache('cache-conn-2');
  });
});
