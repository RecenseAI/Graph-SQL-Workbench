import {
  Kind,
  print,
  type ArgumentNode,
  type DocumentNode,
  type FieldNode,
  type NameNode,
  type ObjectFieldNode,
  type SelectionNode,
  type ValueNode,
  type VariableDefinitionNode,
} from 'graphql';
import type { CatalogArg, CatalogTable } from '@gqlwb/shared';
import { fail } from '../errors.ts';

/**
 * Builds the GraphQL document for one table's fetch.
 *
 * The document is assembled as an AST and printed, rather than concatenated as text: that way
 * string escaping, enum-vs-string literals and nested input objects are correct by construction,
 * and the printed result is something the user can copy straight into any GraphQL client.
 *
 * Pagination values are passed as variables so one document serves every page -- which keeps the
 * Generated GraphQL panel readable and lets endpoints cache the parsed query.
 */

export interface FetchSpec {
  table: CatalogTable;
  /** Alias for the root field in the response, so several tables can share one document. */
  alias: string;
  /** Argument values keyed by argument name, already resolved to plain JS values. */
  args: Record<string, unknown>;
  /** Leaf paths to select. Empty means "the smallest valid selection". */
  projection: string[][];
  /** Child tables to fetch alongside this one, by their path within the row. */
  childPaths: string[][];
  pageSize: number;
}

export interface DocumentPlan {
  document: string;
  variables: Record<string, unknown>;
  /** Variable name the pagination loop rewrites between pages, if any. */
  pageVariable?: { name: string; kind: 'cursor' | 'offset' | 'page' };
  rootAlias: string;
  /** Path from `data[alias]` down to the row list. */
  nodesPath: string[];
  /** Path from `data[alias]` to the pageInfo object, when the endpoint has one. */
  pageInfoPath?: string[];
  hasNextField?: string;
  endCursorField?: string;
  /** Path from `data[alias]` to a total-count field, when the endpoint has one. */
  totalField?: string;
  /** Page style: path from `data[alias]` to the endpoint's own next-page indicator. */
  nextPagePath?: string[];
  /** Page style: false when the endpoint picks its own page size. */
  pageSizeKnown?: boolean;
}

const name = (value: string): NameNode => ({ kind: Kind.NAME, value });

/** A node in the selection tree being assembled. */
interface SelectionTree {
  children: Map<string, SelectionTree>;
}

const emptyTree = (): SelectionTree => ({ children: new Map() });

function addPath(tree: SelectionTree, path: string[]): void {
  let current = tree;
  for (const segment of path) {
    let next = current.children.get(segment);
    if (!next) {
      next = emptyTree();
      current.children.set(segment, next);
    }
    current = next;
  }
}

function treeToSelections(tree: SelectionTree): SelectionNode[] {
  return [...tree.children.entries()].map(([fieldName, child]) => {
    const node: FieldNode = { kind: Kind.FIELD, name: name(fieldName) };
    if (child.children.size > 0) {
      return { ...node, selectionSet: { kind: Kind.SELECTION_SET, selections: treeToSelections(child) } };
    }
    return node;
  });
}

/**
 * Turns a JS value into a GraphQL literal. The argument metadata decides whether a string
 * becomes a quoted String or a bare Enum -- a distinction no amount of guessing gets right.
 */
