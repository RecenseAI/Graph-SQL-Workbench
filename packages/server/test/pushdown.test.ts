import { describe, expect, it } from 'vitest';
import { buildSchema } from 'graphql';
import { connectionSchema, type CatalogTable, type ConnectionConfig } from '@gqlwb/shared';
import { buildCatalog } from '../src/catalog/build.ts';
import { computePushdown, mergeArgs } from '../src/plan/pushdown.ts';
import type { ExtractedPredicate } from '../src/sql/analyze.ts';

/**
 * A schema offering the same filters three different ways, so one set of predicates can be
 * pushed through each profile and compared.
 */
const SDL = `
  enum Status { PENDING PAID SHIPPED }
  input StringCompare { _eq: String _neq: String _in: [String!] _like: String _is_null: Boolean }
  input NumberCompare { _eq: Float _gt: Float _gte: Float _lt: Float _lte: Float }
  input OrderWhere { status: StringCompare channel: StringCompare total: NumberCompare }
  type Address { city: String! }
  type Item { sku: String! }
  type Order {
    id: ID!
    status: Status!
    channel: String!
    total: Float!
    paid: Boolean!
    tags: [String!]!
    address: Address
    items: [Item!]!
  }
  type Query {
    "Exact argument names, which the auto profile targets."
    ordersAuto(status: Status, channel: String, paid: Boolean, channels: [String!], limit: Int, offset: Int): [Order!]!
    "Hasura-shaped nested filter."
    ordersNested(where: OrderWhere, limit: Int, offset: Int): [Order!]!
    "Operator suffixed onto the argument name."
    ordersFlat(status_eq: String, total_gt: Float, channel_like: String, limit: Int, offset: Int): [Order!]!
  }
`;

const catalog = buildCatalog(buildSchema(SDL), {
  connectionId: 'c',
  endpoint: 'http://example.test/graphql',
  maxDepth: 3,
  pageSize: 100,
});

const table = (name: string): CatalogTable => {
  const found = catalog.tables.find((t) => t.name === name);
  if (!found) throw new Error(`no table ${name}`);
  return found;
};

const connection = (profile: ConnectionConfig['pushdownProfile']): ConnectionConfig => {
  const now = new Date().toISOString();
  return connectionSchema.parse({
    id: 'c',
    name: 'test',
    endpoint: 'http://example.test/graphql',
    pushdownProfile: profile,
    createdAt: now,
    updatedAt: now,
  });
};

const push = (
  tableName: string,
  profile: ConnectionConfig['pushdownProfile'],
  predicates: ExtractedPredicate[],
  explicitArgs: Record<string, unknown> = {},
) =>
  computePushdown({
    table: table(tableName),
    predicates,
    connection: connection(profile),
    explicitArgs,
    enabled: true,
  });

describe('the auto profile', () => {
  it('pushes equality onto an argument with the same name', () => {
    const out = push('ordersAuto', 'auto', [{ column: 'channel', op: 'eq', value: 'web' }]);
    expect(out.args).toEqual({ channel: 'web' });
    expect(out.pushed).toEqual([
      { column: 'channel', op: 'eq', value: 'web', arg: 'channel', via: 'exact argument name' },
    ]);
    expect(out.skipped).toEqual([]);
  });

  it('pushes an enum value the schema actually declares', () => {
    const out = push('ordersAuto', 'auto', [{ column: 'status', op: 'eq', value: 'PAID' }]);
    expect(out.args).toEqual({ status: 'PAID' });
  });

  it('refuses an enum value the schema does not declare, which would fail the whole query', () => {
    const out = push('ordersAuto', 'auto', [{ column: 'status', op: 'eq', value: 'NOT_A_STATUS' }]);
    expect(out.args).toEqual({});
    expect(out.skipped[0]?.reason).toMatch(/does not match the type/);
  });

  it('refuses inequality, because an argument named after a column means equality', () => {
    const out = push('ordersAuto', 'auto', [{ column: 'total', op: 'gt', value: 100 }]);
    expect(out.args).toEqual({});
    expect(out.skipped[0]?.reason).toMatch(/only pushes equality/);
  });

  it('pushes IN only when the argument is a list', () => {
    expect(push('ordersAuto', 'auto', [{ column: 'channel', op: 'in', value: ['web', 'ios'] }]).args).toEqual({});
    // `channels` is the list-typed argument, but it does not match the column name, so nothing is
    // pushed -- the auto profile never guesses at pluralisation.
    const out = push('ordersAuto', 'auto', [{ column: 'channels', op: 'in', value: ['web'] }]);
    expect(out.skipped[0]?.reason).toMatch(/No column named channels/);
  });

  it('checks the literal type against the argument', () => {
    const out = push('ordersAuto', 'auto', [{ column: 'paid', op: 'eq', value: 'yes' }]);
    expect(out.args).toEqual({});
    expect(out.skipped[0]?.reason).toMatch(/does not match the type/);
  });

  it('pushes a boolean', () => {
    expect(push('ordersAuto', 'auto', [{ column: 'paid', op: 'eq', value: true }]).args).toEqual({ paid: true });
  });

  it('skips a column with no matching argument, and says so', () => {
    const out = push('ordersAuto', 'auto', [{ column: 'id', op: 'eq', value: 'o-1' }]);
    expect(out.args).toEqual({});
    expect(out.skipped[0]?.reason).toMatch(/no argument named id/);
  });
});

