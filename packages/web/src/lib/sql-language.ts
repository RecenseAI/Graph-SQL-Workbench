import type * as Monaco from 'monaco-editor';
import type { Catalog, CatalogTable } from '@gqlwb/shared';

/**
 * Catalog-aware SQL intelligence.
 *
 * Completion here is worth more than in an ordinary SQL editor, because the "schema" is a GraphQL
 * endpoint nobody has memorised: the columns are flattened paths like `address_city`, and the
 * arguments only exist inside a FROM clause. So the provider is context-sensitive -- it knows
 * whether the cursor sits after FROM, after an alias dot, or inside a table's argument list -- and
 * it reads the live catalog rather than a static word list.
 */

/** The catalog currently loaded, kept here so providers registered once can see updates. */
let current: Catalog | null = null;

export function setCompletionCatalog(catalog: Catalog | null): void {
  current = catalog;
}

const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT', 'OFFSET', 'JOIN', 'LEFT JOIN',
  'RIGHT JOIN', 'FULL JOIN', 'INNER JOIN', 'CROSS JOIN', 'ON', 'USING', 'AS', 'AND', 'OR', 'NOT', 'IN',
  'IS NULL', 'IS NOT NULL', 'LIKE', 'ILIKE', 'BETWEEN', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'DISTINCT', 'WITH', 'UNION', 'UNION ALL', 'EXCEPT', 'INTERSECT', 'QUALIFY', 'WINDOW', 'OVER',
  'PARTITION BY', 'ASC', 'DESC', 'NULLS FIRST', 'NULLS LAST', 'EXCLUDE', 'REPLACE', 'PIVOT', 'UNPIVOT',
  'GROUP BY ALL', 'ORDER BY ALL', 'LATERAL', 'UNNEST', 'SUMMARIZE', 'DESCRIBE', 'SHOW TABLES',
  'SHOW SNAPSHOTS', 'SHOW SETTINGS', 'MATERIALIZE', 'REFRESH', 'DROP SNAPSHOT', 'SET',
];

