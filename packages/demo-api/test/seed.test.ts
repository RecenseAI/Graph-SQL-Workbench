import { describe, expect, it } from 'vitest';
import { graphql } from 'graphql';
import { buildDemoSchema, rootValue } from '../src/schema.ts';
import { dataset, datasetSummary } from '../src/seed.ts';
import { nullProfile, orderTotals, revenueByCountry, unitsByCategory } from '../src/expected.ts';

const schema = buildDemoSchema();

async function run(source: string, variableValues?: Record<string, unknown>) {
  const result = await graphql({ schema, source, rootValue, variableValues });
  expect(result.errors, JSON.stringify(result.errors)).toBeUndefined();
  return result.data as Record<string, any>;
}

describe('demo dataset', () => {
  it('is deterministic, so end-to-end aggregates are reproducible', () => {
    expect(datasetSummary).toEqual({ users: 800, orders: 4000, products: 300, orderItems: 10048 });
    expect(dataset.users[0]?.id).toBe('u-0001');
    expect(dataset.users[0]?.name).toBe('Tomas Haddad');
    expect(dataset.orders[0]?.id).toBe('o-00001');

    const paid = orderTotals('PAID');
    expect(paid.count).toBe(1486);
    expect(paid.sum).toBe(13521254.94);
    expect(paid.max).toBe(33653.7);
  });

  it('keeps every nullable shape the shredder has to survive', () => {
    for (const [shape, count] of Object.entries(nullProfile)) {
      expect(count, shape + ' should appear in the seed').toBeGreaterThan(0);
    }
  });

  it('exposes joinable aggregates that no single GraphQL query could return', () => {
    const byCountry = revenueByCountry('PAID');
    expect(byCountry).toHaveLength(10);
    expect(byCountry[0]).toEqual({ country: 'GB', orders: 175, revenue: 1544540.3, biggest: 31013.25 });

    const byCategory = unitsByCategory();
    expect(byCategory).toHaveLength(6);
    expect(byCategory.reduce((s, r) => s + r.units, 0)).toBeGreaterThan(20_000);
  });
});

describe('pagination styles', () => {
  it('walks a Relay connection with cursors', async () => {
    const first = await run('{ users(first: 3) { totalCount pageInfo { hasNextPage endCursor } edges { node { id } } } }');
    expect(first.users.totalCount).toBe(800);
    expect(first.users.pageInfo.hasNextPage).toBe(true);
    expect(first.users.edges.map((e: any) => e.node.id)).toEqual(['u-0001', 'u-0002', 'u-0003']);

    const next = await run('query ($after: String) { users(first: 3, after: $after) { edges { node { id } } } }', {
      after: first.users.pageInfo.endCursor,
    });
    expect(next.users.edges.map((e: any) => e.node.id)).toEqual(['u-0004', 'u-0005', 'u-0006']);
  });

  it('reports the end of a Relay connection', async () => {
    const last = await run('{ users(first: 5, after: "aWR4Ojc5NA==") { pageInfo { hasNextPage } edges { node { id } } } }');
    expect(last.users.edges).toHaveLength(5);
    expect(last.users.pageInfo.hasNextPage).toBe(false);
  });

  it('pages an offset list and reports a total', async () => {
    const page = await run('{ orders(limit: 2, offset: 4, status: PAID) { totalCount nodes { id status } } }');
    expect(page.orders.totalCount).toBe(1486);
    expect(page.orders.nodes).toHaveLength(2);
    expect(page.orders.nodes.every((o: any) => o.status === 'PAID')).toBe(true);
  });

  it('pages a page/perPage list', async () => {
    const page = await run('{ productsPaged(page: 3, perPage: 10) { page totalPages totalCount items { id } } }');
    expect(page.productsPaged.totalCount).toBe(300);
    expect(page.productsPaged.totalPages).toBe(30);
    expect(page.productsPaged.items[0].id).toBe('p-0021');
  });

  it('caps page size so a runaway first: cannot exhaust the server', async () => {
    const huge = await run('{ users(first: 100000) { edges { node { id } } } }');
    expect(huge.users.edges).toHaveLength(500);
  });
});

describe('filter arguments', () => {
  it('filters by exact argument name, the target of the auto pushdown profile', async () => {
    const data = await run('{ users(first: 500, country: "DE", active: true) { totalCount edges { node { country active } } } }');
    expect(data.users.totalCount).toBe(65);
    expect(data.users.edges.every((e: any) => e.node.country === 'DE' && e.node.active === true)).toBe(true);
  });

  it('filters through a Hasura-shaped nested where object', async () => {
    const data = await run(
      '{ products(where: {category: {_eq: "Laptops"}, price: {_gt: 1000, _lte: 2000}}, limit: 300) { category price } }',
    );
    expect(data.products.length).toBeGreaterThan(0);
    expect(data.products.every((p: any) => p.category === 'Laptops' && p.price > 1000 && p.price <= 2000)).toBe(true);
  });

  it('supports _in, _like and sorting', async () => {
    const data = await run(
      '{ products(where: {category: {_in: ["Audio", "Cameras"]}, title: {_like: "Audio%"}}, orderBy: [{field: PRICE, direction: DESC}], limit: 5) { category title price } }',
    );
    expect(data.products.every((p: any) => p.category === 'Audio')).toBe(true);
    const prices = data.products.map((p: any) => p.price);
    expect([...prices].sort((a: number, b: number) => b - a)).toEqual(prices);
  });
});

describe('shapes the catalog builder has to classify', () => {
  it('serves a union with __typename', async () => {
    const data = await run('{ search(term: "ada", limit: 5) { __typename ... on User { id } ... on Product { id } } }');
    expect(data.search.length).toBeGreaterThan(0);
  });

  it('serves an interface', async () => {
    const data = await run('{ node(id: "u-0001") { __typename id } }');
    expect(data.node).toEqual({ __typename: 'User', id: 'u-0001' });
  });

  it('serves a self-referential field so cycle detection has a target', async () => {
    const withManager = dataset.users.find((u) => u.managerId !== null);
    const data = await run('{ node(id: "' + withManager?.id + '") { ... on User { id manager { id manager { id } } } } }');
    expect(data.node.manager?.id).toBe(withManager?.managerId);
  });

  it('serves a scalars-only field', async () => {
    const data = await run('{ serverInfo { name version seed { users orders } } }');
    expect(data.serverInfo.name).toBe('graphql-workbench-demo');
    expect(data.serverInfo.seed.users).toBe(800);
  });

  it('exposes order items as a list of objects, the source of a child table', async () => {
    const data = await run('{ orders(limit: 3) { nodes { id items { sku qty unitPrice } } } }');
    expect(data.orders.nodes.every((o: any) => Array.isArray(o.items) && o.items.length > 0)).toBe(true);
  });
});
