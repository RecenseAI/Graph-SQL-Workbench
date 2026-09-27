# packages/web

The React 19 UI, built with Vite 8 (Rolldown) and Tailwind 4. It only ever talks to the local
API (`/api`, proxied to :5470 in dev); it never calls GraphQL endpoints itself.

## Map

| Path | What |
| --- | --- |
| `src/store/workbench.ts` | All state (zustand). A tab owns its SQL, run, results and grid views. SSE events are folded in as they arrive in `run()`. |
| `src/lib/api.ts` | Typed API client and the SSE reader (`runSql`). |
| `src/app/` | Shell: `App`, `TitleBar`, `StatusBar`, `CommandPalette`, `HelpSheet` (F1 cheat sheet), `Splitter`, `Icons` |
| `src/ui/primitives.tsx` | Button, IconButton, Input, Select, Badge, TabStrip, EmptyState ... use these, don't restyle ad hoc |
| `src/features/editor/` | Monaco `CodeEditor`, `EditorPane` (tabs + toolbar), `GraphqlRunner` |
| `src/lib/sql-language.ts` | Catalog-aware SQL completion, hover, diagnostics |
| `src/lib/graphql-language.ts` | Hand-rolled GraphQL tokeniser + completion (no monaco-graphql) |
| `src/features/results/` | `ResultGrid` (virtualised rows and columns), `ResultDock`, `CellInspector`, `format.ts` |
| `src/features/insight/` | Generated GraphQL, Plan, Messages, History panels |
| `src/features/chart/ChartPanel.tsx` | Auto-suggested charts (d3-scale/d3-shape, plain SVG) |
| `src/features/er/` | `relationships.ts` (nested + inferred joins), `ErDiagram` (dagre) |
| `src/styles/theme.css` | Design tokens for dark and light |

## Rules

- **Colours are tokens.** Use `bg-bg-1`, `text-ink-2`, `text-sql` (SQL side, cyan), `text-gql`
  (GraphQL side, magenta), etc. Light mode swaps values under `:root[data-theme='light']`.
- **Tailwind 4 tree-shakes `@theme` variables it cannot see used in source.** Anything referenced
  by a dynamically built name (the chart's `var(--color-series-${n})`) must be declared in a
  plain `:root {}` block, not `@theme`, or it silently disappears and marks render black.
- **Chart colours** are the validated categorical palette (`--color-series-1..8`). Assign slots in
  fixed order, never cycle past 8, keep a legend for 2+ series, and keep text in ink tokens,
  never series colours. If you change the palette, re-run the dataviz validator for both themes
  against the chart surface and record the result in the comment above the tokens.
- **Sorting, filtering and paging the grid run server-side** over the whole stored result
  (`applyView`, `loadMoreRows`), never over the loaded page.
- **Monaco** is bundled, not fetched from a CDN (`lib/monaco-setup.ts`). Its worker import path
  goes through the package's exports map: `monaco-editor/editor/editor.worker.js?worker`.
- Vite 8 uses Rolldown: `manualChunks` must be a function.
- **A failure with no result must still be visible**: `ResultDock` shows Messages when a run
  errors before any result arrives.
- New interactive surfaces need a stable hook for e2e tests; the dock is `data-testid="dock"`.

## Checking UI work

`npm run build` then `npm run test:e2e`. For anything visual, also look at it: the
`ui-verifier` agent drives the built app with Playwright in both themes and reviews screenshots.
Type-checking does not catch a black chart or a wrapping title bar.
