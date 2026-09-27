import {
  buildSchema,
  GraphQLObjectType,
  GraphQLInterfaceType,
  GraphQLUnionType,
  type GraphQLSchema,
  type GraphQLFieldResolver,
} from 'graphql';
import { dataset, datasetSummary, type Order, type Product, type User } from './seed.ts';

/**
 * The schema deliberately mixes every shape the workbench catalog has to cope with:
 * a Relay connection, a nodes+totalCount list with limit/offset, a bare list with a
 * Hasura-style nested filter, a page/perPage list, a single object, a scalars-only field,
 * an interface, a union, a self-referential type, a deprecated field, nullable nested
 * objects, a scalar list and a list of objects.
 */
export const SDL = `
"An ISO-8601 timestamp."
scalar DateTime
"A decimal amount. Serialised as a JSON number."
scalar Money

"Anything with a global id."
interface Node {
  id: ID!
}

enum Role { ADMIN CUSTOMER GUEST }
enum OrderStatus { PENDING PAID SHIPPED CANCELLED REFUNDED }
enum SortDirection { ASC DESC }
enum ProductSortField { PRICE STOCK RATING TITLE }

type Address {
  line1: String!
  city: String!
  country: String!
  postcode: String
}

type User implements Node {
  id: ID!
  email: String!
  name: String!
  role: Role!
  "Denormalised onto the user so grouping does not need the address."
  country: String!
  signedUpAt: DateTime!
  lifetimeValue: Money!
  active: Boolean!
  "Nullable nested object, flattened into columns by the workbench."
  address: Address
  "A list of scalars, which becomes a DuckDB LIST column."
  tags: [String!]!
  legacyName: String @deprecated(reason: "Use name instead.")
  "Self-referential, so catalog depth and cycle limits get exercised."
  manager: User
}

type OrderItem {
  sku: String!
  productId: ID!
  qty: Int!
  unitPrice: Money!
}

type Order implements Node {
  id: ID!
  "The join key. Note there is no 'user' field: the relation is deliberately unmodelled."
  userId: ID!
  status: OrderStatus!
  total: Money!
  placedAt: DateTime!
  currency: String!
  channel: String!
  "A list of objects, which becomes a child table."
  items: [OrderItem!]!
}

type Product implements Node {
  id: ID!
  sku: String!
  title: String!
  category: String!
  price: Money!
  stock: Int!
  rating: Float
}

type PageInfo {
  hasNextPage: Boolean!
  hasPreviousPage: Boolean!
  startCursor: String
  endCursor: String
}

type UserEdge {
  cursor: String!
  node: User!
}

"A textbook Relay cursor connection."
type UserConnection {
  edges: [UserEdge!]!
  pageInfo: PageInfo!
  totalCount: Int!
}

"nodes + totalCount with limit/offset -- common, and not Relay."
type OrderList {
  nodes: [Order!]!
  totalCount: Int!
}

"Classic page/perPage pagination."
type ProductPage {
  items: [Product!]!
  page: Int!
  perPage: Int!
  totalPages: Int!
  totalCount: Int!
}

input StringCompare {
  _eq: String
  _neq: String
  _in: [String!]
  _like: String
}

input NumberCompare {
  _eq: Float
  _gt: Float
  _gte: Float
  _lt: Float
  _lte: Float
}

input IntCompare {
  _eq: Int
  _gt: Int
  _gte: Int
  _lt: Int
  _lte: Int
}

"Hasura-shaped filter, so the nested pushdown profile has a real target."
input ProductFilter {
  category: StringCompare
  title: StringCompare
  sku: StringCompare
  price: NumberCompare
  stock: IntCompare
}

input ProductSort {
  field: ProductSortField!
  direction: SortDirection! = ASC
}

union SearchResult = User | Order | Product

type SeedSummary {
  users: Int!
  orders: Int!
  products: Int!
  orderItems: Int!
}

type ServerInfo {
  name: String!
  version: String!
  "Wall-clock time, so caching behaviour is observable."
  now: DateTime!
  seed: SeedSummary!
}

type Query {
  "Relay connection. Filter arguments match column names exactly, for the 'auto' pushdown profile."
  users(first: Int, after: String, last: Int, before: String, role: Role, country: String, active: Boolean): UserConnection!
  "Offset pagination with a total count."
  orders(limit: Int = 50, offset: Int = 0, status: OrderStatus, userId: ID, channel: String, placedAfter: DateTime): OrderList!
  "A bare list with a nested filter object."
  products(where: ProductFilter, orderBy: [ProductSort!], limit: Int = 100, offset: Int = 0): [Product!]!
  "page/perPage pagination."
  productsPaged(page: Int = 1, perPage: Int = 50, category: String): ProductPage!
  "A single object rather than a list."
  me: User
  "Scalars only."
  serverInfo: ServerInfo!
  "A union, which the catalog can only partly flatten."
  search(term: String!, limit: Int = 20): [SearchResult!]!
  node(id: ID!): Node
}

type Mutation {
  "Present so the workbench can prove it refuses to run mutations from SQL."
  cancelOrder(id: ID!): Order
  touch: Boolean!
}
`;

