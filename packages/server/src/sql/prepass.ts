import { parse, valueFromASTUntyped, type FieldNode, type OperationDefinitionNode } from 'graphql';
import { significant, tokenize, type Token } from './lexer.ts';
import { fail } from '../errors.ts';

/**
 * The pre-pass turns the workbench's SQL extension back into ordinary SQL.
 *
 *   FROM users(first: 500, role: ADMIN, @maxRows: 20000) u
 *
 * becomes `FROM users u`, with the GraphQL arguments and engine options recorded for the planner.
 * Arguments are written in GraphQL literal syntax on purpose: anyone who can read the endpoint's
 * docs can write them without learning a second spelling, and they are parsed by graphql-js
 * itself rather than by a hand-rolled approximation.
 *
 * Two references to the same table with different arguments are two different fetches, so each
 * distinct argument set gets its own DuckDB relation.
 */

export interface EngineOptions {
  /** Row budget for this table, overriding the connection default. */
  maxRows?: number;
  /** Rows per GraphQL page. */
  pageSize?: number;
  /** Ignore the row budget and page until the endpoint says there is no more. */
  allPages?: boolean;
  /** Opt this fetch in or out of the cache. */
  cache?: boolean;
  /** Nesting depth for column flattening. */
  depth?: number;
}

export interface TableBinding {
  /** The relation name the rewritten SQL uses. */
  relation: string;
  /** Catalog table name, as spelled in the catalog. */
  table: string;
  args: Record<string, unknown>;
  options: EngineOptions;
  /** How many times this binding appears in the statement. */
  references: number;
  /** True when the user wrote an argument list at least once for this binding. */
  explicit: boolean;
}

export interface PrepassResult {
  /** Plain SQL, safe to hand to a parser and to DuckDB. */
  sql: string;
  bindings: TableBinding[];
  /** Options that apply to the whole statement. */
  options: EngineOptions;
  warnings: string[];
  cteNames: string[];
}

/** Keywords that end a FROM list. */
const FROM_LIST_TERMINATORS = new Set([
  'where', 'group', 'having', 'order', 'limit', 'offset', 'window', 'qualify',
  'union', 'except', 'intersect', 'select', 'on', 'using', 'returning', 'set',
  'values', 'fetch', 'for',
]);

const JOIN_WORDS = new Set(['join']);

const OPTION_SPECS: Record<string, 'int' | 'bool'> = {
  maxrows: 'int',
  pagesize: 'int',
  depth: 'int',
  allpages: 'bool',
  cache: 'bool',
};

const OPTION_KEYS: Record<string, keyof EngineOptions> = {
  maxrows: 'maxRows',
  pagesize: 'pageSize',
  depth: 'depth',
  allpages: 'allPages',
  cache: 'cache',
};

interface Candidate {
  /** Source span to replace, covering the name and any argument list. */
  start: number;
  end: number;
  table: string;
  args: Record<string, unknown>;
  options: EngineOptions;
  explicit: boolean;
}

/**
 * Parses a GraphQL argument list by wrapping it in a throwaway query and letting graphql-js do
 * the work. Engine options are renamed first because `@name:` is not valid GraphQL.
 */
