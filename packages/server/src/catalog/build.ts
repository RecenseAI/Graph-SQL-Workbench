import { createHash } from 'node:crypto';
import {
  getNamedType,
  getNullableType,
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  isUnionType,
  printSchema,
  type GraphQLArgument,
  type GraphQLEnumType,
  type GraphQLField,
  type GraphQLNamedType,
  type GraphQLSchema,
  type GraphQLType,
} from 'graphql';
import type {
  Catalog,
  CatalogArg,
  CatalogColumn,
  CatalogEnum,
  CatalogTable,
  CatalogTypeSummary,
} from '@gqlwb/shared';
import { analyseRootField, type RowType } from './pagination.ts';
import { asList, ENUM_MAPPING, mapScalar } from './typemap.ts';

export interface BuildCatalogOptions {
  connectionId: string;
  endpoint: string;
  maxDepth: number;
  pageSize: number;
  scalarTypeMap?: Record<string, string>;
  source?: 'introspection' | 'sdl';
}

/** Guardrails so a large federated schema cannot produce a catalog nobody can read. */
const MAX_CHILD_TABLES_PER_ROOT = 12;
/** Root tables only; child tables are bounded per root. Hasura-style schemas have hundreds. */
const MAX_ROOT_TABLES = 1000;
const MAX_COLUMNS_PER_TABLE = 250;

interface WalkContext {
  maxDepth: number;
  scalarTypeMap: Record<string, string>;
  warnings: string[];
  /** Child tables discovered during the walk, built after the parent is complete. */
  pendingChildren: PendingChild[];
  unmappedScalars: Set<string>;
  /** Paths not flattened because of the depth limit; summarised once per table. */
  depthStops: string[];
  /** Paths not flattened because the type repeats on its own path. */
  cycleStops: string[];
  /** Nested composite fields skipped because they take arguments. */
  argRelations: number;
}

/**
 * One line per table for fields that were not flattened, rather than one line per field. A
 * large schema can have hundreds of these, and a list that long hides the warnings that matter.
 */
function summariseStops(tableName: string, ctx: WalkContext): void {
  const sample = (paths: string[]) => {
    const shown = paths.slice(0, 4).join(', ');
    return paths.length > 4 ? `${shown} and ${paths.length - 4} more` : shown;
  };
  if (ctx.depthStops.length > 0) {
    ctx.warnings.push(
      `${tableName}: ${ctx.depthStops.length} nested field(s) stopped at the depth limit ${ctx.maxDepth} (${sample(ctx.depthStops)}). Raise the column depth on the connection to include them.`,
    );
  }
  if (ctx.cycleStops.length > 0) {
    ctx.warnings.push(
      `${tableName}: ${ctx.cycleStops.length} field(s) not flattened because their type repeats on the path, a cycle (${sample(ctx.cycleStops)}).`,
    );
  }
  ctx.depthStops = [];
  ctx.cycleStops = [];
}

interface PendingChild {
  /** Path from the row root to the list field. */
  path: string[];
  rowType: RowType;
  /** Nesting depth of lists, so a list of lists is not silently flattened. */
  listDepth: number;
}

/** Keeps generated column names unique without renaming the common case. */
class NameRegistry {
  private taken = new Set<string>();
  claim(preferred: string): string {
    const lower = preferred.toLowerCase();
    if (!this.taken.has(lower)) {
      this.taken.add(lower);
      return preferred;
    }
    for (let i = 2; i < 500; i += 1) {
      const candidate = `${preferred}_${i}`;
      if (!this.taken.has(candidate.toLowerCase())) {
        this.taken.add(candidate.toLowerCase());
        return candidate;
      }
    }
    throw new Error(`Cannot find a unique name for ${preferred}`);
  }
  has(name: string): boolean {
    return this.taken.has(name.toLowerCase());
  }
}

function printType(type: GraphQLType): string {
  return String(type);
}

/** Counts the list levels in a GraphQL type, ignoring non-null wrappers. */
function listDepthOf(type: GraphQLType): number {
  let depth = 0;
  let current: GraphQLType = type;
  for (;;) {
    if (isNonNullType(current)) {
      current = current.ofType;
      continue;
    }
    if (isListType(current)) {
      depth += 1;
      current = current.ofType;
      continue;
    }
    return depth;
  }
}

