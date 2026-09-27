import type * as Monaco from 'monaco-editor';
import type { Catalog } from '@gqlwb/shared';

/**
 * GraphQL highlighting and completion, built from the catalog the workbench already has.
 *
 * Monaco ships no GraphQL language, and the available plugin is a pre-release. Since introspection
 * has already produced every root field, argument and enum value, a small Monarch tokeniser plus a
 * catalog-driven completion provider covers what this tab is for -- reading the endpoint directly,
 * and copying the documents the planner generated -- with no pre-release dependency in the path.
 */

let current: Catalog | null = null;

export function setGraphqlCatalog(catalog: Catalog | null): void {
  current = catalog;
}

const LANGUAGE_ID = 'graphql';

export function registerGraphqlLanguage(monaco: typeof Monaco): Monaco.IDisposable[] {
  const disposables: Monaco.IDisposable[] = [];

  if (!monaco.languages.getLanguages().some((language) => language.id === LANGUAGE_ID)) {
    monaco.languages.register({ id: LANGUAGE_ID, extensions: ['.graphql', '.gql'], aliases: ['GraphQL', 'graphql'] });

    monaco.languages.setMonarchTokensProvider(LANGUAGE_ID, {
      defaultToken: '',
      keywords: [
        'query', 'mutation', 'subscription', 'fragment', 'on', 'true', 'false', 'null',
        'type', 'input', 'enum', 'interface', 'union', 'scalar', 'schema', 'extend', 'implements', 'directive',
      ],
      tokenizer: {
        root: [
          [/#.*$/, 'comment'],
          [/"""/, { token: 'string', next: '@blockString' }],
          [/"/, { token: 'string', next: '@string' }],
          [/\$[A-Za-z_][A-Za-z0-9_]*/, 'variable'],
          [/@[A-Za-z_][A-Za-z0-9_]*/, 'annotation'],
          [/\b[A-Z][A-Za-z0-9_]*\b/, 'type'],
          [/-?\d+\.\d+([eE][-+]?\d+)?/, 'number.float'],
          [/-?\d+/, 'number'],
          [
            /[A-Za-z_][A-Za-z0-9_]*(?=\s*:)/,
            'attribute.name',
          ],
          [
            /[A-Za-z_][A-Za-z0-9_]*/,
            { cases: { '@keywords': 'keyword', '@default': 'identifier' } },
          ],
          [/[{}()[\]]/, '@brackets'],
          [/[:=|!&.]/, 'delimiter'],
        ],
        string: [
          [/[^\\"]+/, 'string'],
          [/\\./, 'string.escape'],
          [/"/, { token: 'string', next: '@pop' }],
        ],
        blockString: [
          [/"""/, { token: 'string', next: '@pop' }],
          [/./, 'string'],
        ],
      },
    });

    monaco.languages.setLanguageConfiguration(LANGUAGE_ID, {
      comments: { lineComment: '#' },
      brackets: [
        ['{', '}'],
        ['[', ']'],
        ['(', ')'],
      ],
      autoClosingPairs: [
        { open: '{', close: '}' },
        { open: '[', close: ']' },
        { open: '(', close: ')' },
        { open: '"', close: '"' },
      ],
      surroundingPairs: [
        { open: '{', close: '}' },
        { open: '[', close: ']' },
        { open: '(', close: ')' },
        { open: '"', close: '"' },
      ],
    });
  }

  disposables.push(
    monaco.languages.registerCompletionItemProvider(LANGUAGE_ID, {
      triggerCharacters: ['{', ' ', '(', ':', '\n'],
      provideCompletionItems(model, position) {
        const catalog = current;
        const word = model.getWordUntilPosition(position);
        const range: Monaco.IRange = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        const Kind = monaco.languages.CompletionItemKind;
        const InsertRule = monaco.languages.CompletionItemInsertTextRule;
        const suggestions: Monaco.languages.CompletionItem[] = [];

        if (!catalog) return { suggestions };

        const textBefore = model.getValueInRange({
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        });

        // Inside a root field's argument list.
        const open = textBefore.lastIndexOf('(');
        if (open !== -1 && !textBefore.slice(open).includes(')')) {
          const head = textBefore.slice(0, open);
          const fieldMatch = /([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(head);
          const table = catalog.tables.find((t) => t.rootField === fieldMatch?.[1] && !t.isChild);
          if (table) {
            for (const arg of table.args) {
              suggestions.push({
                label: arg.name,
                kind: Kind.Property,
                insertText: `${arg.name}: `,
                detail: arg.graphqlType + (arg.required ? ' (required)' : ''),
                ...(arg.description ? { documentation: arg.description } : {}),
                sortText: arg.required ? `0${arg.name}` : `1${arg.name}`,
                range,
              });
            }
            return { suggestions };
          }
        }

        // Enum values after `argument: `.
        const enumMatch = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*[A-Za-z_]*$/.exec(textBefore);
        if (enumMatch?.[1]) {
          const argName = enumMatch[1];
          for (const table of catalog.tables) {
            const arg = table.args.find((a) => a.name === argName && a.enumValues?.length);
            if (!arg?.enumValues) continue;
            for (const value of arg.enumValues) {
              suggestions.push({ label: value, kind: Kind.EnumMember, insertText: value, detail: arg.graphqlTypeName, range });
            }
            if (suggestions.length > 0) return { suggestions };
          }
        }

        // Root fields, each expanded into a usable selection set.
        const atTopLevel = /\{\s*[A-Za-z_]*$/.test(textBefore) || textBefore.trim().length === 0;
        for (const table of catalog.tables.filter((t) => !t.isChild)) {
          const leafFields = table.columns
            .filter((c) => !c.synthetic && c.path.length === 1 && !c.isList)
            .slice(0, 6)
            .map((c) => c.path[0])
            .filter((name): name is string => Boolean(name));
          const nodes = table.pagination.nodesPath;
          const body = leafFields.length > 0 ? leafFields.join('\n      ') : '__typename';
          let insert = table.rootField;
          if (nodes.length === 2) {
            insert = `${table.rootField}(first: 10) {\n    ${nodes[0]} {\n      ${nodes[1]} {\n        ${body}\n      }\n    }\n  }`;
          } else if (nodes.length === 1) {
            insert = `${table.rootField} {\n    ${nodes[0]} {\n      ${body}\n    }\n  }`;
          } else {
            insert = `${table.rootField} {\n    ${body}\n  }`;
          }
          suggestions.push({
            label: table.rootField,
            kind: Kind.Function,
            insertText: insert,
            insertTextRules: InsertRule.InsertAsSnippet,
            detail: `-> ${table.rowTypeName}`,
            ...(table.description ? { documentation: table.description } : {}),
            sortText: atTopLevel ? `0${table.rootField}` : `1${table.rootField}`,
            range,
          });
        }

        for (const keyword of ['query', 'fragment', '__typename', 'true', 'false', 'null']) {
          suggestions.push({ label: keyword, kind: Kind.Keyword, insertText: keyword, sortText: `2${keyword}`, range });
        }
        return { suggestions };
      },
    }),
  );

  return disposables;
}