function parseArgumentList(inner: string, tableName: string): { args: Record<string, unknown>; options: EngineOptions; warnings: string[] } {
  const warnings: string[] = [];
  const options: EngineOptions = {};
  const args: Record<string, unknown> = {};

  if (inner.trim().length === 0) return { args, options, warnings };

  const OPTION_PREFIX = '__wbopt_';
  const rewritten = inner.replace(/@\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/g, `${OPTION_PREFIX}$1:`);

  let field: FieldNode;
  try {
    const document = parse(`{ __wb(${rewritten}) { __typename } }`);
    const operation = document.definitions[0] as OperationDefinitionNode;
    field = operation.selectionSet.selections[0] as FieldNode;
  } catch (err) {
    fail(
      'SQL_PARSE_FAILED',
      `Could not read the arguments for ${tableName}: ${err instanceof Error ? err.message : String(err)}`,
      inner,
      'Arguments use GraphQL syntax, for example: users(first: 100, role: ADMIN, country: "DE")',
    );
  }

  for (const argument of field.arguments ?? []) {
    const rawName = argument.name.value;
    const value = valueFromASTUntyped(argument.value);

    if (rawName.startsWith(OPTION_PREFIX)) {
      const optionName = rawName.slice(OPTION_PREFIX.length);
      const spec = OPTION_SPECS[optionName.toLowerCase()];
      const key = OPTION_KEYS[optionName.toLowerCase()];
      if (!spec || !key) {
        warnings.push(
          `Unknown option @${optionName} on ${tableName} was ignored. Known options: @maxRows, @pageSize, @allPages, @cache, @depth.`,
        );
        continue;
      }
      if (spec === 'int') {
        const numeric = typeof value === 'number' ? value : Number(value);
        if (!Number.isFinite(numeric) || numeric <= 0) {
          warnings.push(`@${optionName} on ${tableName} needs a positive number; got ${JSON.stringify(value)}.`);
          continue;
        }
        (options[key] as number) = Math.floor(numeric);
      } else {
        if (typeof value !== 'boolean') {
          warnings.push(`@${optionName} on ${tableName} needs true or false; got ${JSON.stringify(value)}.`);
          continue;
        }
        (options[key] as boolean) = value;
      }
      continue;
    }

    args[rawName] = value;
  }

  return { args, options, warnings };
}

/** Canonical JSON for an argument set, so identical arguments share a fetch. */
function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonicalise(v)]),
    );
  }
  return value;
}

/** Names bound by a WITH clause, which shadow catalog tables of the same name. */
function collectCteNames(tokens: Token[]): Set<string> {
  const names = new Set<string>();
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token || (token.type !== 'word' && token.type !== 'quoted-ident')) continue;
    let j = i + 1;
    // Optional column list: name (a, b) AS (
    if (tokens[j]?.text === '(') {
      let depth = 0;
      while (j < tokens.length) {
        const t = tokens[j];
        if (!t) break;
        if (t.text === '(') depth += 1;
        else if (t.text === ')') {
          depth -= 1;
          if (depth === 0) {
            j += 1;
            break;
          }
        }
        j += 1;
      }
    }
    if (tokens[j]?.type === 'word' && tokens[j]?.value.toLowerCase() === 'as' && tokens[j + 1]?.text === '(') {
      names.add(token.value.toLowerCase());
    }
  }
  return names;
}