const encodeCursor = (index: number): string => Buffer.from(`idx:${index}`, 'utf8').toString('base64');
const decodeCursor = (cursor: string): number => {
  const raw = Buffer.from(cursor, 'base64').toString('utf8');
  const match = /^idx:(\d+)$/.exec(raw);
  if (!match) throw new Error(`Malformed cursor: ${cursor}`);
  return Number(match[1]);
};

interface StringCompare {
  _eq?: string | null;
  _neq?: string | null;
  _in?: string[] | null;
  _like?: string | null;
}
interface NumberCompare {
  _eq?: number | null;
  _gt?: number | null;
  _gte?: number | null;
  _lt?: number | null;
  _lte?: number | null;
}

function matchString(value: string, cmp: StringCompare | null | undefined): boolean {
  if (!cmp) return true;
  if (cmp._eq != null && value !== cmp._eq) return false;
  if (cmp._neq != null && value === cmp._neq) return false;
  if (cmp._in != null && !cmp._in.includes(value)) return false;
  if (cmp._like != null) {
    // SQL LIKE semantics: % is any run, _ is one character.
    const pattern = cmp._like.replace(/[.*+?^${}()|[\]]/g, (c) => '\\' + c).replace(/%/g, '.*').replace(/_/g, '.');
    if (!new RegExp(`^${pattern}$`, 'i').test(value)) return false;
  }
  return true;
}

function matchNumber(value: number, cmp: NumberCompare | null | undefined): boolean {
  if (!cmp) return true;
  if (cmp._eq != null && value !== cmp._eq) return false;
  if (cmp._gt != null && !(value > cmp._gt)) return false;
  if (cmp._gte != null && !(value >= cmp._gte)) return false;
  if (cmp._lt != null && !(value < cmp._lt)) return false;
  if (cmp._lte != null && !(value <= cmp._lte)) return false;
  return true;
}

export interface DemoContext {
  /** Counts GraphQL operations so tests can assert how many round trips a SQL statement cost. */
  requestLog: { document: string; at: number }[];
}

const MAX_PAGE = 500;

interface UsersArgs {
  first?: number | null;
  after?: string | null;
  last?: number | null;
  before?: string | null;
  role?: string | null;
  country?: string | null;
  active?: boolean | null;
}