const FUNCTIONS: { name: string; detail: string }[] = [
  { name: 'count', detail: 'count(*) or count(expr)' },
  { name: 'sum', detail: 'sum(expr)' },
  { name: 'avg', detail: 'avg(expr)' },
  { name: 'min', detail: 'min(expr)' },
  { name: 'max', detail: 'max(expr)' },
  { name: 'median', detail: 'median(expr)' },
  { name: 'mode', detail: 'mode(expr)' },
  { name: 'stddev', detail: 'stddev(expr)' },
  { name: 'variance', detail: 'variance(expr)' },
  { name: 'quantile_cont', detail: 'quantile_cont(expr, fraction)' },
  { name: 'approx_count_distinct', detail: 'approx_count_distinct(expr)' },
  { name: 'string_agg', detail: 'string_agg(expr, separator)' },
  { name: 'array_agg', detail: 'array_agg(expr)' },
  { name: 'arg_max', detail: 'arg_max(value, ordering)' },
  { name: 'arg_min', detail: 'arg_min(value, ordering)' },
  { name: 'row_number', detail: 'row_number() OVER (...)' },
  { name: 'rank', detail: 'rank() OVER (...)' },
  { name: 'dense_rank', detail: 'dense_rank() OVER (...)' },
  { name: 'ntile', detail: 'ntile(buckets) OVER (...)' },
  { name: 'lag', detail: 'lag(expr, offset) OVER (...)' },
  { name: 'lead', detail: 'lead(expr, offset) OVER (...)' },
  { name: 'first_value', detail: 'first_value(expr) OVER (...)' },
  { name: 'last_value', detail: 'last_value(expr) OVER (...)' },
  { name: 'cume_dist', detail: 'cume_dist() OVER (...)' },
  { name: 'percent_rank', detail: 'percent_rank() OVER (...)' },
  { name: 'coalesce', detail: 'coalesce(a, b, ...)' },
  { name: 'ifnull', detail: 'ifnull(a, b) -- MySQL compatibility macro' },
  { name: 'nullif', detail: 'nullif(a, b)' },
  { name: 'cast', detail: 'CAST(expr AS TYPE)' },
  { name: 'try_cast', detail: 'try_cast(expr AS TYPE) -- NULL instead of an error' },
  { name: 'round', detail: 'round(x, digits)' },
  { name: 'floor', detail: 'floor(x)' },
  { name: 'ceil', detail: 'ceil(x)' },
  { name: 'abs', detail: 'abs(x)' },
  { name: 'greatest', detail: 'greatest(a, b, ...)' },
  { name: 'least', detail: 'least(a, b, ...)' },
  { name: 'lower', detail: 'lower(s)' },
  { name: 'upper', detail: 'upper(s)' },
  { name: 'trim', detail: 'trim(s)' },
  { name: 'length', detail: 'length(s)' },
  { name: 'char_length', detail: 'char_length(s) -- MySQL compatibility macro' },
  { name: 'substring', detail: 'substring(s, start, length)' },
  { name: 'split_part', detail: 'split_part(s, delimiter, index)' },
  { name: 'regexp_matches', detail: 'regexp_matches(s, pattern)' },
  { name: 'regexp_replace', detail: 'regexp_replace(s, pattern, replacement)' },
  { name: 'concat', detail: 'concat(a, b, ...)' },
  { name: 'concat_ws', detail: 'concat_ws(separator, a, b, ...)' },
  { name: 'starts_with', detail: 'starts_with(s, prefix)' },
  { name: 'contains', detail: 'contains(s, needle)' },
  { name: 'date_trunc', detail: "date_trunc('month', ts)" },
  { name: 'date_diff', detail: "date_diff('day', a, b)" },
  { name: 'date_part', detail: "date_part('year', ts)" },
  { name: 'strftime', detail: "strftime(ts, '%Y-%m')" },
  { name: 'strptime', detail: "strptime(s, '%Y-%m-%d')" },
  { name: 'date_format', detail: 'date_format(ts, fmt) -- MySQL compatibility macro' },
  { name: 'now', detail: 'now()' },
  { name: 'today', detail: 'today()' },
  { name: 'epoch', detail: 'epoch(ts)' },
  { name: 'unnest', detail: 'unnest(list) -- expands a list column into rows' },
  { name: 'len', detail: 'len(list)' },
  { name: 'list_transform', detail: 'list_transform(list, x -> expr)' },
  { name: 'list_filter', detail: 'list_filter(list, x -> condition)' },
  { name: 'list_contains', detail: 'list_contains(list, value)' },
  { name: 'list_sort', detail: 'list_sort(list)' },
  { name: 'array_length', detail: 'array_length(list)' },
  { name: 'json_extract', detail: "json_extract(raw, '$.field')" },
  { name: 'json_extract_string', detail: "json_extract_string(raw, '$.field')" },
  { name: 'raw_get', detail: "raw_get(_raw, '$.field') -- reads the escape-hatch column" },
  { name: 'struct_pack', detail: 'struct_pack(name := value, ...)' },
  { name: 'to_json', detail: 'to_json(expr)' },
];

