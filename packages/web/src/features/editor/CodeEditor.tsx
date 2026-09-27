import { useCallback, useEffect, useMemo, useRef } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import { format as formatSql } from 'sql-formatter';
import { setupMonaco } from '../../lib/monaco-setup.ts';
import { computeDiagnostics, registerSqlLanguage, setCompletionCatalog } from '../../lib/sql-language.ts';
import { registerGraphqlLanguage, setGraphqlCatalog } from '../../lib/graphql-language.ts';
import { useWorkbench, type EditorTab } from '../../store/workbench.ts';

setupMonaco();

let languagesRegistered = false;

interface CodeEditorProps {
  tab: EditorTab;
  onRun: () => void;
  onRunStatement: () => void;
  onStop: () => void;
}

/**
 * The editor.
 *
 * Two behaviours matter more than the rest. Ctrl+Enter runs the whole script and Ctrl+Shift+Enter
 * runs only the statement under the cursor, which is how anyone works through a long scratch file.
 * And the cursor offset is pushed into the store on every move, because "run current statement",
 * and clicking a column in the schema tree to insert it, both need to know where the caret is.
 */
export function CodeEditor({ tab, onRun, onRunStatement, onStop }: CodeEditorProps) {
  const theme = useWorkbench((s) => s.theme);
  const catalog = useWorkbench((s) => s.catalog);
  const setTabContent = useWorkbench((s) => s.setTabContent);
  const updateTab = useWorkbench((s) => s.updateTab);

  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const handlers = useRef({ onRun, onRunStatement, onStop });
  handlers.current = { onRun, onRunStatement, onStop };

  // Language providers read the catalog through a module-level reference, so they are registered
  // once and simply see whatever is current.
  useEffect(() => {
    setCompletionCatalog(catalog);
    setGraphqlCatalog(catalog);
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (editor && monaco && tab.kind === 'sql') {
      const model = editor.getModel();
      if (model) monaco.editor.setModelMarkers(model, 'workbench', computeDiagnostics(monaco, model));
    }
  }, [catalog, tab.kind]);

  const format = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const model = editor.getModel();
    if (!model) return;
    if (tab.kind === 'graphql') {
      // Enough to make a hand-typed document readable: normalise indentation by brace depth.
      const lines = model.getValue().split('\n');
      let depth = 0;
      const formatted = lines
        .map((line) => {
          const trimmed = line.trim();
          if (trimmed.startsWith('}') || trimmed.startsWith(']') || trimmed.startsWith(')')) depth = Math.max(0, depth - 1);
          const output = trimmed.length === 0 ? '' : '  '.repeat(depth) + trimmed;
          const opens = (trimmed.match(/[{[(]/g) ?? []).length;
          const closes = (trimmed.match(/[}\])]/g) ?? []).length;
          depth = Math.max(0, depth + opens - closes);
          return output;
        })
        .join('\n');
      editor.executeEdits('format', [{ range: model.getFullModelRange(), text: formatted }]);
      return;
    }
    try {
      // The workbench's argument syntax is not SQL, so it is hidden from the formatter and restored
      // afterwards; otherwise `users(first: 100)` comes back mangled.
      const source = model.getValue();
      const stash: string[] = [];
      const masked = source.replace(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(([^()]*:[^()]*)\)/g, (match) => {
        stash.push(match);
        return `wbargs${stash.length - 1}wbargs`;
      });
      let formatted = formatSql(masked, {
        language: 'duckdb',
        keywordCase: 'upper',
        indentStyle: 'standard',
        tabWidth: 2,
        linesBetweenQueries: 1,
      });
      formatted = formatted.replace(/wbargs(\d+)wbargs/g, (_m, index: string) => stash[Number(index)] ?? '');
      editor.executeEdits('format', [{ range: model.getFullModelRange(), text: formatted }]);
    } catch {
      // A statement the formatter cannot parse is left exactly as typed.
    }
  }, [tab.kind]);

  const onMount = useCallback<OnMount>(
    (editor, monaco) => {
      editorRef.current = editor;
      monacoRef.current = monaco;

      if (!languagesRegistered) {
        languagesRegistered = true;
        registerSqlLanguage(monaco);
        registerGraphqlLanguage(monaco);
      }

      editor.addAction({
        id: 'workbench.run',
        label: 'Run',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, monaco.KeyCode.F5],
        run: () => handlers.current.onRun(),
      });
      editor.addAction({
        id: 'workbench.runStatement',
        label: 'Run current statement',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter],
        run: () => handlers.current.onRunStatement(),
      });
      editor.addAction({
        id: 'workbench.stop',
        label: 'Stop',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Backspace],
        run: () => handlers.current.onStop(),
      });
      editor.addAction({
        id: 'workbench.format',
        label: 'Format',
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF],
        run: () => format(),
      });

      editor.onDidChangeCursorPosition(() => {
        const model = editor.getModel();
        const position = editor.getPosition();
        if (model && position) updateTab(tab.id, { cursorOffset: model.getOffsetAt(position) });
      });

      const model = editor.getModel();
      if (model && tab.kind === 'sql') {
        monaco.editor.setModelMarkers(model, 'workbench', computeDiagnostics(monaco, model));
      }
    },
    [format, tab.id, tab.kind, updateTab],
  );

  const options = useMemo<Monaco.editor.IStandaloneEditorConstructionOptions>(
    () => ({
      fontFamily: "ui-monospace, 'Cascadia Mono', 'JetBrains Mono', Consolas, monospace",
      fontSize: 13,
      lineHeight: 20,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: 'line',
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      padding: { top: 10, bottom: 10 },
      tabSize: 2,
      wordWrap: 'off',
      lineNumbersMinChars: 3,
      glyphMargin: false,
      folding: true,
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
      suggest: { showWords: false, snippetsPreventQuickSuggestions: false },
      quickSuggestions: { other: true, comments: false, strings: false },
      acceptSuggestionOnEnter: 'off',
      tabCompletion: 'on',
      automaticLayout: true,
      bracketPairColorization: { enabled: true },
      guides: { indentation: true },
      stickyScroll: { enabled: false },
    }),
    [],
  );

  return (
    <Editor
      language={tab.kind === 'sql' ? 'sql' : 'graphql'}
      theme={theme === 'dark' ? 'workbench-dark' : 'workbench-light'}
      value={tab.content}
      options={options}
      onMount={onMount}
      onChange={(value) => {
        setTabContent(tab.id, value ?? '');
        const editor = editorRef.current;
        const monaco = monacoRef.current;
        if (editor && monaco && tab.kind === 'sql') {
          const model = editor.getModel();
          if (model) monaco.editor.setModelMarkers(model, 'workbench', computeDiagnostics(monaco, model));
        }
      }}
      loading={<div className="grid h-full place-items-center text-xs text-ink-3">Loading editor...</div>}
    />
  );
}
