import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Catalog, CatalogTable } from '@gqlwb/shared';
import { getCatalog, invalidateCatalog, introspectSchema } from '../src/catalog/introspect.ts';
import { demoConnection, startDemoApi, type DemoHandle } from './helpers/demo-server.ts';
import { SDL } from '../../demo-api/src/schema.ts';

let demo: DemoHandle;
let catalog: Catalog;

const table = (name: string): CatalogTable => {
  const found = catalog.tables.find((t) => t.name === name);
  if (!found) throw new Error(`No table ${name}. Have: ${catalog.tables.map((t) => t.name).join(', ')}`);
  return found;
};
const columnNames = (t: CatalogTable): string[] => t.columns.filter((c) => !c.synthetic).map((c) => c.name);

beforeAll(async () => {
  demo = await startDemoApi();
  catalog = await getCatalog(demoConnection(demo.endpoint, { id: 'demo-catalog' }));
});

afterAll(async () => {
  invalidateCatalog('demo-catalog');
  await demo?.stop();
});

describe('introspecting the demo endpoint over HTTP', () => {
  it('reads the schema and records where it came from', () => {
    expect(catalog.source).toBe('introspection');
    expect(catalog.queryTypeName).toBe('Query');
    expect(catalog.schemaHash).toMatch(/^[0-9a-f]{16}$/);
    expect(catalog.endpoint).toBe(demo.endpoint);
  });

  it('turns every Query field into a table', () => {
    const roots = catalog.tables.filter((t) => !t.isChild).map((t) => t.name);
    expect(roots).toEqual(['users', 'orders', 'products', 'productsPaged', 'me', 'serverInfo', 'search', 'node']);
  });

  it('classifies each pagination style correctly', () => {
    expect(table('users').pagination.style).toBe('relay');
    expect(table('orders').pagination.style).toBe('offset');
    expect(table('products').pagination.style).toBe('offset');
    expect(table('productsPaged').pagination.style).toBe('page');
    expect(table('me').pagination.style).toBe('none');
    expect(table('serverInfo').pagination.style).toBe('none');
  });

  it('exposes the unmodelled join key as an ordinary column', () => {
    // This is the whole point: orders.userId is selectable, so SQL can join it to users.id.
    expect(columnNames(table('orders'))).toContain('userId');
    expect(columnNames(table('users'))).toContain('id');
    expect(table('orders').columns.find((c) => c.name === 'userId')?.duckType).toBe('VARCHAR');
  });

  it('flattens the nested address and keeps tags as a list', () => {
    const users = table('users');
    expect(columnNames(users)).toContain('address_city');
    expect(columnNames(users)).toContain('address_postcode');
    expect(users.columns.find((c) => c.name === 'tags')?.duckType).toBe('VARCHAR[]');
    expect(users.columns.find((c) => c.name === 'address_postcode')?.nullable).toBe(true);
  });

  it('maps the demo custom scalars onto real DuckDB types', () => {
    const users = table('users');
    expect(users.columns.find((c) => c.name === 'signedUpAt')?.duckType).toBe('TIMESTAMP');
    expect(users.columns.find((c) => c.name === 'lifetimeValue')?.duckType).toBe('DECIMAL(38,9)');
    expect(table('orders').columns.find((c) => c.name === 'total')?.duckType).toBe('DECIMAL(38,9)');
    expect(table('products').columns.find((c) => c.name === 'rating')?.duckType).toBe('DOUBLE');
  });

  it('creates the order-items child table with a join key', () => {
    expect(table('orders').childTables).toEqual(['orders__items']);
    const items = table('orders__items');
    expect(items.parent).toBe('orders');
    expect(items.parentKeyColumn).toBe('_parent_rowid');
    expect(columnNames(items)).toEqual(['sku', 'productId', 'qty', 'unitPrice']);
    // The parent's id is copied so joins read naturally.
    expect(items.columns.map((c) => c.name)).toContain('_parent_id');
  });

  it('stops on the self-referential manager field', () => {
    expect(columnNames(table('users')).filter((c) => c.startsWith('manager'))).toEqual([]);
    expect(catalog.warnings.some((w) => w.includes('manager') && w.includes('cycle'))).toBe(true);
  });

  it('records the deprecated field with its reason', () => {
    const legacy = table('users').columns.find((c) => c.name === 'legacyName');
    expect(legacy?.deprecationReason).toBe('Use name instead.');
  });

  it('captures the Hasura-shaped filter surface on products', () => {
    const where = table('products').args.find((a) => a.name === 'where');
    expect(where?.kind).toBe('input');
    expect(where?.inputFields?.map((f) => f.name)).toEqual(['category', 'title', 'sku', 'price', 'stock']);
    const category = where?.inputFields?.find((f) => f.name === 'category');
    expect(category?.inputFields?.map((f) => f.name)).toEqual(['_eq', '_neq', '_in', '_like']);
  });

  it('captures exact-name filter arguments on users, which auto pushdown can use', () => {
    const args = table('users').args.map((a) => a.name);
    expect(args).toEqual(['first', 'after', 'last', 'before', 'role', 'country', 'active']);
    const role = table('users').args.find((a) => a.name === 'role');
    expect(role?.enumValues).toEqual(['ADMIN', 'CUSTOMER', 'GUEST']);
  });

  it('marks search.term required so the planner can demand it', () => {
    const term = table('search').args.find((a) => a.name === 'term');
    expect(term?.required).toBe(true);
  });

  it('degrades the union to __typename and _raw with an explanation', () => {
    expect(columnNames(table('search'))).toEqual(['__typename']);
    expect(table('search').columns.map((c) => c.name)).toContain('_raw');
    expect(catalog.warnings.some((w) => w.includes('SearchResult'))).toBe(true);
  });

  it('exposes the interface-typed node field with __typename', () => {
    expect(columnNames(table('node'))).toContain('__typename');
    expect(columnNames(table('node'))).toContain('id');
  });

  it('lists mutations without making them queryable', () => {
    expect(catalog.mutationNames).toEqual(['cancelOrder', 'touch']);
    expect(catalog.tables.map((t) => t.name)).not.toContain('cancelOrder');
  });

  it('carries schema descriptions through for the browser', () => {
    expect(table('orders').description).toContain('Offset pagination');
    expect(table('orders').columns.find((c) => c.name === 'userId')?.description).toContain('unmodelled');
  });
});