function isRequiredArg(arg: GraphQLArgument): boolean {
  return isNonNullType(arg.type) && arg.defaultValue === undefined;
}

/**
 * `columnNames` limits the second level of input expansion to fields that are columns of the
 * table. Pushdown only ever writes `where.<column>.<operator>`; expanding every relationship's
 * filter as well made a Hasura catalog's argument metadata alone run to 15 MB.
 */
function buildArg(arg: GraphQLArgument, recurse: boolean, columnNames?: Set<string>): CatalogArg {
  const named = getNamedType(arg.type);
  const base: CatalogArg = {
    name: arg.name,
    graphqlType: printType(arg.type),
    graphqlTypeName: named.name,
    kind: isListType(getNullableType(arg.type))
      ? 'list'
      : isEnumType(named)
        ? 'enum'
        : isScalarType(named)
          ? 'scalar'
          : 'input',
    required: isRequiredArg(arg),
  };
  if (arg.description) base.description = arg.description;
  if (arg.defaultValue !== undefined) base.defaultValue = JSON.stringify(arg.defaultValue);
  if (isEnumType(named)) base.enumValues = named.getValues().map((v) => v.name);
  if (recurse && isInputObjectType(named)) {
    base.inputFields = Object.values(named.getFields()).map((field) => {
      const fieldNamed = getNamedType(field.type);
      const nested: CatalogArg = {
        name: field.name,
        graphqlType: printType(field.type),
        graphqlTypeName: fieldNamed.name,
        kind: isListType(getNullableType(field.type))
          ? 'list'
          : isEnumType(fieldNamed)
            ? 'enum'
            : isScalarType(fieldNamed)
              ? 'scalar'
              : 'input',
        required: isNonNullType(field.type) && field.defaultValue === undefined,
      };
      if (field.description) nested.description = field.description;
      if (isEnumType(fieldNamed)) nested.enumValues = fieldNamed.getValues().map((v) => v.name);
      // One more level, which is what Hasura-style `where: {col: {_eq: v}}` needs.
      if (isInputObjectType(fieldNamed) && (!columnNames || columnNames.has(field.name))) {
        nested.inputFields = Object.values(fieldNamed.getFields()).map((leaf) => {
          const leafNamed = getNamedType(leaf.type);
          const leafArg: CatalogArg = {
            name: leaf.name,
            graphqlType: printType(leaf.type),
            graphqlTypeName: leafNamed.name,
            kind: isListType(getNullableType(leaf.type)) ? 'list' : isEnumType(leafNamed) ? 'enum' : isScalarType(leafNamed) ? 'scalar' : 'input',
            required: isNonNullType(leaf.type) && leaf.defaultValue === undefined,
          };
          if (isEnumType(leafNamed)) leafArg.enumValues = leafNamed.getValues().map((v) => v.name);
          return leafArg;
        });
      }
      return nested;
    });
  }
  return base;
}

/**
 * Walks a row type collecting scalar leaves as columns. Nested objects are flattened with
 * underscore-joined paths; lists of scalars stay as DuckDB LIST columns; lists of objects become
 * child tables. Recursion stops at `maxDepth` or when a type repeats on the current path, so a
 * self-referential schema terminates.
 */