const SNIPPETS: { label: string; detail: string; body: string }[] = [
  {
    label: 'join-unmodelled',
    detail: 'Join two root fields on a relationship the schema does not model',
    body: [
      'SELECT a.${1:id}, b.${2:id}',
      'FROM ${3:tableA} a',
      'JOIN ${4:tableB} b ON b.${5:foreignId} = a.${1:id}',
    ].join('\n'),
  },
  {
    label: 'group-aggregate',
    detail: 'Group and aggregate, which GraphQL cannot express',
    body: [
      'SELECT ${1:column},',
      '       COUNT(*)      AS n,',
      '       SUM(${2:amount}) AS total,',
      '       MAX(${2:amount}) AS biggest',
      'FROM ${3:table}',
      'GROUP BY ${1:column}',
      'ORDER BY total DESC',
    ].join('\n'),
  },
  {
    label: 'window-rank',
    detail: 'Rank inside groups with a window function',
    body: [
      'SELECT *',
      'FROM (',
      '  SELECT ${1:group}, ${2:value},',
      '         RANK() OVER (PARTITION BY ${1:group} ORDER BY ${2:value} DESC) AS rk',
      '  FROM ${3:table}',
      ') ranked',
      'WHERE rk <= ${4:3}',
    ].join('\n'),
  },
  {
    label: 'child-join',
    detail: 'Join a nested list back to its parent',
    body: ['SELECT p.*, c.*', 'FROM ${1:parent} p', 'JOIN ${1:parent}__${2:items} c ON c._parent_rowid = p._rowid'].join('\n'),
  },
  {
    label: 'unnest-list',
    detail: 'Expand a list column into rows',
    body: ['SELECT t.value, count(*) AS n', 'FROM (SELECT unnest(${1:tags}) AS value FROM ${2:table}) t', 'GROUP BY t.value', 'ORDER BY n DESC'].join('\n'),
  },
  {
    label: 'materialize',
    detail: 'Pin a fetch as a table that queries without the endpoint',
    body: 'MATERIALIZE ${1:table}(${2:first: 5000}) AS ${3:snapshot}',
  },
];

interface AliasBinding {
  alias: string;
  table: CatalogTable;
}