export function prepass(sql: string, knownTables: Iterable<string>): PrepassResult {
  const tableLookup = new Map<string, string>();
  for (const name of knownTables) tableLookup.set(name.toLowerCase(), name);

  const allTokens = tokenize(sql);
  const tokens = significant(allTokens);
  const cteNames = collectCteNames(tokens);

  const warnings: string[] = [];
  const statementOptions: EngineOptions = {};
  const candidates: Candidate[] = [];

  // A stack of "are we inside a FROM list" flags, one per paren depth, so a subquery's FROM
  // clause does not leak into the enclosing statement.
  const fromStack: boolean[] = [false];
  let expectTable = false;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;

    if (token.type === 'punct') {
      if (token.text === '(') {
        fromStack.push(false);
        expectTable = false;
        continue;
      }
      if (token.text === ')') {
        if (fromStack.length > 1) fromStack.pop();
        expectTable = false;
        continue;
      }
      if (token.text === ',') {
        expectTable = fromStack[fromStack.length - 1] === true;
        continue;
      }
      if (token.text === ';') {
        fromStack.length = 1;
        fromStack[0] = false;
        expectTable = false;
        continue;
      }
      continue;
    }

    if (token.type === 'word') {
      const lower = token.value.toLowerCase();
      if (lower === 'from') {
        fromStack[fromStack.length - 1] = true;
        expectTable = true;
        continue;
      }
      if (JOIN_WORDS.has(lower)) {
        expectTable = true;
        continue;
      }
      if (FROM_LIST_TERMINATORS.has(lower)) {
        fromStack[fromStack.length - 1] = false;
        expectTable = false;
        continue;
      }
      // Join modifiers sit between FROM and the table name, so they do not clear the flag.
      if (['inner', 'left', 'right', 'full', 'cross', 'outer', 'natural', 'positional', 'asof', 'anti', 'semi', 'lateral'].includes(lower)) {
        continue;
      }
    }

    if (!expectTable) continue;
    if (token.type !== 'word' && token.type !== 'quoted-ident') continue;

    expectTable = false;

    const canonicalName = tableLookup.get(token.value.toLowerCase());
    const isCte = cteNames.has(token.value.toLowerCase());
    const next = tokens[i + 1];
    const hasArgs = next?.text === '(';

    if (!canonicalName || isCte) {
      // Not a catalog table. If it carries an argument list, that is almost certainly a mistake
      // worth flagging rather than letting DuckDB report a confusing syntax error.
      if (hasArgs && !isCte && /^[A-Za-z_][A-Za-z0-9_]*$/.test(token.value)) {
        const looksLikeArgs = tokens[i + 2] && tokens[i + 2]?.type === 'word' && tokens[i + 3]?.text === ':';
        if (looksLikeArgs) {
          fail(
            'UNKNOWN_TABLE',
            `There is no table called "${token.value}" in this schema.`,
            undefined,
            'Check the schema tree in the sidebar for the exact field name; table names match the Query fields of the endpoint.',
          );
        }
      }
      continue;
    }

    if (!hasArgs) {
      candidates.push({ start: token.start, end: token.end, table: canonicalName, args: {}, options: {}, explicit: false });
      continue;
    }

    // Find the matching close paren, then parse the text between them.
    let depth = 0;
    let closeIndex = -1;
    for (let j = i + 1; j < tokens.length; j += 1) {
      const t = tokens[j];
      if (!t) break;
      if (t.text === '(') depth += 1;
      else if (t.text === ')') {
        depth -= 1;
        if (depth === 0) {
          closeIndex = j;
          break;
        }
      }
    }
    if (closeIndex === -1) {
      fail(
        'SQL_PARSE_FAILED',
        `The argument list for ${canonicalName} is missing its closing parenthesis.`,
        undefined,
        `For example: FROM ${canonicalName}(first: 100)`,
      );
    }
    const openToken = tokens[i + 1];
    const closeToken = tokens[closeIndex];
    if (!openToken || !closeToken) continue;

    const inner = sql.slice(openToken.end, closeToken.start);
    const parsed = parseArgumentList(inner, canonicalName);
    warnings.push(...parsed.warnings);

    candidates.push({
      start: token.start,
      end: closeToken.end,
      table: canonicalName,
      args: parsed.args,
      options: parsed.options,
      explicit: true,
    });

    i = closeIndex;
  }

  // Group candidates into bindings: same table plus same arguments means one fetch.
  const bindings: TableBinding[] = [];
  const byKey = new Map<string, TableBinding>();
  const perTableCount = new Map<string, number>();
  const replacements: { start: number; end: number; text: string }[] = [];

  for (const candidate of candidates) {
    const key = `${candidate.table}::${JSON.stringify(canonicalise(candidate.args))}`;
    let binding = byKey.get(key);
    if (!binding) {
      const seen = (perTableCount.get(candidate.table) ?? 0) + 1;
      perTableCount.set(candidate.table, seen);
      binding = {
        // The first argument set for a table keeps the plain name, so simple queries stay simple.
        relation: seen === 1 ? candidate.table : `${candidate.table}__wb${seen}`,
        table: candidate.table,
        args: candidate.args,
        options: { ...candidate.options },
        references: 0,
        explicit: candidate.explicit,
      };
      byKey.set(key, binding);
      bindings.push(binding);
    } else {
      Object.assign(binding.options, candidate.options);
      binding.explicit = binding.explicit || candidate.explicit;
    }
    binding.references += 1;
    replacements.push({ start: candidate.start, end: candidate.end, text: binding.relation });
    // Options written on any occurrence also apply to the statement as a whole.
    Object.assign(statementOptions, candidate.options);
  }

  // Rewrite back to front so earlier offsets stay valid.
  let rewritten = sql;
  for (const replacement of [...replacements].sort((a, b) => b.start - a.start)) {
    rewritten = rewritten.slice(0, replacement.start) + replacement.text + rewritten.slice(replacement.end);
  }

  return { sql: rewritten, bindings, options: statementOptions, warnings, cteNames: [...cteNames] };
}