function walkColumns(
  rowType: RowType,
  path: string[],
  depth: number,
  typeChain: string[],
  names: NameRegistry,
  ctx: WalkContext,
): CatalogColumn[] {
  const columns: CatalogColumn[] = [];

  if (isUnionType(rowType)) {
    ctx.warnings.push(
      `${rowType.name} is a union, so only __typename is available as a column. Use the _raw column to reach member fields.`,
    );
    return columns;
  }

  const fields = isObjectType(rowType) || isInterfaceType(rowType) ? rowType.getFields() : {};

  for (const field of Object.values(fields) as GraphQLField<unknown, unknown>[]) {
    if (field.name.startsWith('__')) continue;
    if (columns.length >= MAX_COLUMNS_PER_TABLE) {
      ctx.warnings.push(`${rowType.name} has more than ${MAX_COLUMNS_PER_TABLE} leaf fields; the rest were skipped.`);
      break;
    }
    // A field needing arguments cannot be selected automatically.
    const required = field.args.filter(isRequiredArg);
    if (required.length > 0) {
      ctx.warnings.push(
        `Skipped ${[...path, field.name].join('.')}: it requires the argument ${required.map((a) => a.name).join(', ')}.`,
      );
      continue;
    }

    const fieldPath = [...path, field.name];
    const columnName = names.claim(fieldPath.join('_'));
    const named = getNamedType(field.type);
    const listDepth = listDepthOf(field.type);
    const nullable = !isNonNullType(field.type);

    if (isScalarType(named) || isEnumType(named)) {
      const mapping = isEnumType(named) ? ENUM_MAPPING : mapScalar(named.name, ctx.scalarTypeMap);
      if (mapping.guessed) ctx.unmappedScalars.add(named.name);
      const column: CatalogColumn = {
        name: columnName,
        path: fieldPath,
        duckType: listDepth > 0 ? asList(mapping.duckType, listDepth) : mapping.duckType,
        graphqlType: printType(field.type),
        graphqlTypeName: named.name,
        nullable,
        isList: listDepth > 0,
        kind: mapping.kind,
      };
      if (isEnumType(named)) column.enumValues = (named as GraphQLEnumType).getValues().map((v) => v.name);
      if (field.description) column.description = field.description;
      if (field.deprecationReason) column.deprecationReason = field.deprecationReason;
      columns.push(column);
      continue;
    }

    const composite = isObjectType(named) || isInterfaceType(named) || isUnionType(named) ? (named as RowType) : null;
    if (!composite) continue;

    // A nested field that takes arguments -- Hasura's `posts(where:, limit:)`, a Relay
    // `friendsConnection(first:)` -- is a query in its own right, not data embedded in the row.
    // Expanding every one of them made a Hasura schema's catalog run to tens of megabytes and a
    // thousand duplicate tables. They stay reachable as their own root tables and joins.
    if (field.args.length > 0) {
      ctx.argRelations += 1;
      continue;
    }

    if (listDepth > 0) {
      // A list inside a nested object (continent.countries on a country) is that object's
      // relationship, not this row's. Making every such list a table buried the useful ones
      // under dozens of near-duplicates, so only lists directly on the row become child tables.
      if (path.length > 0) continue;
      // A list of objects becomes its own table, joinable back to this one.
      ctx.pendingChildren.push({ path: fieldPath, rowType: composite, listDepth });
      columns.push({
        name: names.claim(`${columnName}_count`),
        path: fieldPath,
        duckType: 'BIGINT',
        graphqlType: printType(field.type),
        graphqlTypeName: named.name,
        nullable: true,
        isList: false,
        kind: 'int',
        description: `Number of ${field.name} rows for this row. The rows themselves live in the child table.`,
        synthetic: true,
      });
      continue;
    }

    // A nested single object: flatten it, subject to depth and cycle limits.
    if (depth >= ctx.maxDepth) {
      ctx.depthStops.push(fieldPath.join('.'));
      continue;
    }
    if (typeChain.includes(named.name)) {
      ctx.cycleStops.push(fieldPath.join('.'));
      continue;
    }
    columns.push(
      ...walkColumns(composite, fieldPath, depth + 1, [...typeChain, named.name], names, ctx),
    );
  }

  return columns;
}