export const rootValue = {
  users: (args: UsersArgs) => {
    let rows: User[] = dataset.users;
    if (args.role != null) rows = rows.filter((u) => u.role === args.role);
    if (args.country != null) rows = rows.filter((u) => u.country === args.country);
    if (args.active != null) rows = rows.filter((u) => u.active === args.active);

    let start = 0;
    let end = rows.length;
    if (args.after != null) start = decodeCursor(args.after) + 1;
    if (args.before != null) end = decodeCursor(args.before);
    let window = rows.slice(start, end);
    const first = args.first ?? null;
    const last = args.last ?? null;
    if (first != null) window = window.slice(0, Math.min(first, MAX_PAGE));
    if (last != null) window = window.slice(Math.max(0, window.length - Math.min(last, MAX_PAGE)));

    const edges = window.map((node, i) => ({ cursor: encodeCursor(start + i), node }));
    const firstEdge = edges[0];
    const lastEdge = edges[edges.length - 1];
    return {
      edges,
      totalCount: rows.length,
      pageInfo: {
        hasNextPage: start + window.length < rows.length,
        hasPreviousPage: start > 0,
        startCursor: firstEdge?.cursor ?? null,
        endCursor: lastEdge?.cursor ?? null,
      },
    };
  },

  orders: (args: { limit?: number | null; offset?: number | null; status?: string | null; userId?: string | null; channel?: string | null; placedAfter?: string | null }) => {
    let rows: Order[] = dataset.orders;
    if (args.status != null) rows = rows.filter((o) => o.status === args.status);
    if (args.userId != null) rows = rows.filter((o) => o.userId === args.userId);
    if (args.channel != null) rows = rows.filter((o) => o.channel === args.channel);
    if (args.placedAfter != null) rows = rows.filter((o) => o.placedAt > (args.placedAfter as string));
    const offset = Math.max(0, args.offset ?? 0);
    const limit = Math.min(args.limit ?? 50, MAX_PAGE);
    return { nodes: rows.slice(offset, offset + limit), totalCount: rows.length };
  },

  products: (args: {
    where?: { category?: StringCompare; title?: StringCompare; sku?: StringCompare; price?: NumberCompare; stock?: NumberCompare } | null;
    orderBy?: { field: string; direction: string }[] | null;
    limit?: number | null;
    offset?: number | null;
  }) => {
    let rows: Product[] = dataset.products;
    const where = args.where;
    if (where) {
      rows = rows.filter(
        (p) =>
          matchString(p.category, where.category) &&
          matchString(p.title, where.title) &&
          matchString(p.sku, where.sku) &&
          matchNumber(p.price, where.price) &&
          matchNumber(p.stock, where.stock),
      );
    }
    if (args.orderBy?.length) {
      const keys: Record<string, keyof Product> = { PRICE: 'price', STOCK: 'stock', RATING: 'rating', TITLE: 'title' };
      rows = [...rows].sort((a, b) => {
        for (const sort of args.orderBy ?? []) {
          const key = keys[sort.field];
          if (!key) continue;
          const av = a[key];
          const bv = b[key];
          if (av === bv) continue;
          if (av == null) return 1;
          if (bv == null) return -1;
          const cmp = av > bv ? 1 : -1;
          return sort.direction === 'DESC' ? -cmp : cmp;
        }
        return 0;
      });
    }
    const offset = Math.max(0, args.offset ?? 0);
    const limit = Math.min(args.limit ?? 100, MAX_PAGE);
    return rows.slice(offset, offset + limit);
  },

  productsPaged: (args: { page?: number | null; perPage?: number | null; category?: string | null }) => {
    let rows: Product[] = dataset.products;
    if (args.category != null) rows = rows.filter((p) => p.category === args.category);
    const perPage = Math.min(Math.max(1, args.perPage ?? 50), MAX_PAGE);
    const page = Math.max(1, args.page ?? 1);
    return {
      items: rows.slice((page - 1) * perPage, page * perPage),
      page,
      perPage,
      totalPages: Math.max(1, Math.ceil(rows.length / perPage)),
      totalCount: rows.length,
    };
  },

  me: () => dataset.users[0] ?? null,

  serverInfo: () => ({
    name: 'graphql-workbench-demo',
    version: '1.0.0',
    now: new Date().toISOString(),
    seed: datasetSummary,
  }),

  search: (args: { term: string; limit?: number | null }) => {
    const term = args.term.toLowerCase();
    const limit = Math.min(args.limit ?? 20, 100);
    const hits: (User | Order | Product)[] = [
      ...dataset.users.filter((u) => u.name.toLowerCase().includes(term) || u.email.toLowerCase().includes(term)),
      ...dataset.products.filter((p) => p.title.toLowerCase().includes(term) || p.sku.toLowerCase().includes(term)),
      ...dataset.orders.filter((o) => o.id.toLowerCase().includes(term)),
    ];
    return hits.slice(0, limit);
  },

  node: (args: { id: string }) =>
    dataset.usersById.get(args.id) ?? dataset.productsById.get(args.id) ?? dataset.orders.find((o) => o.id === args.id) ?? null,

  cancelOrder: (args: { id: string }) => {
    const order = dataset.orders.find((o) => o.id === args.id);
    if (!order) return null;
    order.status = 'CANCELLED';
    return order;
  },

  touch: () => true,
};

/** Field resolvers that cannot be expressed by the default property lookup. */
const FIELD_RESOLVERS: Record<string, Record<string, GraphQLFieldResolver<unknown, DemoContext>>> = {
  User: {
    manager: (source) => {
      const user = source as User;
      return user.managerId ? dataset.usersById.get(user.managerId) ?? null : null;
    },
  },
};

export function buildDemoSchema(): GraphQLSchema {
  const schema = buildSchema(SDL);

  const node = schema.getType('Node');
  if (node instanceof GraphQLInterfaceType) {
    node.resolveType = (value) => (value as { __typename?: string }).__typename ?? 'User';
  }
  const searchResult = schema.getType('SearchResult');
  if (searchResult instanceof GraphQLUnionType) {
    searchResult.resolveType = (value) => (value as { __typename?: string }).__typename ?? 'User';
  }

  for (const [typeName, fields] of Object.entries(FIELD_RESOLVERS)) {
    const type = schema.getType(typeName);
    if (!(type instanceof GraphQLObjectType)) continue;
    const typeFields = type.getFields();
    for (const [fieldName, resolve] of Object.entries(fields)) {
      const field = typeFields[fieldName];
      if (field) field.resolve = resolve;
    }
  }

  return schema;
}
