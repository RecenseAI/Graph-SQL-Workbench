import type { DuckDBConnection } from '@duckdb/node-api';
import type {
  Catalog,
  CatalogColumn,
  CatalogTable,
  ConnectionConfig,
  FetchPlanEntry,
  FetchStats,
  QueryResult,
  RunEvent,
} from '@gqlwb/shared';
import { prepass, type EngineOptions, type TableBinding } from '../sql/prepass.ts';
import { analyzeStatement, type StatementAnalysis } from '../sql/analyze.ts';
import { computePushdown, mergeArgs } from './pushdown.ts';
import { buildFetchDocument, type FetchSpec } from './document.ts';
import { fetchTable } from '../fetch/paginate.ts';
import { buildHeaders } from '../fetch/client.ts';
import { shredTable, type ShredNode, type ShredTarget } from '../duck/shred.ts';
import { executeStatement } from '../duck/results.ts';
import { installMacros } from '../duck/macros.ts';
import { quoteIdent } from '../duck/sql-util.ts';
import {
  assertSnapshotName,
  classifyStatement,
  describeTableQuery,
  dropSnapshot,
  getSession,
  getSnapshot,
  listSnapshots,
  recordSnapshot,
  showSettingsQuery,
  showSnapshotsQuery,
  showTablesQuery,
} from '../sql/statements.ts';
import { fail } from '../errors.ts';
import { logger } from '../log.ts';

const log = logger('planner');

export interface RunStatementOptions {
  connection: ConnectionConfig;
  catalog: Catalog;
  /** A single statement, without its trailing semicolon. */
  sql: string;
  index: number;
  runId: string;
  conn: DuckDBConnection;
  pageRows: number;
  pushdownOverride?: boolean;
  cacheOverride?: boolean;
  maxRowsOverride?: number;
  explain?: boolean;
  signal?: AbortSignal;
  emit: (event: RunEvent) => void;
  extraHeaders?: Record<string, string>;
}

/** A root fetch plus the child tables to unnest from it. */
interface RootPlan {
  binding: TableBinding;
  table: CatalogTable;
  columns: CatalogColumn[];
  children: ChildPlan[];
}

interface ChildPlan {
  binding: TableBinding;
  table: CatalogTable;
  columns: CatalogColumn[];
  /** Path from the parent row to this list. */
  listPath: string[];
  children: ChildPlan[];
}

const now = (): number => Date.now();