function syntheticColumns(kind: 'root' | 'child', parentPrimaryKey?: string): CatalogColumn[] {
  const columns: CatalogColumn[] = [
    {
      name: '_rowid',
      path: [],
      duckType: 'BIGINT',
      graphqlType: 'Int!',
      graphqlTypeName: 'Int',
      nullable: false,
      isList: false,
      kind: 'int',
      description: 'Ordinal of this row within the fetched set. Stable join key even when the type has no id.',
      synthetic: true,
    },
    {
      name: '_raw',
      path: [],
      duckType: 'JSON',
      graphqlType: 'JSON',
      graphqlTypeName: 'JSON',
      nullable: true,
      isList: false,
      kind: 'custom',
      description: 'The row exactly as the endpoint returned it. The escape hatch for anything the catalog could not flatten.',
      synthetic: true,
    },
  ];
  if (kind === 'child') {
    columns.unshift({
      name: '_parent_rowid',
      path: [],
      duckType: 'BIGINT',
      graphqlType: 'Int!',
      graphqlTypeName: 'Int',
      nullable: false,
      isList: false,
      kind: 'int',
      description: 'Joins back to _rowid on the parent table.',
      synthetic: true,
    });
    columns.push({
      name: '_index',
      path: [],
      duckType: 'BIGINT',
      graphqlType: 'Int!',
      graphqlTypeName: 'Int',
      nullable: false,
      isList: false,
      kind: 'int',
      description: 'Position of this row within its parent list, counting from zero.',
      synthetic: true,
    });
    if (parentPrimaryKey) {
      columns.unshift({
        name: `_parent_${parentPrimaryKey}`,
        path: [],
        duckType: 'VARCHAR',
        graphqlType: 'ID',
        graphqlTypeName: 'ID',
        nullable: true,
        isList: false,
        kind: 'id',
        description: `Copy of ${parentPrimaryKey} from the parent row, for readable joins.`,
        synthetic: true,
      });
    }
  }
  return columns;
}

function findPrimaryKey(columns: CatalogColumn[]): string | undefined {
  const id = columns.find((c) => c.path.length === 1 && c.path[0] === 'id' && !c.isList);
  return id?.name;
}