export function toValueNode(value: unknown, arg?: CatalogArg): ValueNode {
  if (value === null || value === undefined) return { kind: Kind.NULL };

  if (Array.isArray(value)) {
    // A list argument's metadata describes its element type, so it is reused for every item.
    return { kind: Kind.LIST, values: value.map((item) => toValueNode(item, arg)) };
  }

  if (typeof value === 'boolean') return { kind: Kind.BOOLEAN, value };

  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { kind: Kind.INT, value: String(value) }
      : { kind: Kind.FLOAT, value: String(value) };
  }

  if (typeof value === 'bigint') return { kind: Kind.INT, value: String(value) };

  if (typeof value === 'object') {
    const fields = Object.entries(value as Record<string, unknown>).map(
      ([fieldName, fieldValue]): ObjectFieldNode => ({
        kind: Kind.OBJECT_FIELD,
        name: name(fieldName),
        value: toValueNode(fieldValue, arg?.inputFields?.find((f) => f.name === fieldName)),
      }),
    );
    return { kind: Kind.OBJECT, fields };
  }

  if (typeof value === 'string') {
    if (arg?.kind === 'enum' || (arg?.enumValues?.length && arg.enumValues.includes(value))) {
      return { kind: Kind.ENUM, value };
    }
    return { kind: Kind.STRING, value };
  }

  // Anything exotic is rendered as its JSON text, which is at least honest.
  return { kind: Kind.STRING, value: JSON.stringify(value) };
}

function argumentNodes(args: Record<string, unknown>, meta: CatalogArg[]): ArgumentNode[] {
  const byName = new Map(meta.map((a) => [a.name, a]));
  return Object.entries(args)
    .filter(([, value]) => value !== undefined)
    .map(([argName, value]): ArgumentNode => ({
      kind: Kind.ARGUMENT,
      name: name(argName),
      value: toValueNode(value, byName.get(argName)),
    }));
}

/** Whatever it takes to make a valid selection set when the SQL needs no columns at all. */
function fallbackSelection(table: CatalogTable): string[][] {
  const pk = table.columns.find((c) => c.name === table.primaryKey && c.path.length > 0);
  if (pk) return [pk.path];
  const anyLeaf = table.columns.find((c) => !c.synthetic && c.path.length > 0 && !c.isList);
  if (anyLeaf) return [anyLeaf.path];
  return [['__typename']];
}

