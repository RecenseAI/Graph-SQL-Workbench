// node-sql-parser is CommonJS with no named ESM exports, so the class comes off the default.
// Vite's interop hides this; plain Node does not, and the server runs on plain Node.
import sqlParser from 'node-sql-parser';

const { Parser } = sqlParser;
import type { PushdownOp } from '@gqlwb/shared';
import { logger } from '../log.ts';

const log = logger('sql');

/**
 * Reads the shape of a statement so the planner can fetch less.
 *
 * Everything this module produces is an optimisation: which columns to project, which predicates
 * are candidates for pushdown, whether a LIMIT can be sent upstream. If parsing fails -- and it
 * will, because DuckDB's dialect is wider than any third-party parser -- the analysis degrades to
 * "fetch every column, push nothing", which is slower but never wrong. Table identity never comes
 * from here; the pre-pass already established it.
 */

export interface ExtractedPredicate {
  /** Column name as written in the SQL. */
  column: string;
  op: PushdownOp;
  value: unknown;
}

export interface StatementAnalysis {
  parsed: boolean;
  parseError?: string;
  /** Relation name -> referenced columns, or '*' when everything is needed. */
  columns: Map<string, Set<string> | '*'>;
  /** Relation name -> predicates safe to consider for pushdown. */
  predicates: Map<string, ExtractedPredicate[]>;
  /** A row limit that can be sent upstream, when doing so cannot change the answer. */
  pushableLimit: { relation: string; rows: number } | null;
  /** Relations that appear on the nullable side of an outer join. */
  outerNullable: Set<string>;
  /** True when the statement aggregates, windows or groups -- which blocks LIMIT pushdown. */
  aggregates: boolean;
}

const AGGREGATE_NAMES = new Set([
  'count', 'sum', 'avg', 'min', 'max', 'median', 'mode', 'stddev', 'stddev_pop', 'stddev_samp',
  'variance', 'var_pop', 'var_samp', 'string_agg', 'group_concat', 'array_agg', 'list', 'histogram',
  'bool_and', 'bool_or', 'first', 'last', 'any_value', 'approx_count_distinct', 'quantile',
  'quantile_cont', 'quantile_disc', 'corr', 'covar_pop', 'entropy', 'kurtosis', 'skewness',
  'product', 'bit_and', 'bit_or', 'bit_xor', 'arg_min', 'arg_max',
]);

const OPERATOR_MAP: Record<string, PushdownOp> = {
  '=': 'eq',
  '!=': 'ne',
  '<>': 'ne',
  '>': 'gt',
  '>=': 'gte',
  '<': 'lt',
  '<=': 'lte',
  in: 'in',
  'not in': 'nin',
  like: 'like',
  ilike: 'ilike',
};

type Node = Record<string, unknown>;

const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null;

/** Depth-first walk over every object in the AST. */
function walk(node: unknown, visit: (node: Node) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (!isNode(node)) return;
  visit(node);
  for (const value of Object.values(node)) walk(value, visit);
}

/**
 * node-sql-parser represents a column reference's parts as nested nodes, not strings, and the
 * exact nesting differs between forms (`id`, `o.total`, `u.*`). These two readers cope with all of
 * them so the rest of the module can deal in plain names.
 */
function readColumnName(node: Node): string | null {
  const column = node.column;
  if (typeof column === 'string') return column;
  if (isNode(column)) {
    const expr = column.expr;
    if (isNode(expr) && typeof expr.value === 'string') return expr.value;
    if (typeof column.value === 'string') return column.value;
  }
  return null;
}

function readTableName(node: Node): string | null {
  const table = node.table;
  if (typeof table === 'string') return table;
  if (isNode(table) && typeof table.value === 'string') return table.value;
  return null;
}

interface FromItem {
  relation: string;
  alias: string;
  /** Join type as reported by the parser, e.g. LEFT JOIN. */
  join?: string;
}

function collectFromItems(ast: unknown): FromItem[] {
  const items: FromItem[] = [];
  walk(ast, (node) => {
    if (!Array.isArray(node.from)) return;
    for (const entry of node.from as unknown[]) {
      if (!isNode(entry)) continue;
      const tableName = typeof entry.table === 'string' ? entry.table : null;
      if (!tableName) continue;
      const alias = typeof entry.as === 'string' && entry.as ? entry.as : tableName;
      const item: FromItem = { relation: tableName, alias };
      if (typeof entry.join === 'string') item.join = entry.join;
      items.push(item);
    }
  });
  return items;
}

/**
 * Relations whose rows can be null-extended by an outer join. A predicate on such a relation
 * cannot be pushed: filtering it upstream would remove rows the join is supposed to keep.
 */
