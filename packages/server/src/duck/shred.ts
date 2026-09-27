import type { DuckDBConnection } from '@duckdb/node-api';
import type { CatalogColumn, CatalogTable } from '@gqlwb/shared';
import { assertSafeDuckType, quoteIdent, quoteLiteral } from './sql-util.ts';
import { fail } from '../errors.ts';
import { logger } from '../log.ts';

const log = logger('shred');

/**
 * Turns a fetched NDJSON file into typed DuckDB relations.
 *
 * The column types come from the catalog rather than from DuckDB's sampling, which matters for
 * two reasons: the schema and column order are identical whether the fetch returned ten thousand
 * rows or none, and a column the endpoint happened to send as all-nulls still gets its real type.
 *
 * Each table becomes a raw table holding the nested JSON shape, plus a view that flattens nested
 * objects into `parent_child` columns. Lists of objects are unnested into their own relations,
 * keyed back to the parent by `_parent_rowid`.
 */

export interface ShredNode {
  /** DuckDB relation name. */
  relation: string;
  table: CatalogTable;
  /** Non-synthetic leaf columns to materialise. */
  columns: CatalogColumn[];
  /** Nested list-of-object tables to unnest out of this one. */
  children: ShredNode[];
  /** Path from this node's row root to the list producing a child. Children only. */
  listPath?: string[];
}

export interface ShredTarget extends ShredNode {
  /** NDJSON file produced by the fetcher. */
  file: string;
}

export interface ShredResult {
  relation: string;
  rows: number;
  /** Every relation created, parents and children alike. */
  created: { relation: string; rows: number }[];
  warnings: string[];
  /** True when strict typing failed and the data was re-read as text. */
  degradedToText: boolean;
}

interface TypeNode {
  children: Map<string, TypeNode>;
  leaf?: string;
  list?: boolean;
}

const emptyType = (): TypeNode => ({ children: new Map() });

function insertPath(root: TypeNode, path: string[], build: (node: TypeNode) => void): void {
  let current = root;
  for (const segment of path) {
    let next = current.children.get(segment);
    if (!next) {
      next = emptyType();
      current.children.set(segment, next);
    }
    current = next;
  }
  build(current);
}

/** The nested DuckDB type of one node's row, as `read_json` needs to see it. */
function buildTypeTree(node: ShredNode, allVarchar: boolean): TypeNode {
  const root = emptyType();
  for (const column of node.columns) {
    if (column.path.length === 0) continue;
    const duckType = allVarchar ? textEquivalent(column.duckType) : column.duckType;
    insertPath(root, column.path, (leaf) => {
      leaf.leaf = assertSafeDuckType(duckType);
    });
  }
  for (const child of node.children) {
    if (!child.listPath?.length) continue;
    const subtree = buildTypeTree(child, allVarchar);
    insertPath(root, child.listPath, (listNode) => {
      listNode.list = true;
      listNode.children = subtree.children;
    });
  }
  return root;
}

/** A text version of a type, preserving list nesting, used when strict parsing fails. */
function textEquivalent(duckType: string): string {
  const suffix = duckType.match(/(\[\])+$/)?.[0] ?? '';
  return 'VARCHAR' + suffix;
}

function renderType(node: TypeNode): string {
  if (node.leaf) return node.leaf;
  const fields = [...node.children.entries()].map(([fieldName, child]) => `${quoteIdent(fieldName)} ${renderType(child)}`);
  const struct = fields.length > 0 ? `STRUCT(${fields.join(', ')})` : 'JSON';
  return node.list ? `${struct}[]` : struct;
}

/** The `columns := {...}` clause for the root read_json call. */
export function buildColumnsSpec(node: ShredNode, allVarchar = false): string {
  const tree = buildTypeTree(node, allVarchar);
  const entries = [...tree.children.entries()].map(
    ([fieldName, child]) => `${quoteIdent(fieldName)}: ${quoteLiteral(renderType(child))}`,
  );
  // _rowid is injected by the fetcher so row identity does not depend on read order.
  entries.push(`${quoteIdent('_rowid')}: ${quoteLiteral('BIGINT')}`);
  return `{${entries.join(', ')}}`;
}

const rawName = (relation: string): string => `${relation}__wbraw`;

