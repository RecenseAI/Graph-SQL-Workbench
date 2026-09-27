import { describe, expect, it } from 'vitest';
import { buildSchema } from 'graphql';
import { buildCatalog } from '../src/catalog/build.ts';
import { mapScalar } from '../src/catalog/typemap.ts';
import type { Catalog, CatalogTable } from '@gqlwb/shared';

function catalogFrom(sdl: string, overrides: { maxDepth?: number; scalarTypeMap?: Record<string, string> } = {}): Catalog {
  return buildCatalog(buildSchema(sdl), {
    connectionId: 'test',
    endpoint: 'http://example.test/graphql',
    maxDepth: overrides.maxDepth ?? 3,
    pageSize: 200,
    scalarTypeMap: overrides.scalarTypeMap ?? {},
  });
}

const table = (catalog: Catalog, name: string): CatalogTable => {
  const found = catalog.tables.find((t) => t.name === name);
  if (!found) throw new Error(`No table ${name}. Have: ${catalog.tables.map((t) => t.name).join(', ')}`);
  return found;
};
const columnNames = (t: CatalogTable): string[] => t.columns.filter((c) => !c.synthetic).map((c) => c.name);
const column = (t: CatalogTable, name: string) => {
  const found = t.columns.find((c) => c.name === name);
  if (!found) throw new Error(`No column ${name} on ${t.name}. Have: ${t.columns.map((c) => c.name).join(', ')}`);
  return found;
};

describe('pagination detection', () => {
  it('recognises a Relay cursor connection', () => {
    const catalog = catalogFrom(`
      type PageInfo { hasNextPage: Boolean! endCursor: String }
      type UserEdge { cursor: String! node: User! }
      type UserConnection { edges: [UserEdge!]! pageInfo: PageInfo! totalCount: Int! }
      type User { id: ID! name: String! }
      type Query { users(first: Int, after: String, role: String): UserConnection! }
    `);
    const users = table(catalog, 'users');
    expect(users.pagination.style).toBe('relay');
    expect(users.pagination.nodesPath).toEqual(['edges', 'node']);
    expect(users.pagination.firstArg).toBe('first');
    expect(users.pagination.afterArg).toBe('after');
    expect(users.pagination.pageInfoPath).toEqual(['pageInfo']);
    expect(users.pagination.hasNextField).toBe('hasNextPage');
    expect(users.pagination.endCursorField).toBe('endCursor');
    expect(users.pagination.totalField).toBe('totalCount');
    expect(columnNames(users)).toEqual(['id', 'name']);
  });

  it('recognises a nodes-style Relay connection', () => {
    const catalog = catalogFrom(`
      type PageInfo { hasNextPage: Boolean! endCursor: String }
      type User { id: ID! }
      type UserConnection { nodes: [User!]! pageInfo: PageInfo! }
      type Query { users(first: Int, after: String): UserConnection! }
    `);
    expect(table(catalog, 'users').pagination.nodesPath).toEqual(['nodes']);
    expect(table(catalog, 'users').pagination.style).toBe('relay');
  });

  it('recognises snake_case page_info and has_more/next_cursor spellings', () => {
    const catalog = catalogFrom(`
      type PageMeta { has_more: Boolean! next_cursor: String }
      type Item { id: ID! }
      type ItemList { items: [Item!]! page_info: PageMeta! }
      type Query { items(first: Int, cursor: String): ItemList! }
    `);
    const items = table(catalog, 'items');
    expect(items.pagination.style).toBe('relay');
    expect(items.pagination.hasNextField).toBe('has_more');
    expect(items.pagination.endCursorField).toBe('next_cursor');
    expect(items.pagination.afterArg).toBe('cursor');
  });

  it('recognises offset pagination on a wrapper object', () => {
    const catalog = catalogFrom(`
      type Order { id: ID! }
      type OrderList { nodes: [Order!]! totalCount: Int! }
      type Query { orders(limit: Int, offset: Int, status: String): OrderList! }
    `);
    const orders = table(catalog, 'orders');
    expect(orders.pagination.style).toBe('offset');
    expect(orders.pagination.limitArg).toBe('limit');
    expect(orders.pagination.offsetArg).toBe('offset');
    expect(orders.pagination.nodesPath).toEqual(['nodes']);
  });

  it('recognises skip/take offset pagination', () => {
    const catalog = catalogFrom(`
      type Row { id: ID! }
      type Query { rows(take: Int, skip: Int): [Row!]! }
    `);
    const rows = table(catalog, 'rows');
    expect(rows.pagination.style).toBe('offset');
    expect(rows.pagination.limitArg).toBe('take');
    expect(rows.pagination.offsetArg).toBe('skip');
    expect(rows.pagination.nodesPath).toEqual([]);
  });

  it('recognises page/perPage pagination', () => {
    const catalog = catalogFrom(`
      type Product { id: ID! }
      type ProductPage { items: [Product!]! totalCount: Int! }
      type Query { products(page: Int, perPage: Int): ProductPage! }
    `);
    const products = table(catalog, 'products');
    expect(products.pagination.style).toBe('page');
    expect(products.pagination.pageArg).toBe('page');
    expect(products.pagination.perPageArg).toBe('perPage');
  });

  it('falls back to a single unpaginated page and says so', () => {
    const catalog = catalogFrom(`
      type Row { id: ID! }
      type Query { rows: [Row!]! }
    `);
    expect(table(catalog, 'rows').pagination.style).toBe('none');
    expect(catalog.warnings.some((w) => w.includes('rows') && w.includes('no pagination'))).toBe(true);
  });

  it('warns when pageInfo exists but no cursor argument does', () => {
    const catalog = catalogFrom(`
      type PageInfo { hasNextPage: Boolean! endCursor: String }
      type Row { id: ID! }
      type RowList { nodes: [Row!]! pageInfo: PageInfo! }
      type Query { rows(first: Int): RowList! }
    `);
    expect(table(catalog, 'rows').pagination.style).toBe('none');
    expect(catalog.warnings.some((w) => w.includes('no cursor argument'))).toBe(true);
  });

  it('treats a single object as a one-row table', () => {
    const catalog = catalogFrom(`
      type User { id: ID! name: String! }
      type Query { me: User }
    `);
    const me = table(catalog, 'me');
    expect(me.pagination.style).toBe('none');
    expect(me.pagination.nodesPath).toEqual([]);
    expect(columnNames(me)).toEqual(['id', 'name']);
  });

  it('treats a scalar root field as a one-column table', () => {
    const catalog = catalogFrom('type Query { version: String! }');
    const version = table(catalog, 'version');
    expect(columnNames(version)).toEqual(['version']);
    expect(column(version, 'version').duckType).toBe('VARCHAR');
  });

  it('uses the only list field when the wrapper is unconventionally named', () => {
    const catalog = catalogFrom(`
      type Thing { id: ID! }
      type Bag { payload: [Thing!]! generatedAt: String! }
      type Query { bag(limit: Int, offset: Int): Bag! }
    `);
    expect(table(catalog, 'bag').pagination.nodesPath).toEqual(['payload']);
  });
});