export function buildCatalog(schema: GraphQLSchema, options: BuildCatalogOptions): Catalog {
  const scalarTypeMap = options.scalarTypeMap ?? {};
  const warnings: string[] = [];
  const unmappedScalars = new Set<string>();
  const tables: CatalogTable[] = [];
  const tableNames = new NameRegistry();
  let argRelationsTotal = 0;

  const queryType = schema.getQueryType();
  if (!queryType) {
    throw new Error('The schema has no Query type, so there is nothing to select from.');
  }

  for (const field of Object.values(queryType.getFields())) {
    if (tables.filter((t) => !t.isChild).length >= MAX_ROOT_TABLES) {
      warnings.push(`Stopped after ${MAX_ROOT_TABLES} Query fields; the rest are not available as tables.`);
      break;
    }

    const shape = analyseRootField(field, options.pageSize);
    warnings.push(...shape.warnings);

    const tableName = tableNames.claim(field.name);
    const columnNames = new NameRegistry();
    const ctx: WalkContext = {
      maxDepth: options.maxDepth,
      scalarTypeMap,
      warnings,
      pendingChildren: [],
      unmappedScalars,
      depthStops: [],
      cycleStops: [],
      argRelations: 0,
    };

    let columns: CatalogColumn[] = [];
    if (shape.rowType) {
      if (isUnionType(shape.rowType)) {
        ctx.warnings.push(
          `${field.name} returns the union ${shape.rowType.name}; only __typename and _raw are available. Cast through _raw to read member fields.`,
        );
        columns.push({
          name: columnNames.claim('__typename'),
          path: ['__typename'],
          duckType: 'VARCHAR',
          graphqlType: 'String!',
          graphqlTypeName: 'String',
          nullable: false,
          isList: false,
          kind: 'string',
          description: 'Concrete type of this row.',
        });
      } else {
        columns = walkColumns(shape.rowType, [], 1, [shape.rowType.name], columnNames, ctx);
        if (isInterfaceType(shape.rowType)) {
          columns.unshift({
            name: columnNames.claim('__typename'),
            path: ['__typename'],
            duckType: 'VARCHAR',
            graphqlType: 'String!',
            graphqlTypeName: 'String',
            nullable: false,
            isList: false,
            kind: 'string',
            description: `Concrete type implementing ${shape.rowType.name}.`,
          });
        }
      }
    } else {
      // A scalar root field still makes a one-row, one-column table.
      const named = getNamedType(field.type);
      const mapping = isEnumType(named) ? ENUM_MAPPING : mapScalar(named.name, scalarTypeMap);
      if (mapping.guessed) unmappedScalars.add(named.name);
      columns.push({
        name: columnNames.claim(field.name),
        path: [],
        duckType: listDepthOf(field.type) > 0 ? asList(mapping.duckType, listDepthOf(field.type)) : mapping.duckType,
        graphqlType: printType(field.type),
        graphqlTypeName: named.name,
        nullable: !isNonNullType(field.type),
        isList: listDepthOf(field.type) > 0,
        kind: mapping.kind,
      });
    }

    summariseStops(tableName, ctx);
    argRelationsTotal += ctx.argRelations;
    const primaryKey = findPrimaryKey(columns);
    for (const synthetic of syntheticColumns('root')) {
      if (!columnNames.has(synthetic.name)) {
        columnNames.claim(synthetic.name);
        columns.push(synthetic);
      }
    }

    const table: CatalogTable = {
      name: tableName,
      rootField: field.name,
      rowTypeName: shape.rowType?.name ?? getNamedType(field.type).name,
      pagination: shape.pagination,
      columns,
      args: field.args.map((arg) =>
        buildArg(
          arg,
          true,
          new Set(columns.filter((c) => !c.synthetic && c.path.length === 1).map((c) => c.path[0] as string)),
        ),
      ),
      childTables: [],
      isChild: false,
    };
    if (field.description) table.description = field.description;
    if (field.deprecationReason) table.deprecationReason = field.deprecationReason;
    if (primaryKey) table.primaryKey = primaryKey;
    tables.push(table);

    // Child tables, breadth-first, each with a fresh depth budget.
    // `chain` holds the row types from the root down to this child's parent. A child whose type
    // is already on it (country -> languages -> countries -> ...) is a cycle: it adds no data the
    // user cannot reach by joining the root table, and following it only multiplies tables.
    const rootChain = [table.rowTypeName];
    const queue = ctx.pendingChildren.map((child) => ({ child, parent: table, chain: rootChain }));
    let created = 0;
    while (queue.length > 0) {
      const next = queue.shift();
      if (!next) break;
      if (next.chain.includes(next.child.rowType.name)) continue;
      if (created >= MAX_CHILD_TABLES_PER_ROOT) {
        warnings.push(
          `${field.name} has more nested lists than the ${MAX_CHILD_TABLES_PER_ROOT}-child limit; the rest were skipped.`,
        );
        break;
      }
      created += 1;

      const childName = tableNames.claim(`${next.parent.name}__${next.child.path.join('_')}`);
      const childColumnNames = new NameRegistry();
      const childCtx: WalkContext = {
        maxDepth: options.maxDepth,
        scalarTypeMap,
        warnings,
        pendingChildren: [],
        unmappedScalars,
        depthStops: [],
        cycleStops: [],
        argRelations: 0,
      };

      let childColumns: CatalogColumn[] = [];
      if (isUnionType(next.child.rowType)) {
        warnings.push(
          `${childName} comes from a union list; only __typename and _raw are available.`,
        );
        childColumns.push({
          name: childColumnNames.claim('__typename'),
          path: ['__typename'],
          duckType: 'VARCHAR',
          graphqlType: 'String!',
          graphqlTypeName: 'String',
          nullable: false,
          isList: false,
          kind: 'string',
        });
      } else {
        childColumns = walkColumns(
          next.child.rowType,
          [],
          1,
          [next.child.rowType.name],
          childColumnNames,
          childCtx,
        );
      }

      summariseStops(childName, childCtx);
      argRelationsTotal += childCtx.argRelations;
      const childPrimaryKey = findPrimaryKey(childColumns);
      for (const synthetic of syntheticColumns('child', next.parent.primaryKey)) {
        if (!childColumnNames.has(synthetic.name)) {
          childColumnNames.claim(synthetic.name);
          childColumns.push(synthetic);
        }
      }

      const childTable: CatalogTable = {
        name: childName,
        rootField: field.name,
        rowTypeName: next.child.rowType.name,
        description: `Rows from ${next.parent.name}.${next.child.path.join('.')}. Fetched with the parent, joined on _parent_rowid.`,
        pagination: { style: 'none', nodesPath: [], defaultPageSize: options.pageSize },
        columns: childColumns,
        args: [],
        childTables: [],
        isChild: true,
        parent: next.parent.name,
        parentPath: next.child.path,
        parentKeyColumn: '_parent_rowid',
        parentRefColumn: '_rowid',
      };
      if (childPrimaryKey) childTable.primaryKey = childPrimaryKey;
      next.parent.childTables.push(childName);
      tables.push(childTable);

      // Grandchildren, so a list inside a list still produces a usable table.
      for (const grandchild of childCtx.pendingChildren) {
        queue.push({ child: grandchild, parent: childTable, chain: [...next.chain, next.child.rowType.name] });
      }
    }
  }

  if (unmappedScalars.size > 0) {
    warnings.push(
      `Custom scalars read as text because their names are unfamiliar: ${[...unmappedScalars].sort().join(', ')}. Map them under the connection's scalar types if you want real DuckDB types.`,
    );
  }

  const enums: CatalogEnum[] = [];
  const types: CatalogTypeSummary[] = [];
  for (const type of Object.values(schema.getTypeMap())) {
    if (type.name.startsWith('__')) continue;
    if (isEnumType(type)) {
      const entry: CatalogEnum = {
        name: type.name,
        values: type.getValues().map((value) => {
          const item: CatalogEnum['values'][number] = { name: value.name };
          if (value.description) item.description = value.description;
          if (value.deprecationReason) item.deprecationReason = value.deprecationReason;
          return item;
        }),
      };
      if (type.description) entry.description = type.description;
      enums.push(entry);
    }
    const kind = isObjectType(type)
      ? 'OBJECT'
      : isInterfaceType(type)
        ? 'INTERFACE'
        : isUnionType(type)
          ? 'UNION'
          : isEnumType(type)
            ? 'ENUM'
            : isInputObjectType(type)
              ? 'INPUT_OBJECT'
              : isScalarType(type)
                ? 'SCALAR'
                : null;
    if (!kind) continue;
    const summary: CatalogTypeSummary = { name: type.name, kind };
    if (type.description) summary.description = type.description;
    if (isObjectType(type) || isInterfaceType(type)) {
      summary.fields = Object.values(type.getFields()).map((f) => {
        const entry: NonNullable<CatalogTypeSummary['fields']>[number] = { name: f.name, type: printType(f.type) };
        if (f.description) entry.description = f.description;
        return entry;
      });
    }
    types.push(summary);
  }

  const mutationType = schema.getMutationType();
  const printed = printSchema(schema);

  // The same nested type is often reached from several root fields, so the same note about a
  // depth or cycle limit can be generated repeatedly. Show each distinct one once.
  // Per-table notes are useful for a handful of tables and noise for hundreds, so past a point
  // the rest are counted rather than listed.
  const MAX_TABLE_NOTES = 12;
  const isTableNote = (w: string) =>
    /stopped at the depth limit|a cycle \(|-child limit|no pagination arguments|only the first page/.test(w);
  const deduped = [...new Set(warnings)];
  const tableNotes = deduped.filter(isTableNote);
  const uniqueWarnings = deduped.filter((w) => !isTableNote(w));
  uniqueWarnings.push(...tableNotes.slice(0, MAX_TABLE_NOTES));
  if (tableNotes.length > MAX_TABLE_NOTES) {
    uniqueWarnings.push(
      `${tableNotes.length - MAX_TABLE_NOTES} more notes like these on other tables (paging, depth or cycle limits). DESCRIBE a table to see exactly what it contains.`,
    );
  }
  if (argRelationsTotal > 0) {
    uniqueWarnings.push(
      `${argRelationsTotal} nested field(s) that take their own arguments (for example Hasura relationships or Relay connections) were not expanded into columns. Query them as their own tables and join.`,
    );
  }

  return {
    connectionId: options.connectionId,
    endpoint: options.endpoint,
    schemaHash: createHash('sha256').update(printed).digest('hex').slice(0, 16),
    queryTypeName: queryType.name,
    tables,
    enums: enums.sort((a, b) => a.name.localeCompare(b.name)),
    types: types.sort((a, b) => a.name.localeCompare(b.name)),
    mutationNames: mutationType ? Object.keys(mutationType.getFields()).sort() : [],
    warnings: uniqueWarnings,
    maxDepth: options.maxDepth,
    builtAt: new Date().toISOString(),
    source: options.source ?? 'introspection',
  };
}