function collectOuterNullable(items: FromItem[]): Set<string> {
  const nullable = new Set<string>();
  for (const item of items) {
    const join = item.join?.toUpperCase() ?? '';
    if (join.includes('LEFT')) nullable.add(item.relation);
    if (join.includes('RIGHT') || join.includes('FULL')) {
      // A RIGHT or FULL join can null-extend either side, so nothing here is safe.
      for (const other of items) nullable.add(other.relation);
    }
  }
  return nullable;
}

function literalValue(node: Node): { ok: true; value: unknown } | { ok: false } {
  const type = node.type;
  if (type === 'number' || type === 'bool') return { ok: true, value: node.value };
  if (type === 'single_quote_string' || type === 'string' || type === 'double_quote_string') {
    return { ok: true, value: node.value };
  }
  if (type === 'null') return { ok: true, value: null };
  if (type === 'expr_list' && Array.isArray(node.value)) {
    const values: unknown[] = [];
    for (const item of node.value as unknown[]) {
      if (!isNode(item)) return { ok: false };
      const inner = literalValue(item);
      if (!inner.ok) return { ok: false };
      values.push(inner.value);
    }
    return { ok: true, value: values };
  }
  return { ok: false };
}

/** Splits a WHERE clause into its top-level AND-ed terms. Anything under OR or NOT is dropped. */
function andTerms(node: unknown, out: Node[]): void {
  if (!isNode(node)) return;
  if (node.type === 'binary_expr' && typeof node.operator === 'string' && node.operator.toUpperCase() === 'AND') {
    andTerms(node.left, out);
    andTerms(node.right, out);
    return;
  }
  out.push(node);
}