describe('column flattening', () => {
  const catalog = catalogFrom(`
    scalar DateTime
    scalar Money
    scalar Weird
    enum Role { ADMIN GUEST }
    type Address { city: String! geo: Geo postcode: String }
    type Geo { lat: Float! lng: Float! }
    type Tag { id: ID! label: String! }
    type User {
      id: ID!
      role: Role!
      createdAt: DateTime!
      balance: Money!
      odd: Weird
      scores: [Int!]!
      matrix: [[Float!]!]
      address: Address
      tags: [Tag!]!
      manager: User
      secret: String
      legacy: String @deprecated(reason: "gone")
      needsArg(which: ID!): String
    }
    type Query { users(limit: Int, offset: Int): [User!]! }
  `);
  const users = table(catalog, 'users');

  it('flattens nested objects with underscore-joined paths', () => {
    expect(columnNames(users)).toContain('address_city');
    expect(columnNames(users)).toContain('address_geo_lat');
    expect(column(users, 'address_city').path).toEqual(['address', 'city']);
    expect(column(users, 'address_geo_lat').duckType).toBe('DOUBLE');
  });

  it('keeps nullability from the GraphQL type', () => {
    expect(column(users, 'id').nullable).toBe(false);
    expect(column(users, 'secret').nullable).toBe(true);
    // A non-null field inside a nullable parent is still reported as the schema declares it.
    expect(column(users, 'address_city').nullable).toBe(false);
  });

  it('maps built-in and custom scalars, and enums as text', () => {
    expect(column(users, 'id').duckType).toBe('VARCHAR');
    expect(column(users, 'role').duckType).toBe('VARCHAR');
    expect(column(users, 'role').enumValues).toEqual(['ADMIN', 'GUEST']);
    expect(column(users, 'createdAt').duckType).toBe('TIMESTAMP');
    expect(column(users, 'balance').duckType).toBe('DECIMAL(38,9)');
  });

  it('reads an unfamiliar custom scalar as text and warns about it', () => {
    expect(column(users, 'odd').duckType).toBe('VARCHAR');
    expect(catalog.warnings.some((w) => w.includes('Weird'))).toBe(true);
  });

  it('keeps scalar lists as DuckDB LIST columns, including nested lists', () => {
    expect(column(users, 'scores').duckType).toBe('BIGINT[]');
    expect(column(users, 'scores').isList).toBe(true);
    expect(column(users, 'matrix').duckType).toBe('DOUBLE[][]');
  });

  it('turns a list of objects into a child table and leaves a count on the parent', () => {
    expect(users.childTables).toEqual(['users__tags']);
    expect(column(users, 'tags_count').duckType).toBe('BIGINT');
    expect(column(users, 'tags_count').synthetic).toBe(true);

    const tags = table(catalog, 'users__tags');
    expect(tags.isChild).toBe(true);
    expect(tags.parent).toBe('users');
    expect(tags.parentPath).toEqual(['tags']);
    expect(tags.parentKeyColumn).toBe('_parent_rowid');
    expect(tags.parentRefColumn).toBe('_rowid');
    expect(columnNames(tags)).toEqual(['id', 'label']);
    // The parent's primary key is copied across for readable joins.
    expect(tags.columns.map((c) => c.name)).toContain('_parent_id');
  });

  it('carries descriptions and deprecations through to columns', () => {
    expect(column(users, 'legacy').deprecationReason).toBe('gone');
  });

  it('skips fields that require arguments, and says why', () => {
    expect(columnNames(users)).not.toContain('needsArg');
    expect(catalog.warnings.some((w) => w.includes('needsArg') && w.includes('which'))).toBe(true);
  });

  it('adds _rowid and _raw to every table', () => {
    expect(users.columns.map((c) => c.name)).toContain('_rowid');
    expect(users.columns.map((c) => c.name)).toContain('_raw');
    expect(column(users, '_raw').duckType).toBe('JSON');
  });

  it('detects the primary key', () => {
    expect(users.primaryKey).toBe('id');
  });
});