/** Path expression relative to a row root, e.g. "address"."city". */
function pathExpr(prefix: string, path: string[]): string {
  const tail = path.map(quoteIdent).join('.');
  return prefix ? `${prefix}.${tail}` : tail;
}

function readJsonSql(file: string, spec: string, lenient: boolean): string {
  const options = [
    `format=${quoteLiteral('newline_delimited')}`,
    `columns=${spec}`,
    // A zero-row file must still produce the full typed schema.
    'maximum_object_size=104857600',
  ];
  if (lenient) options.push('ignore_errors=true');
  return `SELECT * FROM read_json(${quoteLiteral(file)}, ${options.join(', ')})`;
}

/** SELECT list for the flattening view of one node. */
function flattenSelections(node: ShredNode, itemPrefix: string): string[] {
  const selections: string[] = [];

  for (const column of node.columns) {
    if (column.path.length === 0) continue;
    selections.push(`${pathExpr(itemPrefix, column.path)} AS ${quoteIdent(column.name)}`);
  }

  // A count column for each child list actually materialised.
  for (const child of node.children) {
    if (!child.listPath?.length) continue;
    const countColumn = node.table.columns.find(
      (c) => c.synthetic && c.name.endsWith('_count') && c.path.join('.') === child.listPath?.join('.'),
    );
    if (countColumn) {
      selections.push(`coalesce(len(${pathExpr(itemPrefix, child.listPath)}), 0) AS ${quoteIdent(countColumn.name)}`);
    }
  }

  // _raw carries exactly what was fetched, which is the escape hatch for anything the catalog
  // could not flatten (union members, fields below the depth limit).
  const topLevel = new Set<string>();
  for (const column of node.columns) {
    const head = column.path[0];
    if (head) topLevel.add(head);
  }
  for (const child of node.children) {
    const head = child.listPath?.[0];
    if (head) topLevel.add(head);
  }
  if (topLevel.size > 0) {
    const pairs = [...topLevel].map((key) => `${quoteLiteral(key)}: ${pathExpr(itemPrefix, [key])}`);
    selections.push(`to_json({${pairs.join(', ')}}) AS ${quoteIdent('_raw')}`);
  } else {
    selections.push(`NULL::JSON AS ${quoteIdent('_raw')}`);
  }

  selections.push(`${quoteIdent('_rowid')} AS ${quoteIdent('_rowid')}`);

  if (node.listPath) {
    selections.push(`${quoteIdent('_parent_rowid')} AS ${quoteIdent('_parent_rowid')}`);
    selections.push(`${quoteIdent('_index')} AS ${quoteIdent('_index')}`);
    const parentKey = node.table.columns.find((c) => c.synthetic && c.name.startsWith('_parent_') && c.name !== '_parent_rowid');
    if (parentKey) selections.push(`${quoteIdent('_parent_key')} AS ${quoteIdent(parentKey.name)}`);
  }

  return selections;
}