export async function runStatement(options: RunStatementOptions): Promise<QueryResult> {
  const started = now();
  const { catalog, connection, emit } = options;
  const session = getSession(connection.id);
  const warnings: string[] = [];
  const timings = { total: 0, plan: 0, fetch: 0, shred: 0, execute: 0 };

  await installMacros(options.conn);

  // 1. Statements the workbench answers itself.
  const special = classifyStatement(options.sql);
  if (special) {
    const result = await handleSpecial(special, options, session, warnings);
    if (result) {
      result.timings.total = now() - started;
      return result;
    }
  }

  // 2. Rewrite the GraphQL-argument syntax out of the SQL.
  const planStarted = now();
  const pre = prepass(
    options.sql,
    catalog.tables.map((t) => t.name),
  );
  warnings.push(...pre.warnings);

  // 3. No catalog tables means this is plain SQL over snapshots or literals.
  if (pre.bindings.length === 0) {
    const executeStarted = now();
    const stored = await executeStatement(options.conn, pre.sql, {
      pageRows: options.pageRows,
      ...(options.explain ? { explain: true } : {}),
    });
    timings.plan = executeStarted - planStarted;
    timings.execute = now() - executeStarted;
    timings.total = now() - started;
    return {
      runId: options.runId,
      index: options.index,
      sql: options.sql,
      kind: stored.command ? 'command' : 'select',
      resultId: stored.resultId,
      columns: stored.columns,
      rows: stored.rows,
      rowCount: stored.rowCount,
      offset: 0,
      ...(stored.message ? { message: stored.message } : {}),
      timings,
      plan: [],
      stats: [],
      ...(stored.explain ? { explain: stored.explain } : {}),
      warnings,
    };
  }

  // 4. Read the statement's shape, purely to fetch less.
  const analysis = analyzeStatement(
    pre.sql,
    pre.bindings.map((b) => b.relation),
  );
  if (!analysis.parsed) {
    warnings.push(
      `The statement could not be analysed for optimisation (${firstLine(analysis.parseError)}), so every column was fetched and no filter was pushed down. The results are still correct.`,
    );
  }

  // 5. Group bindings into root fetches with their child tables attached.
  const roots = buildRootPlans(pre.bindings, catalog, analysis, warnings);
  timings.plan = now() - planStarted;

  // 6. Build a fetch plan for each root, then emit it before any network traffic.
  const planEntries: FetchPlanEntry[] = [];
  const specs = new Map<string, { spec: FetchSpec; plan: ReturnType<typeof buildFetchDocument>; maxRows: number; useCache: boolean }>();

  for (const root of roots) {
    const options_ = resolveEngineOptions(root.binding.options, pre.options, session, connection, options);
    const pushdownEnabled = options.pushdownOverride ?? session.pushdown;
    const pushdown = computePushdown({
      table: root.table,
      predicates: analysis.predicates.get(root.binding.relation) ?? [],
      connection,
      explicitArgs: root.binding.args,
      enabled: pushdownEnabled,
    });

    const args = mergeArgs(root.binding.args, pushdown.args);

    // A LIMIT can be sent upstream only when nothing above the table could change which rows win.
    let maxRows = options_.maxRows;
    const limitPush = analysis.pushableLimit;
    if (limitPush && limitPush.relation === root.binding.relation && root.table.pagination.style !== 'none') {
      maxRows = Math.min(maxRows, limitPush.rows);
    }

    // `users(first: 120)` reads as "the first 120 users", and `orders(limit: 50)` as "50 orders".
    // Treating those as a page size only -- and then paging past them -- would quietly return far
    // more rows than the statement asked for. So an explicit row-count argument caps the fetch,
    // unless @allPages says otherwise.
    const rowCountArg =
      root.table.pagination.style === 'relay'
        ? root.table.pagination.firstArg
        : root.table.pagination.style === 'offset'
          ? root.table.pagination.limitArg
          : undefined;
    if (rowCountArg && root.binding.options.allPages !== true) {
      const explicit = root.binding.args[rowCountArg];
      if (typeof explicit === 'number' && explicit > 0) maxRows = Math.min(maxRows, explicit);
    }

    const projection = root.columns.filter((c) => c.path.length > 0).map((c) => c.path);
    const childPaths = collectChildPaths(root.children, []);

    const spec: FetchSpec = {
      table: root.table,
      alias: safeAlias(root.binding.relation),
      args,
      projection,
      childPaths,
      pageSize: options_.pageSize,
    };
    const documentPlan = buildFetchDocument(spec);

    const entry: FetchPlanEntry = {
      table: root.table.name,
      alias: root.binding.relation,
      rootField: root.table.rootField,
      args,
      explicitArgs: root.binding.args,
      pushed: pushdown.pushed,
      skipped: pushdown.skipped,
      projected: projection.map((p) => p.join('.')),
      pagination: root.table.pagination.style,
      maxRows,
      pageSize: options_.pageSize,
      document: documentPlan.document,
      variables: documentPlan.variables,
      childTables: flattenChildren(root.children).map((c) => c.table.name),
      cacheKey: '',
    };
    planEntries.push(entry);
    specs.set(root.binding.relation, { spec, plan: documentPlan, maxRows, useCache: options_.useCache });
  }

  emit({ type: 'plan', index: options.index, plan: planEntries });

  // 7. Fetch, then shred, one root at a time so progress is meaningful.
  const stats: FetchStats[] = [];
  const fetchStarted = now();
  let shredMs = 0;

  for (const root of roots) {
    const entryIndex = roots.indexOf(root);
    const prepared = specs.get(root.binding.relation);
    const entry = planEntries[entryIndex];
    if (!prepared || !entry) continue;

    // The document plus its starting variables already encode the arguments, the projection, the
    // child selections and the page size, so keying on those makes two statements that send the
    // identical request share one fetch -- which is exactly when reuse is safe.
    const cacheKeyParts = [
      connection.endpoint,
      // Headers decide what the endpoint returns just as much as the URL does: a branch header
      // on a Dolt-backed server, a tenant header, or a different user's token. They are part of
      // the key (hashed with everything else, never stored in clear), so two connections to one
      // URL can never be served each other's rows.
      buildHeaders(connection),
      catalog.schemaHash,
      prepared.plan.document,
      prepared.plan.variables,
      prepared.maxRows,
    ];

    const fetched = await fetchTable({
      conn: connection,
      spec: prepared.spec,
      plan: prepared.plan,
      maxRows: prepared.maxRows,
      useCache: prepared.useCache,
      cacheKeyParts,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.extraHeaders ? { extraHeaders: options.extraHeaders } : {}),
      onProgress: (info) =>
        emit({
          type: 'fetch',
          index: options.index,
          table: root.table.name,
          pages: info.pages,
          rows: info.rows,
          done: info.done,
        }),
    });
    warnings.push(...fetched.warnings);
    entry.cacheKey = fetched.file;

    const shredStarted = now();
    const target: ShredTarget = {
      ...toShredNode(root),
      file: fetched.file,
    };
    const shredded = await shredTable(options.conn, target);
    shredMs += now() - shredStarted;
    warnings.push(...shredded.warnings);

    for (const created of shredded.created) {
      emit({ type: 'shred', index: options.index, table: created.relation, rows: created.rows });
    }

    stats.push({
      table: root.table.name,
      pages: fetched.pages,
      rows: fetched.rowCount,
      bytes: fetched.bytes,
      ms: fetched.ms,
      cache: fetched.cache,
      truncated: fetched.truncated,
      requests: fetched.requests,
      retries: fetched.retries,
    });
  }
  timings.fetch = now() - fetchStarted - shredMs;
  timings.shred = shredMs;

  // 8. Run the user's SQL against the shredded relations.
  emit({ type: 'executing', index: options.index });
  const executeStarted = now();
  const stored = await executeStatement(options.conn, pre.sql, {
    pageRows: options.pageRows,
    ...(options.explain ? { explain: true } : {}),
  });
  timings.execute = now() - executeStarted;
  timings.total = now() - started;

  return {
    runId: options.runId,
    index: options.index,
    sql: options.sql,
    kind: stored.command ? 'command' : 'select',
    resultId: stored.resultId,
    columns: stored.columns,
    rows: stored.rows,
    rowCount: stored.rowCount,
    offset: 0,
    ...(stored.message ? { message: stored.message } : {}),
    timings,
    plan: planEntries,
    stats,
    ...(stored.explain ? { explain: stored.explain } : {}),
    warnings,
  };
}