describe('recursion limits', () => {
  const sdl = `
    type Node1 { id: ID! child: Node2 }
    type Node2 { id: ID! child: Node3 }
    type Node3 { id: ID! child: Node4 }
    type Node4 { id: ID! deep: String }
    type Query { roots(limit: Int, offset: Int): [Node1!]! }
  `;

  it('stops at maxDepth and reports where', () => {
    const shallow = catalogFrom(sdl, { maxDepth: 2 });
    const roots = table(shallow, 'roots');
    expect(columnNames(roots)).toEqual(['id', 'child_id']);
    expect(shallow.warnings.some((w) => w.includes('depth limit 2'))).toBe(true);
  });

  it('goes deeper when maxDepth allows', () => {
    const deep = catalogFrom(sdl, { maxDepth: 4 });
    expect(columnNames(table(deep, 'roots'))).toEqual([
      'id',
      'child_id',
      'child_child_id',
      'child_child_child_id',
      'child_child_child_deep',
    ]);
  });

  it('stops on a cycle rather than recursing forever', () => {
    const catalog = catalogFrom(`
      type User { id: ID! manager: User friend: Friend }
      type Friend { id: ID! of: User }
      type Query { users(limit: Int, offset: Int): [User!]! }
    `, { maxDepth: 8 });
    const users = table(catalog, 'users');
    expect(columnNames(users)).toEqual(['id', 'friend_id']);
    expect(catalog.warnings.some((w) => w.includes('cycle'))).toBe(true);
  });
});

describe('interfaces and unions', () => {
  it('exposes interface fields plus __typename', () => {
    const catalog = catalogFrom(`
      interface Node { id: ID! createdAt: String! }
      type User implements Node { id: ID! createdAt: String! name: String! }
      type Query { nodes(limit: Int, offset: Int): [Node!]! }
    `);
    const nodes = table(catalog, 'nodes');
    expect(columnNames(nodes)).toEqual(['__typename', 'id', 'createdAt']);
    expect(columnNames(nodes)).not.toContain('name');
  });

  it('gives a union only __typename, and explains the limitation', () => {
    const catalog = catalogFrom(`
      type User { id: ID! }
      type Product { id: ID! sku: String! }
      union Hit = User | Product
      type Query { search(term: String!, limit: Int, offset: Int): [Hit!]! }
    `);
    const search = table(catalog, 'search');
    expect(columnNames(search)).toEqual(['__typename']);
    expect(search.columns.map((c) => c.name)).toContain('_raw');
    expect(catalog.warnings.some((w) => w.includes('union') && w.includes('_raw'))).toBe(true);
  });
});