describe('the nested (Hasura) profile', () => {
  it('builds the nested filter object the schema declares', () => {
    const out = push('ordersNested', 'hasura', [
      { column: 'status', op: 'eq', value: 'PAID' },
      { column: 'total', op: 'gt', value: 100 },
      { column: 'total', op: 'lte', value: 900 },
    ]);
    expect(out.args).toEqual({ where: { status: { _eq: 'PAID' }, total: { _gt: 100, _lte: 900 } } });
    expect(out.pushed.map((p) => p.arg)).toEqual(['where.status._eq', 'where.total._gt', 'where.total._lte']);
    expect(out.pushed[0]?.via).toBe('hasura profile');
  });

  it('pushes IN and LIKE when the schema has those operators', () => {
    const out = push('ordersNested', 'hasura', [
      { column: 'channel', op: 'in', value: ['web', 'ios'] },
      { column: 'channel', op: 'like', value: 'we%' },
    ]);
    expect(out.args).toEqual({ where: { channel: { _in: ['web', 'ios'], _like: 'we%' } } });
  });

  it('skips an operator the schema does not offer rather than inventing a field', () => {
    // NumberCompare has no _neq, so a not-equals on total has nowhere to go.
    const out = push('ordersNested', 'hasura', [{ column: 'total', op: 'ne', value: 5 }]);
    expect(out.args).toEqual({});
    expect(out.skipped[0]?.reason).toMatch(/no where\.total\._neq argument/);
  });

  it('skips a column the filter input does not mention', () => {
    const out = push('ordersNested', 'hasura', [{ column: 'paid', op: 'eq', value: true }]);
    expect(out.args).toEqual({});
    expect(out.skipped[0]?.reason).toMatch(/no where\.paid\._eq argument/);
  });

  it('maps IS NULL onto the schema-declared null operator', () => {
    const out = push('ordersNested', 'hasura', [{ column: 'status', op: 'isNull', value: true }]);
    expect(out.args).toEqual({ where: { status: { _is_null: true } } });
  });
});

describe('the flat profile', () => {
  it('pushes onto argument names that carry the operator as a suffix', () => {
    const out = push('ordersFlat', 'flat', [
      { column: 'status', op: 'eq', value: 'PAID' },
      { column: 'total', op: 'gt', value: 100 },
      { column: 'channel', op: 'like', value: 'we%' },
    ]);
    expect(out.args).toEqual({ status_eq: 'PAID', total_gt: 100, channel_like: 'we%' });
  });

  it('skips a suffix the schema does not define', () => {
    const out = push('ordersFlat', 'flat', [{ column: 'total', op: 'lt', value: 10 }]);
    expect(out.args).toEqual({});
    expect(out.skipped[0]?.reason).toMatch(/total_lt/);
  });
});

describe('what is never pushed', () => {
  it('nothing, when the profile is none', () => {
    const out = push('ordersNested', 'none', [{ column: 'status', op: 'eq', value: 'PAID' }]);
    expect(out.args).toEqual({});
    expect(out.skipped[0]?.reason).toMatch(/set to none/);
  });

  it('nothing, when pushdown is switched off for the run', () => {
    const out = computePushdown({
      table: table('ordersNested'),
      predicates: [{ column: 'status', op: 'eq', value: 'PAID' }],
      connection: connection('hasura'),
      explicitArgs: {},
      enabled: false,
    });
    expect(out.args).toEqual({});
    expect(out.skipped[0]?.reason).toMatch(/switched off/);
  });

  it('a workbench column the endpoint knows nothing about', () => {
    const out = push('ordersAuto', 'auto', [{ column: '_rowid', op: 'eq', value: 1 }]);
    expect(out.skipped[0]?.reason).toMatch(/added by the workbench/);
  });

  it('a list column', () => {
    const out = push('ordersAuto', 'auto', [{ column: 'tags', op: 'eq', value: 'vip' }]);
    expect(out.skipped[0]?.reason).toMatch(/is a list/);
  });

  it('a nested column, which no argument can address', () => {
    const out = push('ordersNested', 'hasura', [{ column: 'address_city', op: 'eq', value: 'Austin' }]);
    expect(out.args).toEqual({});
    expect(out.skipped[0]?.reason).toMatch(/nested field \(address\.city\)/);
  });

  it('anything that would overwrite an argument the user wrote by hand', () => {
    const out = push('ordersAuto', 'auto', [{ column: 'channel', op: 'eq', value: 'web' }], { channel: 'ios' });
    expect(out.args).toEqual({});
    expect(out.skipped[0]?.reason).toMatch(/already set channel explicitly/);
  });

  it('anything that would overwrite a hand-written nested filter field', () => {
    const out = push('ordersNested', 'hasura', [{ column: 'status', op: 'eq', value: 'PAID' }], {
      where: { status: { _eq: 'SHIPPED' } },
    });
    expect(out.args).toEqual({});
    expect(out.skipped[0]?.reason).toMatch(/already set where\.status\._eq/);
  });

  it('a second predicate targeting an argument another predicate already filled', () => {
    const out = push('ordersAuto', 'auto', [
      { column: 'channel', op: 'eq', value: 'web' },
      { column: 'channel', op: 'eq', value: 'ios' },
    ]);
    expect(out.args).toEqual({ channel: 'web' });
    expect(out.skipped[0]?.reason).toMatch(/Another predicate already filled/);
  });
});

describe('argument merging', () => {
  it('keeps the user\'s values and deep-merges the rest', () => {
    const merged = mergeArgs(
      { where: { status: { _eq: 'PAID' } }, limit: 10 },
      { where: { status: { _eq: 'SHIPPED' }, total: { _gt: 5 } }, offset: 20 },
    );
    expect(merged).toEqual({
      where: { status: { _eq: 'PAID' }, total: { _gt: 5 } },
      limit: 10,
      offset: 20,
    });
  });

  it('does not merge into an array', () => {
    expect(mergeArgs({ tags: ['a'] }, { tags: ['b'] })).toEqual({ tags: ['a'] });
  });
});