/* --------------------------------------------------------------- plan building */

function firstLine(text: string | undefined): string {
  return (text ?? 'unknown reason').split('\n')[0]?.trim() ?? 'unknown reason';
}

/** GraphQL aliases must be valid names, and relation names can contain characters they cannot. */
function safeAlias(relation: string): string {
  const cleaned = relation.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `wb_${cleaned}`;
}

function resolveEngineOptions(
  tableOptions: EngineOptions,
  statementOptions: EngineOptions,
  session: { maxRows?: number; pageSize?: number; cache: boolean },
  connection: ConnectionConfig,
  run: RunStatementOptions,
): { maxRows: number; pageSize: number; useCache: boolean } {
  const maxRows =
    tableOptions.allPages === true
      ? connection.maxRows * 1000
      : (tableOptions.maxRows ??
        run.maxRowsOverride ??
        statementOptions.maxRows ??
        session.maxRows ??
        connection.maxRows);
  const pageSize = tableOptions.pageSize ?? statementOptions.pageSize ?? session.pageSize ?? connection.pageSize;
  const useCache = tableOptions.cache ?? run.cacheOverride ?? session.cache;
  return { maxRows, pageSize, useCache };
}

/**
 * Resolves each binding to a root fetch. A child table is not fetchable on its own -- it is
 * unnested from its parent's payload -- so a reference to one is attached to the parent's fetch,
 * creating that fetch implicitly if the statement did not mention it.
 */