describe('argument surface', () => {
  const catalog = catalogFrom(`
    enum Direction { ASC DESC }
    input StringCompare { _eq: String _in: [String!] }
    input Sort { field: String! direction: Direction! = ASC }
    input Where { name: StringCompare tags: [String!] }
    type Row { id: ID! }
    type Query { rows(where: Where, sort: [Sort!], limit: Int = 25, needed: ID!): [Row!]! }
  `);
  const rows = table(catalog, 'rows');
  const arg = (name: string) => {
    const found = rows.args.find((a) => a.name === name);
    if (!found) throw new Error(`no arg ${name}`);
    return found;
  };

  it('captures scalar, enum, list and input arguments', () => {
    expect(rows.args.map((a) => a.name)).toEqual(['where', 'sort', 'limit', 'needed']);
    expect(arg('limit').kind).toBe('scalar');
    expect(arg('sort').kind).toBe('list');
    expect(arg('where').kind).toBe('input');
  });

  it('marks required arguments, accounting for defaults', () => {
    expect(arg('needed').required).toBe(true);
    expect(arg('limit').required).toBe(false);
    expect(arg('where').required).toBe(false);
  });

  it('recurses input objects two levels, which is what nested filter pushdown needs', () => {
    const where = arg('where');
    expect(where.inputFields?.map((f) => f.name)).toEqual(['name', 'tags']);
    const name = where.inputFields?.find((f) => f.name === 'name');
    expect(name?.inputFields?.map((f) => f.name)).toEqual(['_eq', '_in']);
  });

  it('records enum values on arguments so the editor can complete them', () => {
    const direction = arg('sort').inputFields?.find((f) => f.name === 'direction');
    expect(direction?.enumValues).toEqual(['ASC', 'DESC']);
  });
});

describe('catalog metadata', () => {
  it('is stable for the same schema and changes when the schema changes', () => {
    const a = catalogFrom('type Query { a: String }');
    const b = catalogFrom('type Query { a: String }');
    const c = catalogFrom('type Query { a: String b: Int }');
    expect(a.schemaHash).toBe(b.schemaHash);
    expect(a.schemaHash).not.toBe(c.schemaHash);
  });

  it('lists mutations for the browser without making them queryable', () => {
    const catalog = catalogFrom(`
      type Row { id: ID! }
      type Query { rows: [Row!]! }
      type Mutation { deleteRow(id: ID!): Boolean! addRow: Row }
    `);
    expect(catalog.mutationNames).toEqual(['addRow', 'deleteRow']);
    expect(catalog.tables.map((t) => t.name)).not.toContain('deleteRow');
  });

  it('collects enums and type summaries for the schema browser', () => {
    const catalog = catalogFrom(`
      "A role."
      enum Role { ADMIN GUEST }
      type User { id: ID! role: Role! }
      type Query { users: [User!]! }
    `);
    expect(catalog.enums.map((e) => e.name)).toEqual(['Role']);
    expect(catalog.enums[0]?.description).toBe('A role.');
    expect(catalog.enums[0]?.values.map((v) => v.name)).toEqual(['ADMIN', 'GUEST']);
    const user = catalog.types.find((t) => t.name === 'User');
    expect(user?.kind).toBe('OBJECT');
    expect(user?.fields?.map((f) => f.name)).toEqual(['id', 'role']);
    expect(catalog.types.some((t) => t.name.startsWith('__'))).toBe(false);
  });

  it('resolves column name collisions instead of dropping columns', () => {
    const catalog = catalogFrom(`
      type Inner { city: String! }
      type Row { address_city: String! address: Inner }
      type Query { rows: [Row!]! }
    `);
    const rows = table(catalog, 'rows');
    expect(columnNames(rows)).toEqual(['address_city', 'address_city_2']);
  });
});

describe('scalar type overrides', () => {
  it('lets a connection override any scalar mapping', () => {
    const catalog = catalogFrom(`
      scalar Money
      type Row { price: Money! }
      type Query { rows: [Row!]! }
    `, { scalarTypeMap: { Money: 'DOUBLE' } });
    expect(column(table(catalog, 'rows'), 'price').duckType).toBe('DOUBLE');
  });

  it('maps common custom scalar names without configuration', () => {
    expect(mapScalar('DateTime').duckType).toBe('TIMESTAMP');
    expect(mapScalar('Date').duckType).toBe('DATE');
    expect(mapScalar('UUID').duckType).toBe('UUID');
    expect(mapScalar('JSON').duckType).toBe('JSON');
    expect(mapScalar('BigInt').duckType).toBe('BIGINT');
    expect(mapScalar('EmailAddress').duckType).toBe('VARCHAR');
    expect(mapScalar('Int').duckType).toBe('BIGINT');
    expect(mapScalar('Float').duckType).toBe('DOUBLE');
    expect(mapScalar('Totally_Unknown').guessed).toBe(true);
  });
});