describe('caching and refresh', () => {
  it('serves a cached catalog without touching the endpoint again', async () => {
    const conn = demoConnection(demo.endpoint, { id: 'cache-test' });
    await demo.reset();
    await getCatalog(conn);
    const afterFirst = (await demo.requests()).count;
    expect(afterFirst).toBeGreaterThan(0);

    await getCatalog(conn);
    expect((await demo.requests()).count).toBe(afterFirst);

    await getCatalog(conn, { refresh: true });
    expect((await demo.requests()).count).toBeGreaterThan(afterFirst);
    invalidateCatalog('cache-test');
  });

  it('rebuilds when a setting that changes the catalog changes', async () => {
    const shallow = await getCatalog(demoConnection(demo.endpoint, { id: 'depth-test', maxDepth: 1 }));
    expect(shallow.tables.find((t) => t.name === 'users')?.columns.map((c) => c.name)).not.toContain('address_city');

    const deep = await getCatalog(demoConnection(demo.endpoint, { id: 'depth-test', maxDepth: 3 }));
    expect(deep.tables.find((t) => t.name === 'users')?.columns.map((c) => c.name)).toContain('address_city');
    invalidateCatalog('depth-test');
  });
});

describe('the SDL fallback, for endpoints with introspection disabled', () => {
  it('refuses to guess when introspection is blocked and no SDL is supplied', async () => {
    const conn = demoConnection(demo.strictEndpoint, { id: 'strict-test' });
    await expect(getCatalog(conn)).rejects.toThrow(/Could not read the schema/);
    invalidateCatalog('strict-test');
  });

  it('builds the same catalog from pasted SDL', async () => {
    const conn = demoConnection(demo.strictEndpoint, { id: 'sdl-test', sdl: SDL });
    const fromSdl = await getCatalog(conn);
    expect(fromSdl.source).toBe('sdl');
    expect(fromSdl.tables.map((t) => t.name)).toEqual(catalog.tables.map((t) => t.name));
    expect(fromSdl.tables.find((t) => t.name === 'users')?.pagination.style).toBe('relay');
    invalidateCatalog('sdl-test');
  });

  it('reports invalid SDL clearly instead of failing later', async () => {
    const conn = demoConnection(demo.endpoint, { id: 'bad-sdl', sdl: 'type Query { oops: ' });
    await expect(getCatalog(conn)).rejects.toThrow(/could not be parsed/);
    invalidateCatalog('bad-sdl');
  });

  it('prefers SDL over introspection when both are available', async () => {
    const conn = demoConnection(demo.endpoint, { id: 'sdl-wins', sdl: 'type Query { onlyField: String }' });
    const result = await introspectSchema(conn);
    expect(result.source).toBe('sdl');
    expect(Object.keys(result.schema.getQueryType()?.getFields() ?? {})).toEqual(['onlyField']);
    invalidateCatalog('sdl-wins');
  });
});