export function analyzeStatement(sql: string, knownRelations: Iterable<string>): StatementAnalysis {
  const relations = new Set<string>();
  for (const name of knownRelations) relations.add(name.toLowerCase());

  const analysis: StatementAnalysis = {
    parsed: false,
    columns: new Map(),
    predicates: new Map(),
    pushableLimit: null,
    outerNullable: new Set(),
    aggregates: false,
  };

  let ast: unknown;
  try {
    const parser = new Parser();
    ast = parser.astify(sql, { database: 'postgresql' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    analysis.parseError = message;
    log.debug(`falling back to full projection: ${message.split('\n')[0]}`);
    // Without a parse there is no pruning and no pushdown, but the answer is still correct.
    for (const relation of knownRelations) analysis.columns.set(relation, '*');
    return analysis;
  }

  analysis.parsed = true;
  const items = collectFromItems(ast);
  analysis.outerNullable = collectOuterNullable(items);

  // alias -> relation, plus each relation mapping to itself.
  const aliasToRelation = new Map<string, string>();
  for (const item of items) {
    if (!relations.has(item.relation.toLowerCase())) continue;
    aliasToRelation.set(item.alias.toLowerCase(), item.relation);
    aliasToRelation.set(item.relation.toLowerCase(), item.relation);
  }

  const relationsInStatement = [...new Set(items.filter((i) => relations.has(i.relation.toLowerCase())).map((i) => i.relation))];

  const addColumn = (relation: string, column: string | '*'): void => {
    const existing = analysis.columns.get(relation);
    if (existing === '*') return;
    if (column === '*') {
      analysis.columns.set(relation, '*');
      return;
    }
    if (existing) existing.add(column);
    else analysis.columns.set(relation, new Set([column]));
  };

  // Aggregates, windows, grouping and DISTINCT all mean a LIMIT cannot be pushed upstream.
  walk(ast, (node) => {
    if (node.type === 'aggr_func' || node.type === 'window_func') analysis.aggregates = true;
    // `over` is present but null on ordinary function calls, so only a real window clause counts.
    if (isNode(node.over)) analysis.aggregates = true;
    if (node.type === 'function' && isNode(node.name)) {
      const nameNode = node.name as Node;
      const parts = Array.isArray(nameNode.name) ? (nameNode.name as Node[]) : [];
      const fnName = parts.map((p) => String(p.value ?? '')).join('.').toLowerCase();
      if (AGGREGATE_NAMES.has(fnName)) analysis.aggregates = true;
    }
    // GROUP BY appears either as an array or as { columns: [...] } depending on the version.
    if (Array.isArray(node.groupby) && node.groupby.length > 0) analysis.aggregates = true;
    if (isNode(node.groupby) && Array.isArray(node.groupby.columns) && node.groupby.columns.length > 0) {
      analysis.aggregates = true;
    }
    // `distinct` is always an object; only a non-null type means DISTINCT was written.
    if (isNode(node.distinct) && node.distinct.type) analysis.aggregates = true;
  });

  // Column references, resolved through aliases where possible.
  walk(ast, (node) => {
    if (node.type !== 'column_ref') return;
    const rawTable = readTableName(node);
    const rawColumn = readColumnName(node);
    if (!rawColumn) return;

    if (rawTable) {
      const relation = aliasToRelation.get(rawTable.toLowerCase());
      if (relation) addColumn(relation, rawColumn === '*' ? '*' : rawColumn);
      return;
    }
    // An unqualified column could belong to any relation in scope. Attributing it to all of them
    // over-fetches slightly, which is the safe direction.
    for (const relation of relationsInStatement) addColumn(relation, rawColumn === '*' ? '*' : rawColumn);
  });

  // A bare `SELECT *` shows up without a column_ref in some parser versions.
  walk(ast, (node) => {
    if (!Array.isArray(node.columns)) return;
    for (const entry of node.columns as unknown[]) {
      if (entry === '*') {
        for (const relation of relationsInStatement) addColumn(relation, '*');
      }
    }
  });

  // Any relation referenced but never with a column still needs a valid selection.
  for (const relation of relationsInStatement) {
    if (!analysis.columns.has(relation)) analysis.columns.set(relation, new Set());
  }

  // Predicates from the outermost WHERE only.
  const root = Array.isArray(ast) ? ast[0] : ast;
  if (isNode(root) && isNode(root.where)) {
    const terms: Node[] = [];
    andTerms(root.where, terms);
    for (const term of terms) {
      if (term.type !== 'binary_expr') continue;
      const operator = typeof term.operator === 'string' ? term.operator.toLowerCase() : '';
      const left = isNode(term.left) ? term.left : null;
      const right = isNode(term.right) ? term.right : null;
      if (!left || !right) continue;

      // IS NULL / IS NOT NULL
      if (operator === 'is' && left.type === 'column_ref' && right.type === 'null') {
        const target = resolveColumnTarget(left, aliasToRelation, relationsInStatement);
        if (target) pushPredicate(analysis, target.relation, { column: target.column, op: 'isNull', value: true });
        continue;
      }

      const mapped = OPERATOR_MAP[operator];
      if (!mapped) continue;

      if (left.type === 'column_ref') {
        const value = literalValue(right);
        if (!value.ok) continue;
        const target = resolveColumnTarget(left, aliasToRelation, relationsInStatement);
        if (target) pushPredicate(analysis, target.relation, { column: target.column, op: mapped, value: value.value });
        continue;
      }
      // Reversed form: 100 < o.total
      if (right.type === 'column_ref') {
        const value = literalValue(left);
        if (!value.ok) continue;
        const flipped: Record<string, PushdownOp> = { gt: 'lt', gte: 'lte', lt: 'gt', lte: 'gte', eq: 'eq', ne: 'ne' };
        const op = flipped[mapped];
        if (!op) continue;
        const target = resolveColumnTarget(right, aliasToRelation, relationsInStatement);
        if (target) pushPredicate(analysis, target.relation, { column: target.column, op, value: value.value });
      }
    }
  }

  // LIMIT pushdown, only when it cannot change the answer.
  if (
    isNode(root) &&
    relationsInStatement.length === 1 &&
    items.length === 1 &&
    !analysis.aggregates &&
    analysis.outerNullable.size === 0
  ) {
    const limit = extractLimit(root);
    const relation = relationsInStatement[0];
    if (limit !== null && relation) analysis.pushableLimit = { relation, rows: limit };
  }

  return analysis;
}

function resolveColumnTarget(
  node: Node,
  aliasToRelation: Map<string, string>,
  relationsInStatement: string[],
): { relation: string; column: string } | null {
  const column = readColumnName(node);
  if (!column) return null;
  const rawTable = readTableName(node);
  if (rawTable) {
    const relation = aliasToRelation.get(rawTable.toLowerCase());
    return relation ? { relation, column } : null;
  }
  // Unqualified: only safe when there is exactly one relation it could belong to.
  const only = relationsInStatement[0];
  if (relationsInStatement.length === 1 && only) return { relation: only, column };
  return null;
}

function pushPredicate(analysis: StatementAnalysis, relation: string, predicate: ExtractedPredicate): void {
  // A predicate on an outer-joined relation must stay local.
  if (analysis.outerNullable.has(relation)) return;
  const list = analysis.predicates.get(relation);
  if (list) list.push(predicate);
  else analysis.predicates.set(relation, [predicate]);
}

function extractLimit(root: Node): number | null {
  const limit = root.limit;
  if (!isNode(limit)) return null;

  // node-sql-parser reports LIMIT either as a value list or as separate seperator-based fields.
  const values = Array.isArray(limit.value) ? (limit.value as unknown[]) : [];
  const numbers = values
    .map((entry) => (isNode(entry) && typeof entry.value === 'number' ? entry.value : null))
    .filter((n): n is number => n !== null);

  if (numbers.length === 0) return null;
  if (numbers.length === 1) return numbers[0] ?? null;
  // LIMIT a, b or LIMIT b OFFSET a: fetch enough rows to cover the offset.
  const [first = 0, second = 0] = numbers;
  const separator = typeof limit.seperator === 'string' ? limit.seperator.toLowerCase() : '';
  return separator === 'offset' ? first + second : first + second;
}