function buildRootPlans(
  bindings: TableBinding[],
  catalog: Catalog,
  analysis: StatementAnalysis,
  warnings: string[],
): RootPlan[] {
  const byName = new Map(catalog.tables.map((t) => [t.name.toLowerCase(), t]));
  const roots: RootPlan[] = [];
  const rootByRelation = new Map<string, RootPlan>();
  const childBindings: TableBinding[] = [];

  for (const binding of bindings) {
    const table = byName.get(binding.table.toLowerCase());
    if (!table) continue;
    if (table.isChild) {
      childBindings.push(binding);
      continue;
    }
    const plan: RootPlan = {
      binding,
      table,
      columns: resolveColumns(table, analysis.columns.get(binding.relation)),
      children: [],
    };
    roots.push(plan);
    rootByRelation.set(binding.relation, plan);
  }

  for (const binding of childBindings) {
    const table = byName.get(binding.table.toLowerCase());
    if (!table) continue;
    if (binding.explicit && Object.keys(binding.args).length > 0) {
      fail(
        'BAD_REQUEST',
        `${table.name} is a nested table, so it cannot take its own arguments.`,
        undefined,
        `Put the arguments on ${rootAncestorName(table, byName)} instead, which is where the data is fetched.`,
      );
    }

    // Walk up to the root, remembering the path of list fields to unnest.
    const chain: CatalogTable[] = [];
    let current: CatalogTable | undefined = table;
    while (current?.isChild) {
      chain.unshift(current);
      current = current.parent ? byName.get(current.parent.toLowerCase()) : undefined;
    }
    if (!current) {
      warnings.push(`Could not work out where ${table.name} comes from, so it was skipped.`);
      continue;
    }
    const rootTable = current;

    const candidates = roots.filter((r) => r.table.name === rootTable.name);
    let root = candidates[0];
    if (candidates.length > 1) {
      fail(
        'BAD_REQUEST',
        `${table.name} could come from more than one ${rootTable.name} fetch in this statement.`,
        undefined,
        `Give each ${rootTable.name} the same arguments, or query ${table.name} in a separate statement.`,
      );
    }
    if (!root) {
      // The statement joined to a child without mentioning the parent; fetch the parent anyway.
      const implicitBinding: TableBinding = {
        relation: rootTable.name,
        table: rootTable.name,
        args: {},
        options: {},
        references: 0,
        explicit: false,
      };
      root = {
        binding: implicitBinding,
        table: rootTable,
        columns: resolveColumns(rootTable, analysis.columns.get(rootTable.name)),
        children: [],
      };
      roots.push(root);
      rootByRelation.set(rootTable.name, root);
    }

    // Attach the chain under the root, reusing nodes already created for shared ancestors.
    let parentChildren = root.children;
    let parentTable = root.table;
    for (const link of chain) {
      const existing = parentChildren.find((c) => c.table.name === link.name);
      if (existing) {
        parentChildren = existing.children;
        parentTable = existing.table;
        continue;
      }
      const listPath = relativeListPath(link, parentTable);
      const node: ChildPlan = {
        binding,
        table: link,
        columns: resolveColumns(link, analysis.columns.get(link.name === table.name ? binding.relation : link.name)),
        listPath,
        children: [],
      };
      parentChildren.push(node);
      parentChildren = node.children;
      parentTable = link;
    }
  }

  // A parent that only exists to carry a child still needs the list selected, which happens via
  // childPaths, plus enough of its own columns to make a valid selection.
  for (const root of roots) {
    if (root.columns.length === 0 && root.children.length > 0) {
      const pk = root.table.columns.find((c) => c.name === root.table.primaryKey);
      if (pk) root.columns = [pk];
    }
    // Referencing a child's count column requires the list itself.
    ensureCountedChildren(root, analysis, warnings);
  }

  return roots;
}

function rootAncestorName(table: CatalogTable, byName: Map<string, CatalogTable>): string {
  let current: CatalogTable | undefined = table;
  while (current?.isChild && current.parent) current = byName.get(current.parent.toLowerCase());
  return current?.name ?? table.name;
}

/** The list path of a child relative to its immediate parent's row root. */
function relativeListPath(child: CatalogTable, parent: CatalogTable): string[] {
  const childPath = child.parentPath ?? [];
  if (!parent.isChild) return childPath;
  const parentPath = parent.parentPath ?? [];
  // Catalog paths are relative to the immediate parent already, so nothing to strip.
  void parentPath;
  return childPath;
}

