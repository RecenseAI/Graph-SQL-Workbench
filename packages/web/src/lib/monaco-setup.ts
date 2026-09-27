import * as monaco from 'monaco-editor';
// monaco-editor's exports map rewrites subpaths, so the worker is addressed without the
// esm/vs prefix: "./*" -> "./esm/vs/*.js".
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import { loader } from '@monaco-editor/react';

/**
 * Monaco, configured to run entirely from the bundle.
 *
 * The React wrapper fetches Monaco from a CDN by default, which would make a local developer tool
 * fail without internet. Pointing the loader at the bundled copy costs a larger asset and buys an
 * editor that always works.
 */

let configured = false;

export function setupMonaco(): typeof monaco {
  if (configured) return monaco;
  configured = true;

  self.MonacoEnvironment = {
    getWorker: () => new editorWorker(),
  };
  loader.config({ monaco });

  defineThemes();
  return monaco;
}

/** Palette taken from the app's CSS tokens, so the editor is part of the same surface. */
function defineThemes(): void {
  monaco.editor.defineTheme('workbench-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: '', foreground: 'e6edf7', background: '0b0e14' },
      { token: 'comment', foreground: '697a93', fontStyle: 'italic' },
      { token: 'keyword', foreground: '22d3ee' },
      { token: 'keyword.sql', foreground: '22d3ee' },
      { token: 'operator.sql', foreground: '9fb0c8' },
      { token: 'string', foreground: 'b6e3a8' },
      { token: 'string.sql', foreground: 'b6e3a8' },
      { token: 'number', foreground: '7dd3fc' },
      { token: 'predefined', foreground: 'd8b4fe' },
      { token: 'identifier', foreground: 'e6edf7' },
      { token: 'delimiter', foreground: '9fb0c8' },
      { token: 'type', foreground: 'fcd34d' },
    ],
    colors: {
      'editor.background': '#0b0e14',
      'editor.foreground': '#e6edf7',
      'editorLineNumber.foreground': '#4c5a6e',
      'editorLineNumber.activeForeground': '#9fb0c8',
      'editor.selectionBackground': '#22d3ee33',
      'editor.inactiveSelectionBackground': '#22d3ee1f',
      'editor.lineHighlightBackground': '#11151d',
      'editorCursor.foreground': '#22d3ee',
      'editorIndentGuide.background1': '#1e2430',
      'editorIndentGuide.activeBackground1': '#333d4f',
      'editorWidget.background': '#11151d',
      'editorWidget.border': '#242b38',
      'editorSuggestWidget.background': '#11151d',
      'editorSuggestWidget.border': '#242b38',
      'editorSuggestWidget.selectedBackground': '#1e2430',
      'editorHoverWidget.background': '#11151d',
      'editorHoverWidget.border': '#242b38',
      'editorError.foreground': '#f87171',
      'editorWarning.foreground': '#fbbf24',
      'scrollbarSlider.background': '#333d4f66',
      'scrollbarSlider.hoverBackground': '#333d4f99',
      'scrollbarSlider.activeBackground': '#4c5a6eaa',
    },
  });

  monaco.editor.defineTheme('workbench-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: '', foreground: '131923', background: 'ffffff' },
      { token: 'comment', foreground: '6b7a90', fontStyle: 'italic' },
      { token: 'keyword', foreground: '0e7490' },
      { token: 'keyword.sql', foreground: '0e7490' },
      { token: 'string', foreground: '15803d' },
      { token: 'string.sql', foreground: '15803d' },
      { token: 'number', foreground: '1d4ed8' },
      { token: 'predefined', foreground: '7c3aed' },
      { token: 'type', foreground: 'a16207' },
    ],
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#131923',
      'editorLineNumber.foreground': '#93a0b3',
      'editor.lineHighlightBackground': '#f6f8fb',
      'editorCursor.foreground': '#0e7490',
      'editor.selectionBackground': '#0e749033',
    },
  });
}

export { monaco };
