/**
 * The relational catalog derived from a GraphQL schema.
 *
 * Every field on the Query type becomes a virtual table; scalar leaves reachable
 * within `maxDepth` become columns; lists of objects become child tables joinable
 * back to their parent. This is the contract the planner, the SQL layer and the UI
 * all agree on.
 */

export type ScalarKind = 'string' | 'int' | 'float' | 'boolean' | 'id' | 'enum' | 'custom';

export interface CatalogColumn {
  /** SQL column name, e.g. `address_city`. Unique within its table. */
  name: string;
  /** GraphQL field path from the row root, e.g. `['address','city']`. */
  path: string[];
  /** DuckDB type, e.g. `VARCHAR`, `BIGINT`, `VARCHAR[]`, `JSON`. */
  duckType: string;
  /** Printed GraphQL type, e.g. `String!`. */
  graphqlType: string;
  /** Name of the GraphQL named type, e.g. `String`, `DateTime`, `Role`. */
  graphqlTypeName: string;
  nullable: boolean;
  /** True when this column holds a list of scalars (a DuckDB LIST). */
  isList: boolean;
  kind: ScalarKind;
  enumValues?: string[];
  description?: string;
  deprecationReason?: string;
  /** Synthetic columns (`_rowid`, `_raw`, `_parent_*`, `*_count`) are hidden by default. */
  synthetic?: boolean;
}

export type PaginationStyle = 'relay' | 'offset' | 'page' | 'none';

export interface PaginationSpec {
  style: PaginationStyle;
  /** Path from the root field's value down to the row list, e.g. `['edges','node']`. */
  nodesPath: string[];
  /** Relay */
  firstArg?: string;
  afterArg?: string;
  pageInfoPath?: string[];
  hasNextField?: string;
  endCursorField?: string;
  /** Offset / page */
  limitArg?: string;
  offsetArg?: string;
  pageArg?: string;
  perPageArg?: string;
  /** A sibling total-count field on the connection object, when present. */
  totalField?: string;
  /**
   * Page style only: path to a field saying whether another page exists, e.g. `['info','next']`.
   * Required when the endpoint chooses its own page size, since a short page then proves nothing.
   */
  nextPagePath?: string[];
  defaultPageSize: number;
}

export interface CatalogArg {
  name: string;
  graphqlType: string;
  graphqlTypeName: string;
  kind: 'scalar' | 'enum' | 'input' | 'list';
  required: boolean;
  defaultValue?: string;
  enumValues?: string[];
  /** Input-object fields, recursed one level -- this is the filter pushdown surface. */
  inputFields?: CatalogArg[];
  description?: string;
}

export interface CatalogTable {
  /** SQL table name. Root tables use the Query field name; children use `parent__path`. */
  name: string;
  /** The Query field this table ultimately reads from. */
  rootField: string;
  /** GraphQL object type of one row. */
  rowTypeName: string;
  description?: string;
  deprecationReason?: string;
  pagination: PaginationSpec;
  columns: CatalogColumn[];
  args: CatalogArg[];
  /** Column acting as the primary key (an `id`/`ID` field), when one exists. */
  primaryKey?: string;
  /** Names of child tables extracted from lists of objects on this table. */
  childTables: string[];
  isChild: boolean;
  /** Child tables only: the parent table name and the path that produced this list. */
  parent?: string;
  parentPath?: string[];
  /** Child tables only: the column joining back to the parent. */
  parentKeyColumn?: string;
  /** The column on the parent that `parentKeyColumn` refers to. */
  parentRefColumn?: string;
}

export interface CatalogEnum {
  name: string;
  values: { name: string; description?: string; deprecationReason?: string }[];
  description?: string;
}

export interface CatalogTypeSummary {
  name: string;
  kind: 'OBJECT' | 'INTERFACE' | 'UNION' | 'INPUT_OBJECT' | 'ENUM' | 'SCALAR';
  description?: string;
  fields?: { name: string; type: string; description?: string }[];
}

export interface Catalog {
  connectionId: string;
  endpoint: string;
  /** Stable hash of the introspected schema -- shown in the UI, used to invalidate caches. */
  schemaHash: string;
  queryTypeName: string;
  tables: CatalogTable[];
  enums: CatalogEnum[];
  types: CatalogTypeSummary[];
  /** Listed for the schema browser only. The SQL engine never writes. */
  mutationNames: string[];
  /** Fields skipped, depth truncations, unsupported shapes -- surfaced in the UI. */
  warnings: string[];
  maxDepth: number;
  builtAt: string;
  source: 'introspection' | 'sdl';
}

export function findTable(catalog: Catalog, name: string): CatalogTable | undefined {
  const lower = name.toLowerCase();
  return catalog.tables.find((t) => t.name.toLowerCase() === lower);
}

export function findColumn(table: CatalogTable, name: string): CatalogColumn | undefined {
  const lower = name.toLowerCase();
  return table.columns.find((c) => c.name.toLowerCase() === lower);
}