/** Turns the analysis's column set into real catalog columns. */
function resolveColumns(table: CatalogTable, referenced: Set<string> | '*' | undefined): CatalogColumn[] {
  const selectable = table.columns.filter((c) => !c.synthetic);
  if (referenced === undefined) return [];
  if (referenced === '*') return selectable;

  const wanted = new Set([...referenced].map((name) => name.toLowerCase()));
  // _raw is built from whatever was fetched, so asking for it means asking for everything.
  if (wanted.has('_raw')) return selectable;

  const resolved = selectable.filter((c) => wanted.has(c.name.toLowerCase()));
  return resolved;
}

/** If the SQL uses `<list>_count`, the list has to be fetched even if the child table is not. */
function ensureCountedChildren(root: RootPlan, analysis: StatementAnalysis, warnings: string[]): void {
  const referenced = analysis.columns.get(root.binding.relation);
  if (referenced === undefined) return;
  const names = referenced === '*' ? new Set(root.table.columns.map((c) => c.name.toLowerCase())) : new Set([...referenced].map((n) => n.toLowerCase()));

  for (const countColumn of root.table.columns) {
    if (!countColumn.synthetic || !countColumn.name.endsWith('_count')) continue;
    if (!names.has(countColumn.name.toLowerCase())) continue;
    const already = root.children.some((c) => (c.listPath ?? []).join('.') === countColumn.path.join('.'));
    if (already) continue;
    warnings.push(
      `${countColumn.name} needs ${root.table.name}.${countColumn.path.join('.')} to be fetched, which adds to the payload.`,
    );
    // The list has to appear in the document; one leaf is enough to count it.
    root.children.push({
      binding: root.binding,
      table: syntheticCountTable(root, countColumn),
      columns: [],
      listPath: countColumn.path,
      children: [],
    });
  }
}

/**
 * A placeholder table used only so a count column's list gets selected. It materialises as a
 * relation nobody queries, which costs one unnest and keeps the code path uniform.
 */
function syntheticCountTable(root: RootPlan, countColumn: CatalogColumn): CatalogTable {
  const childName = `${root.table.name}__${countColumn.path.join('_')}`;
  return {
    name: childName,
    rootField: root.table.rootField,
    rowTypeName: countColumn.graphqlTypeName,
    pagination: { style: 'none', nodesPath: [], defaultPageSize: 1 },
    columns: [],
    args: [],
    childTables: [],
    isChild: true,
    parent: root.table.name,
    parentPath: countColumn.path,
    parentKeyColumn: '_parent_rowid',
    parentRefColumn: '_rowid',
  };
}

function collectChildPaths(children: ChildPlan[], prefix: string[]): string[][] {
  const paths: string[][] = [];
  for (const child of children) {
    const base = [...prefix, ...child.listPath];
    if (child.columns.length === 0 && child.children.length === 0) {
      // Nothing specific is needed, but the list must still appear in the document.
      paths.push([...base, '__typename']);
      continue;
    }
    for (const column of child.columns) {
      if (column.path.length === 0) continue;
      paths.push([...base, ...column.path]);
    }
    paths.push(...collectChildPaths(child.children, base));
  }
  return paths;
}

function flattenChildren(children: ChildPlan[]): ChildPlan[] {
  return children.flatMap((child) => [child, ...flattenChildren(child.children)]);
}

function toShredNode(root: RootPlan): ShredNode {
  return {
    relation: root.binding.relation,
    table: root.table,
    columns: root.columns,
    children: root.children.map(toShredChild),
  };
}

function toShredChild(child: ChildPlan): ShredNode {
  return {
    relation: child.table.name,
    table: child.table,
    columns: child.columns,
    listPath: child.listPath,
    children: child.children.map(toShredChild),
  };
}

/* ------------------------------------------------------------ special statements */