async function createNodeRelations(
  conn: DuckDBConnection,
  node: ShredNode,
  itemPrefix: string,
  created: { relation: string; rows: number }[],
): Promise<void> {
  // The flattening view over this node's raw table.
  const selections = flattenSelections(node, itemPrefix);
  await conn.run(
    `CREATE OR REPLACE TEMP VIEW ${quoteIdent(node.relation)} AS SELECT ${selections.join(', ')} FROM ${quoteIdent(rawName(node.relation))}`,
  );
  const countReader = await conn.runAndReadAll(`SELECT count(*) AS n FROM ${quoteIdent(node.relation)}`);
  const rows = Number((countReader.getRowObjectsJson()[0] as Record<string, unknown>)?.n ?? 0);
  created.push({ relation: node.relation, rows });

  // Each child list becomes its own raw table, unnested from this one.
  for (const child of node.children) {
    if (!child.listPath?.length) continue;
    const parentKeyColumn = child.table.columns.find(
      (c) => c.synthetic && c.name.startsWith('_parent_') && c.name !== '_parent_rowid',
    );
    const parentKeyName = parentKeyColumn ? parentKeyColumn.name.slice('_parent_'.length) : null;
    const parentKeyExpr =
      parentKeyName && node.table.columns.some((c) => c.name === parentKeyName && !c.synthetic)
        ? pathExpr(itemPrefix, node.table.columns.find((c) => c.name === parentKeyName)?.path ?? [parentKeyName])
        : 'NULL';

    // list_transform with an index lambda keeps each element's position, which UNNEST alone loses.
    const inner = [
      `${quoteIdent('_rowid')} AS ${quoteIdent('_parent_rowid')}`,
      `${parentKeyExpr} AS ${quoteIdent('_parent_key')}`,
      `unnest(list_transform(${pathExpr(itemPrefix, child.listPath)}, (x, i) -> {'v': x, 'i': i})) AS ${quoteIdent('_pair')}`,
    ].join(', ');

    await conn.run(
      `CREATE OR REPLACE TEMP TABLE ${quoteIdent(rawName(child.relation))} AS
       SELECT ${quoteIdent('_parent_rowid')},
              ${quoteIdent('_parent_key')},
              ${quoteIdent('_pair')}.i - 1 AS ${quoteIdent('_index')},
              row_number() OVER () - 1 AS ${quoteIdent('_rowid')},
              ${quoteIdent('_pair')}.v AS ${quoteIdent('__item')}
       FROM (SELECT ${inner} FROM ${quoteIdent(rawName(node.relation))}) s`,
    );

    await createNodeRelations(conn, child, quoteIdent('__item'), created);
  }
}

export async function shredTable(conn: DuckDBConnection, target: ShredTarget): Promise<ShredResult> {
  const warnings: string[] = [];
  const created: { relation: string; rows: number }[] = [];
  let degradedToText = false;

  const strictSpec = buildColumnsSpec(target, false);
  try {
    await conn.run(
      `CREATE OR REPLACE TEMP TABLE ${quoteIdent(rawName(target.relation))} AS ${readJsonSql(target.file, strictSpec, false)}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const looksLikeTypeMismatch = /JSON transform error|invalid .*format|Could not convert|Conversion Error|Malformed/i.test(message);
    if (!looksLikeTypeMismatch) {
      fail(
        'SHRED_FAILED',
        `Could not load the fetched rows for ${target.table.name} into DuckDB.`,
        message,
        'This is usually a type mismatch. Check the scalar type mapping on the connection.',
      );
    }
    // Re-read everything as text rather than either failing outright or silently nulling values:
    // the user keeps their data and gets told exactly what to fix.
    log.warn(`${target.relation}: strict types failed, re-reading as text`);
    degradedToText = true;
    const detail = message.split('\n').find((line) => /invalid|expected|Could not/i.test(line))?.trim();
    warnings.push(
      `${target.table.name} did not match its expected column types, so every column was read as text. ${detail ?? message.split('\n')[0]} Set the right DuckDB type for the offending scalar under the connection's scalar types, then re-run.`,
    );
    const textSpec = buildColumnsSpec(target, true);
    try {
      await conn.run(
        `CREATE OR REPLACE TEMP TABLE ${quoteIdent(rawName(target.relation))} AS ${readJsonSql(target.file, textSpec, false)}`,
      );
    } catch (retryErr) {
      fail(
        'SHRED_FAILED',
        `Could not load the fetched rows for ${target.table.name}, even as text.`,
        retryErr instanceof Error ? retryErr.message : retryErr,
      );
    }
  }

  // The flattening view selects by path and never names a type, so it needs no adjustment when
  // the raw table was re-read as text. Catalog column objects are shared and are never mutated.
  await createNodeRelations(conn, target, '', created);

  const rootRows = created.find((c) => c.relation === target.relation)?.rows ?? 0;
  return { relation: target.relation, rows: rootRows, created, warnings, degradedToText };
}

/** Drops every relation a shred created, used when a run finishes or is cancelled. */
export async function dropShredded(conn: DuckDBConnection, relations: string[]): Promise<void> {
  for (const relation of relations) {
    try {
      await conn.run(`DROP VIEW IF EXISTS ${quoteIdent(relation)}`);
      await conn.run(`DROP TABLE IF EXISTS ${quoteIdent(rawName(relation))}`);
    } catch (err) {
      log.debug(`could not drop ${relation}`, err);
    }
  }
}