/** FROM/JOIN aliases visible in the document, so `u.` can complete `users` columns. */
function collectAliases(text: string, catalog: Catalog): AliasBinding[] {
  const byName = new Map(catalog.tables.map((t) => [t.name.toLowerCase(), t]));
  const bindings: AliasBinding[] = [];
  // table name, an optional argument list, an optional AS, then an optional alias
  const pattern = /\b(?:from|join)\s+("?[A-Za-z_][A-Za-z0-9_]*"?)\s*(\([^)]*\))?\s*(?:as\s+)?("?[A-Za-z_][A-Za-z0-9_]*"?)?/gi;
  for (const match of text.matchAll(pattern)) {
    const rawTable = (match[1] ?? '').replace(/"/g, '');
    const table = byName.get(rawTable.toLowerCase());
    if (!table) continue;
    const rawAlias = (match[3] ?? '').replace(/"/g, '');
    const alias = rawAlias && !isKeyword(rawAlias) ? rawAlias : table.name;
    bindings.push({ alias, table });
    if (alias !== table.name) bindings.push({ alias: table.name, table });
  }
  return bindings;
}

const KEYWORD_SET = new Set(
  [...KEYWORDS, 'on', 'using', 'where', 'group', 'order', 'limit', 'having', 'qualify', 'union', 'left', 'right', 'inner', 'full', 'cross', 'natural', 'lateral']
    .flatMap((k) => k.toLowerCase().split(' ')),
);
const isKeyword = (word: string): boolean => KEYWORD_SET.has(word.toLowerCase());

/** Which table's argument list the cursor sits inside, if any. */
function argumentContext(textBefore: string, catalog: Catalog): CatalogTable | null {
  const open = textBefore.lastIndexOf('(');
  if (open === -1) return null;
  if (textBefore.slice(open).includes(')')) return null;
  const head = textBefore.slice(0, open);
  const match = /\b(?:from|join)\s+("?[A-Za-z_][A-Za-z0-9_]*"?)\s*$/i.exec(head);
  if (!match) return null;
  const name = (match[1] ?? '').replace(/"/g, '');
  return catalog.tables.find((t) => t.name.toLowerCase() === name.toLowerCase()) ?? null;
}

export function registerSqlLanguage(monaco: typeof Monaco): Monaco.IDisposable[] {
  const disposables: Monaco.IDisposable[] = [];

  disposables.push(
    monaco.languages.registerCompletionItemProvider('sql', {
      triggerCharacters: ['.', ' ', '(', ',', ':'],
      provideCompletionItems(model, position) {
        const catalog = current;
        const word = model.getWordUntilPosition(position);
        const range: Monaco.IRange = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        const suggestions: Monaco.languages.CompletionItem[] = [];
        const Kind = monaco.languages.CompletionItemKind;
        const InsertRule = monaco.languages.CompletionItemInsertTextRule;

        const textBefore = model.getValueInRange({
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        });
        const fullText = model.getValue();

        if (!catalog) {
          for (const keyword of KEYWORDS) {
            suggestions.push({ label: keyword, kind: Kind.Keyword, insertText: keyword, range });
          }
          return { suggestions };
        }

        const aliases = collectAliases(fullText, catalog);

        // 1. `alias.` -> that table's columns, and nothing else.
        const dotMatch = /([A-Za-z_][A-Za-z0-9_]*)\.\s*$/.exec(textBefore.replace(/[A-Za-z0-9_]*$/, ''));
        const dotted = dotMatch ?? /([A-Za-z_][A-Za-z0-9_]*)\.[A-Za-z0-9_]*$/.exec(textBefore);
        if (dotted?.[1]) {
          const binding = aliases.find((a) => a.alias.toLowerCase() === dotted[1]?.toLowerCase());
          if (binding) {
            binding.table.columns.forEach((column, index) => {
              suggestions.push({
                label: column.name,
                kind: column.synthetic ? Kind.Constant : Kind.Field,
                insertText: column.name,
                detail: `${column.duckType}${column.nullable ? '' : ' NOT NULL'}`,
                documentation: {
                  value: [
                    `**${binding.table.name}.${column.name}**`,
                    '',
                    `GraphQL: \`${column.graphqlType}\`${column.path.length > 1 ? ` at \`${column.path.join('.')}\`` : ''}`,
                    column.enumValues?.length ? `One of: ${column.enumValues.map((v) => `\`${v}\``).join(', ')}` : '',
                    column.deprecationReason ? `_Deprecated: ${column.deprecationReason}_` : '',
                    column.description ?? '',
                  ]
                    .filter(Boolean)
                    .join('\n\n'),
                },
                sortText: String(index).padStart(4, '0'),
                range,
              });
            });
            return { suggestions };
          }
        }

        // 2. Inside `table(...)` -> that table's GraphQL arguments and the engine options.
        const argTable = argumentContext(textBefore, catalog);
        if (argTable) {
          for (const arg of argTable.args) {
            suggestions.push({
              label: arg.name,
              kind: Kind.Property,
              insertText: `${arg.name}: `,
              detail: arg.graphqlType + (arg.required ? ' (required)' : ''),
              documentation: {
                value: [
                  arg.description ?? '',
                  arg.enumValues?.length ? `One of: ${arg.enumValues.map((v) => `\`${v}\``).join(', ')}` : '',
                  arg.inputFields?.length ? `Fields: ${arg.inputFields.map((f) => `\`${f.name}\``).join(', ')}` : '',
                ]
                  .filter(Boolean)
                  .join('\n\n'),
              },
              sortText: arg.required ? `0${arg.name}` : `1${arg.name}`,
              range,
            });
          }
          for (const option of ['@maxRows: ', '@pageSize: ', '@allPages: true', '@cache: false']) {
            suggestions.push({
              label: option.trim(),
              kind: Kind.Operator,
              insertText: option,
              detail: 'workbench option',
              sortText: `2${option}`,
              range,
            });
          }
          return { suggestions };
        }

        // 3. Straight after FROM or JOIN -> tables only.
        if (/\b(from|join)\s+[A-Za-z0-9_]*$/i.test(textBefore)) {
          for (const table of catalog.tables) {
            suggestions.push({
              label: table.name,
              kind: table.isChild ? Kind.Interface : Kind.Class,
              insertText: table.name,
              detail: `${table.columns.filter((c) => !c.synthetic).length} columns, ${table.pagination.style}`,
              documentation: {
                value: [
                  table.description ?? '',
                  table.isChild
                    ? `Nested in \`${table.parent}\`. Join it with \`ON ${table.name}._parent_rowid = ${table.parent}._rowid\`.`
                    : `Reads the \`${table.rootField}\` field of the endpoint.`,
                  table.args.filter((a) => a.required).length
                    ? `Requires: ${table.args.filter((a) => a.required).map((a) => `\`${a.name}\``).join(', ')}`
                    : '',
                ]
                  .filter(Boolean)
                  .join('\n\n'),
              },
              sortText: table.isChild ? `1${table.name}` : `0${table.name}`,
              range,
            });
          }
          return { suggestions };
        }

        // 4. Anywhere else: columns of tables in scope, then functions, keywords and snippets.
        const seen = new Set<string>();
        for (const binding of aliases) {
          for (const column of binding.table.columns) {
            if (column.synthetic) continue;
            const key = `${binding.alias}.${column.name}`;
            if (seen.has(key)) continue;
            seen.add(key);
            suggestions.push({
              label: column.name,
              kind: Kind.Field,
              insertText: column.name,
              detail: `${binding.alias}.${column.name} - ${column.duckType}`,
              sortText: `0${column.name}`,
              range,
            });
          }
        }
        for (const table of catalog.tables) {
          suggestions.push({
            label: table.name,
            kind: table.isChild ? Kind.Interface : Kind.Class,
            insertText: table.name,
            detail: 'table',
            sortText: `1${table.name}`,
            range,
          });
        }
        for (const fn of FUNCTIONS) {
          suggestions.push({
            label: fn.name,
            kind: Kind.Function,
            insertText: `${fn.name}($0)`,
            insertTextRules: InsertRule.InsertAsSnippet,
            detail: fn.detail,
            sortText: `2${fn.name}`,
            range,
          });
        }
        for (const keyword of KEYWORDS) {
          suggestions.push({ label: keyword, kind: Kind.Keyword, insertText: keyword, sortText: `3${keyword}`, range });
        }
        for (const snippet of SNIPPETS) {
          suggestions.push({
            label: snippet.label,
            kind: Kind.Snippet,
            insertText: snippet.body,
            insertTextRules: InsertRule.InsertAsSnippet,
            detail: snippet.detail,
            sortText: `4${snippet.label}`,
            range,
          });
        }
        return { suggestions };
      },
    }),
  );

  // Hover: what a table or column is, in both dialects.
  disposables.push(
    monaco.languages.registerHoverProvider('sql', {
      provideHover(model, position) {
        const catalog = current;
        if (!catalog) return null;
        const word = model.getWordAtPosition(position);
        if (!word) return null;

        const table = catalog.tables.find((t) => t.name.toLowerCase() === word.word.toLowerCase());
        if (table) {
          const required = table.args.filter((a) => a.required);
          return {
            contents: [
              { value: `**${table.name}** - ${table.columns.filter((c) => !c.synthetic).length} columns` },
              {
                value: [
                  table.description ?? '',
                  `GraphQL field: \`${table.rootField}\` returning \`${table.rowTypeName}\``,
                  `Pagination: \`${table.pagination.style}\``,
                  required.length ? `Requires: ${required.map((a) => `\`${a.name}\``).join(', ')}` : '',
                  table.childTables.length ? `Nested tables: ${table.childTables.map((c) => `\`${c}\``).join(', ')}` : '',
                ]
                  .filter(Boolean)
                  .join('\n\n'),
              },
            ],
          };
        }

        const aliases = collectAliases(model.getValue(), catalog);
        for (const binding of aliases) {
          const column = binding.table.columns.find((c) => c.name.toLowerCase() === word.word.toLowerCase());
          if (!column) continue;
          return {
            contents: [
              { value: `**${column.name}** \`${column.duckType}\`` },
              {
                value: [
                  `From \`${binding.table.name}\`, GraphQL \`${column.graphqlType}\`${
                    column.path.length > 1 ? ` at \`${column.path.join('.')}\`` : ''
                  }`,
                  column.nullable ? 'Nullable.' : 'Never null.',
                  column.enumValues?.length ? `One of: ${column.enumValues.map((v) => `\`${v}\``).join(', ')}` : '',
                  column.deprecationReason ? `_Deprecated: ${column.deprecationReason}_` : '',
                  column.description ?? '',
                ]
                  .filter(Boolean)
                  .join('\n\n'),
              },
            ],
          };
        }
        return null;
      },
    }),
  );

  return disposables;
}

/**
 * Marks table names that are not in the catalog.
 *
 * Deliberately narrow: only a name in FROM or JOIN position, only when a catalog is loaded, and
 * never when the name is defined by a CTE or could be a snapshot. A false squiggle in a working
 * query is worse than a missing one.
 */
export function computeDiagnostics(monaco: typeof Monaco, model: Monaco.editor.ITextModel): Monaco.editor.IMarkerData[] {
  const catalog = current;
  if (!catalog) return [];
  const text = model.getValue();
  const known = new Set(catalog.tables.map((t) => t.name.toLowerCase()));

  // Names bound by WITH ... AS ( are local to the statement.
  const cteNames = new Set<string>();
  for (const match of text.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^)]*\))?\s+as\s*\(/gi)) {
    if (match[1]) cteNames.add(match[1].toLowerCase());
  }
  // A snapshot is a real DuckDB table the catalog knows nothing about.
  const snapshots = new Set<string>();
  for (const match of text.matchAll(/\bmaterialize\s+.+?\s+as\s+([A-Za-z_][A-Za-z0-9_]*)/gi)) {
    if (match[1]) snapshots.add(match[1].toLowerCase());
  }

  const markers: Monaco.editor.IMarkerData[] = [];
  const pattern = /\b(from|join)\s+("?)([A-Za-z_][A-Za-z0-9_]*)\2(\s*\()?/gi;
  for (const match of text.matchAll(pattern)) {
    const name = match[3];
    if (!name) continue;
    const lower = name.toLowerCase();
    if (known.has(lower) || cteNames.has(lower) || snapshots.has(lower)) continue;
    // Only flag a name that carries an argument list, or that closely resembles a real table.
    const hasArgs = Boolean(match[4]);
    const near = [...known].find((candidate) => levenshtein(candidate, lower) <= 2);
    if (!hasArgs && !near) continue;

    const offset = (match.index ?? 0) + match[0].indexOf(name, match[1]?.length ?? 0);
    const start = model.getPositionAt(offset);
    const end = model.getPositionAt(offset + name.length);
    markers.push({
      severity: monaco.MarkerSeverity.Warning,
      message: near
        ? `There is no table called "${name}" in this schema. Did you mean "${catalog.tables.find((t) => t.name.toLowerCase() === near)?.name}"?`
        : `There is no table called "${name}" in this schema.`,
      startLineNumber: start.lineNumber,
      startColumn: start.column,
      endLineNumber: end.lineNumber,
      endColumn: end.column,
    });
  }
  return markers;
}

/** Small edit distance, used only to offer a "did you mean" on a near miss. */
function levenshtein(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 3) return 99;
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i += 1) rows.push([i, ...new Array<number>(b.length).fill(0)]);
  const first = rows[0];
  if (first) for (let j = 0; j <= b.length; j += 1) first[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const row = rows[i];
      const prev = rows[i - 1];
      if (!row || !prev) continue;
      row[j] = Math.min((row[j - 1] ?? 0) + 1, (prev[j] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
  }
  return rows[a.length]?.[b.length] ?? 99;
}