async function handleSpecial(
  special: NonNullable<ReturnType<typeof classifyStatement>>,
  options: RunStatementOptions,
  session: ReturnType<typeof getSession>,
  warnings: string[],
): Promise<QueryResult | null> {
  const { catalog, connection } = options;
  const base = {
    runId: options.runId,
    index: options.index,
    sql: options.sql,
    offset: 0,
    timings: { total: 0, plan: 0, fetch: 0, shred: 0, execute: 0 },
    plan: [] as FetchPlanEntry[],
    stats: [] as FetchStats[],
    warnings,
  };

  const asRows = async (sql: string): Promise<QueryResult> => {
    const stored = await executeStatement(options.conn, sql, { pageRows: options.pageRows, withStats: false });
    return {
      ...base,
      kind: 'select',
      resultId: stored.resultId,
      columns: stored.columns,
      rows: stored.rows,
      rowCount: stored.rowCount,
    };
  };

  switch (special.kind) {
    case 'set': {
      if (special.setting === 'pushdown' || special.setting === 'cache') {
        session[special.setting] = special.value as boolean;
      } else {
        session[special.setting] = special.value as number;
      }
      return { ...base, kind: 'command', resultId: '', columns: [], rows: [], rowCount: 0, message: special.message };
    }
    case 'show-tables':
      return asRows(showTablesQuery(catalog));
    case 'describe':
      return asRows(describeTableQuery(catalog, special.table));
    case 'show-settings':
      return asRows(
        showSettingsQuery(session, {
          maxRows: connection.maxRows,
          pageSize: connection.pageSize,
          depth: connection.maxDepth,
        }),
      );
    case 'show-snapshots':
      return asRows(showSnapshotsQuery(await listSnapshots(options.conn)));
    case 'drop-snapshot': {
      const dropped = await dropSnapshot(options.conn, special.name);
      return {
        ...base,
        kind: 'command',
        resultId: '',
        columns: [],
        rows: [],
        rowCount: 0,
        message: dropped ? `Snapshot ${special.name} dropped.` : `There is no snapshot called ${special.name}.`,
      };
    }
    case 'materialize': {
      assertSnapshotName(special.name, catalog);
      return materialize(special.tableExpr, special.name, options, warnings);
    }
    case 'refresh': {
      const existing = await getSnapshot(options.conn, special.name);
      if (!existing) {
        fail(
          'NOT_FOUND',
          `There is no snapshot called ${special.name}.`,
          undefined,
          'Run SHOW SNAPSHOTS to see what is available.',
        );
      }
      return materialize(existing.tableExpr, existing.name, options, warnings);
    }
    default:
      return null;
  }
}

/**
 * Fetches a table and pins it as a real DuckDB table, so later statements can query it with the
 * endpoint unreachable. This is what makes an expensive fetch reusable across sessions.
 */
async function materialize(
  tableExpr: string,
  name: string,
  options: RunStatementOptions,
  warnings: string[],
): Promise<QueryResult> {
  const started = now();
  // Reuse the whole pipeline by running the equivalent SELECT.
  const inner = await runStatement({
    ...options,
    sql: `SELECT * FROM ${tableExpr}`,
    // The snapshot's own result is not shown, so there is no need to page it.
    pageRows: 1,
    explain: false,
    emit: options.emit,
  });

  if (!inner.resultId) {
    fail('EXECUTE_FAILED', `MATERIALIZE could not read from ${tableExpr}.`);
  }

  await options.conn.run(
    `CREATE OR REPLACE TABLE ${quoteIdent(name)} AS SELECT * FROM ${quoteIdent('wb_results')}.${quoteIdent(inner.resultId)}`,
  );
  const countReader = await options.conn.runAndReadAll(`SELECT count(*) AS n FROM ${quoteIdent(name)}`);
  const rowCount = Number((countReader.getRowObjectsJson()[0] as Record<string, unknown>)?.n ?? 0);

  await recordSnapshot(options.conn, {
    name,
    connectionId: options.connection.id,
    tableName: tableExpr,
    tableExpr,
    rowCount,
  });

  log.info(`materialised ${name} with ${rowCount} rows from ${tableExpr}`);

  return {
    runId: options.runId,
    index: options.index,
    sql: options.sql,
    kind: 'command',
    resultId: '',
    columns: [],
    rows: [],
    rowCount: 0,
    offset: 0,
    message: `Snapshot ${name} now holds ${rowCount.toLocaleString('en-US')} rows from ${tableExpr}. It queries without touching the endpoint.`,
    timings: { ...inner.timings, total: now() - started },
    plan: inner.plan,
    stats: inner.stats,
    warnings: [...warnings, ...inner.warnings],
  };
}