export function buildFetchDocument(spec: FetchSpec): DocumentPlan {
  const { table } = spec;
  if (table.isChild) {
    fail(
      'INTERNAL',
      `${table.name} is a child table and is fetched with its parent, not on its own.`,
      undefined,
      `Query ${table.parent} as well, or join to it.`,
    );
  }

  // Required arguments have to come from the user; nothing sensible can be invented.
  const missing = table.args.filter((a) => a.required && spec.args[a.name] === undefined);
  if (missing.length > 0) {
    fail(
      'BAD_REQUEST',
      `${table.name} requires the argument ${missing.map((a) => a.name).join(', ')}.`,
      undefined,
      `Supply it in the FROM clause, for example: FROM ${table.name}(${missing[0]?.name}: "value")`,
    );
  }

  const leafPaths = spec.projection.length > 0 ? spec.projection : fallbackSelection(table);

  const rowTree = emptyTree();
  for (const path of leafPaths) {
    if (path.length === 0) continue;
    addPath(rowTree, path);
  }
  for (const childPath of spec.childPaths) {
    addPath(rowTree, childPath);
  }
  // A selection set cannot be empty.
  if (rowTree.children.size === 0) addPath(rowTree, ['__typename']);

  const pagination = table.pagination;
  const args: Record<string, unknown> = { ...spec.args };
  const variableDefs: VariableDefinitionNode[] = [];
  const variables: Record<string, unknown> = {};
  let pageVariable: DocumentPlan['pageVariable'];

  const declareVariable = (varName: string, typeName: string, initial: unknown): ValueNode => {
    variableDefs.push({
      kind: Kind.VARIABLE_DEFINITION,
      variable: { kind: Kind.VARIABLE, name: name(varName) },
      type: { kind: Kind.NAMED_TYPE, name: name(typeName) },
    });
    variables[varName] = initial;
    return { kind: Kind.VARIABLE, name: name(varName) };
  };

  /**
   * The cursor/offset/page argument is driven by a variable so one document serves every page.
   * If the user wrote that argument explicitly, its value seeds the variable instead of being
   * emitted a second time -- two arguments with the same name is a GraphQL validation error, and
   * silently dropping the user's value would be worse.
   */
  const paginationArgNames = new Set<string>();
  const seedFor = (argName: string | undefined): unknown =>
    argName === undefined ? undefined : args[argName];

  if (pagination.style === 'relay' && pagination.afterArg) paginationArgNames.add(pagination.afterArg);
  if (pagination.style === 'offset' && pagination.offsetArg) paginationArgNames.add(pagination.offsetArg);
  if (pagination.style === 'page' && pagination.pageArg) paginationArgNames.add(pagination.pageArg);

  const inlineArgs: Record<string, unknown> = {};
  for (const [argName, value] of Object.entries(args)) {
    if (!paginationArgNames.has(argName)) inlineArgs[argName] = value;
  }

  const rootArgs = argumentNodes(inlineArgs, table.args);

  if (pagination.style === 'relay' && pagination.firstArg && pagination.afterArg) {
    // An explicit first: from the user wins -- they asked for a specific page size.
    if (args[pagination.firstArg] === undefined) {
      rootArgs.push({ kind: Kind.ARGUMENT, name: name(pagination.firstArg), value: { kind: Kind.INT, value: String(spec.pageSize) } });
    }
    const varName = `after_${spec.alias}`;
    const seed = seedFor(pagination.afterArg);
    rootArgs.push({
      kind: Kind.ARGUMENT,
      name: name(pagination.afterArg),
      value: declareVariable(varName, 'String', typeof seed === 'string' ? seed : null),
    });
    pageVariable = { name: varName, kind: 'cursor' };
  } else if (pagination.style === 'offset' && pagination.limitArg && pagination.offsetArg) {
    if (args[pagination.limitArg] === undefined) {
      rootArgs.push({ kind: Kind.ARGUMENT, name: name(pagination.limitArg), value: { kind: Kind.INT, value: String(spec.pageSize) } });
    }
    const varName = `offset_${spec.alias}`;
    const seed = seedFor(pagination.offsetArg);
    rootArgs.push({
      kind: Kind.ARGUMENT,
      name: name(pagination.offsetArg),
      value: declareVariable(varName, 'Int', typeof seed === 'number' ? seed : 0),
    });
    pageVariable = { name: varName, kind: 'offset' };
  } else if (pagination.style === 'page' && pagination.pageArg) {
    // Some endpoints choose their own page size and take only a page number.
    if (pagination.perPageArg && args[pagination.perPageArg] === undefined) {
      rootArgs.push({ kind: Kind.ARGUMENT, name: name(pagination.perPageArg), value: { kind: Kind.INT, value: String(spec.pageSize) } });
    }
    const varName = `page_${spec.alias}`;
    const seed = seedFor(pagination.pageArg);
    rootArgs.push({
      kind: Kind.ARGUMENT,
      name: name(pagination.pageArg),
      value: declareVariable(varName, 'Int', typeof seed === 'number' ? seed : 1),
    });
    pageVariable = { name: varName, kind: 'page' };
  } else if (pagination.style === 'none' && pagination.limitArg && args[pagination.limitArg] === undefined) {
    // No way to page, but at least ask for as much as one call allows.
    rootArgs.push({ kind: Kind.ARGUMENT, name: name(pagination.limitArg), value: { kind: Kind.INT, value: String(spec.pageSize) } });
  }

  // Wrap the row selections in whatever envelope the endpoint uses.
  let rootSelections: SelectionNode[] = treeToSelections(rowTree);
  const nodesPath = pagination.nodesPath;

  if (nodesPath.length > 0) {
    for (let i = nodesPath.length - 1; i >= 0; i -= 1) {
      const segment = nodesPath[i];
      if (!segment) continue;
      rootSelections = [
        {
          kind: Kind.FIELD,
          name: name(segment),
          selectionSet: { kind: Kind.SELECTION_SET, selections: rootSelections },
        },
      ];
    }
  }

  if (pagination.style === 'relay' && pagination.pageInfoPath?.length && pagination.hasNextField && pagination.endCursorField) {
    const infoField = pagination.pageInfoPath[0];
    if (infoField) {
      rootSelections.push({
        kind: Kind.FIELD,
        name: name(infoField),
        selectionSet: {
          kind: Kind.SELECTION_SET,
          selections: [
            { kind: Kind.FIELD, name: name(pagination.hasNextField) },
            { kind: Kind.FIELD, name: name(pagination.endCursorField) },
          ],
        },
      });
    }
  }

  if (pagination.totalField && nodesPath.length > 0) {
    rootSelections.push({ kind: Kind.FIELD, name: name(pagination.totalField) });
  }

  // The endpoint's own "is there another page" field, e.g. info { next }.
  if (pagination.style === 'page' && pagination.nextPagePath?.length) {
    const [head, leaf] = pagination.nextPagePath;
    if (head && leaf) {
      rootSelections.push({
        kind: Kind.FIELD,
        name: name(head),
        selectionSet: { kind: Kind.SELECTION_SET, selections: [{ kind: Kind.FIELD, name: name(leaf) }] },
      });
    } else if (head) {
      rootSelections.push({ kind: Kind.FIELD, name: name(head) });
    }
  }

  const rootField: FieldNode = {
    kind: Kind.FIELD,
    alias: name(spec.alias),
    name: name(table.rootField),
    ...(rootArgs.length ? { arguments: rootArgs } : {}),
    ...(rootSelections.length ? { selectionSet: { kind: Kind.SELECTION_SET, selections: rootSelections } } : {}),
  };

  const document: DocumentNode = {
    kind: Kind.DOCUMENT,
    definitions: [
      {
        kind: Kind.OPERATION_DEFINITION,
        operation: 'query' as const,
        name: name('WorkbenchFetch'),
        ...(variableDefs.length ? { variableDefinitions: variableDefs } : {}),
        selectionSet: { kind: Kind.SELECTION_SET, selections: [rootField] },
      },
    ],
  };

  const plan: DocumentPlan = {
    document: print(document),
    variables,
    rootAlias: spec.alias,
    nodesPath,
  };
  if (pageVariable) plan.pageVariable = pageVariable;
  if (pagination.style === 'relay' && pagination.pageInfoPath?.length) {
    plan.pageInfoPath = pagination.pageInfoPath;
    if (pagination.hasNextField) plan.hasNextField = pagination.hasNextField;
    if (pagination.endCursorField) plan.endCursorField = pagination.endCursorField;
  }
  if (pagination.totalField && nodesPath.length > 0) plan.totalField = pagination.totalField;
  if (pagination.style === 'page') {
    if (pagination.nextPagePath?.length) plan.nextPagePath = pagination.nextPagePath;
    // With no page-size argument, a short page says nothing about whether more exist.
    plan.pageSizeKnown = Boolean(pagination.perPageArg);
  }
  return plan;
}

/**
 * Pulls the row list out of a response. Walking the path level by level handles both
 * `edges { node }` (a list, then an object per item) and plain `nodes` lists, and treats a
 * single object as a one-row result.
 */
export function extractRows(rootValue: unknown, nodesPath: string[]): unknown[] {
  if (nodesPath.length === 0) {
    if (rootValue === null || rootValue === undefined) return [];
    return Array.isArray(rootValue) ? rootValue : [rootValue];
  }
  let current: unknown[] = [rootValue];
  for (const key of nodesPath) {
    const next: unknown[] = [];
    for (const item of current) {
      if (item === null || item === undefined || typeof item !== 'object') continue;
      const value = (item as Record<string, unknown>)[key];
      if (Array.isArray(value)) next.push(...value);
      else if (value !== null && value !== undefined) next.push(value);
    }
    current = next;
  }
  return current;
}

/** Reads a nested value by path, used for pageInfo and totals. */
export function readPath(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
