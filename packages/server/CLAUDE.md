# packages/server

The HTTP API and the engine. About 80% of this package is the engine (`catalog/ sql/ plan/
fetch/ duck/`); only `routes/`, `store/` and `index.ts` are server-specific.

## The pipeline, and where each step lives

`routes/run.ts` streams a run over SSE. For each statement, `plan/planner.ts#runStatement`:

1. `sql/statements.ts#classifyStatement` -- SET / SHOW / DESCRIBE / MATERIALIZE / REFRESH / DROP
   SNAPSHOT are answered here and never reach DuckDB as-is.
2. `sql/prepass.ts#prepass` -- finds catalog tables in FROM/JOIN position (via `sql/lexer.ts`,
   so strings and comments are safe), strips `table(args)` and `@options`, and assigns one
   *binding* per distinct (table, args). Two bindings of one table get relations `users` and
   `users__wb2`.
3. `sql/analyze.ts#analyzeStatement` -- node-sql-parser AST -> columns per relation, pushable
   AND-ed predicates, outer-join nullability, LIMIT eligibility. **Optimisation only**: on a parse
   failure it returns `'*'` and no predicates, and results stay correct.
4. `planner.ts#buildRootPlans` -- child tables attach to their root fetch (created implicitly if
   the SQL joined only the child).
5. `plan/pushdown.ts#computePushdown` -- predicates -> GraphQL args, per connection profile.
6. `plan/document.ts#buildFetchDocument` -- builds the query as a graphql-js AST and prints it.
   Pagination values are variables so one document serves every page.
7. `fetch/paginate.ts#fetchTable` -- page loop, writes NDJSON with an injected `_rowid`, cache
   in `fetch/cache.ts`, HTTP in `fetch/client.ts` (retries, Retry-After, rate limits).
8. `duck/shred.ts#shredTable` -- `read_json(columns := {...})` typed from the catalog into a raw
   table, then a flattening VIEW; child lists unnested with `list_transform` to keep `_index`.
9. `duck/results.ts#executeStatement` -- runs the rewritten SQL into `wb_results.<id>` so the
   grid can page, sort and export without re-running.

Catalog: `catalog/introspect.ts` (introspection query variants, SDL fallback, per-connection
cache) -> `catalog/build.ts` (tables, columns, child tables, args, warnings) using
`catalog/pagination.ts` (relay / offset / page / none) and `catalog/typemap.ts`.

## Rules for changes here

- **Pushdown** (`pushdown.ts`, `analyze.ts`, the LIMIT block in `planner.ts`): read the
  invariants in the root `CLAUDE.md` first and use the `pushdown-safety-reviewer` agent on the
  diff. Every new pushdown path needs a test that the result is identical with pushdown on and off.
- **Catalog shape** (`build.ts`, `pagination.ts`): check against real schemas with
  `npx tsx scripts/probe-apis.ts`, not only the demo. Fields that take arguments are *not*
  expanded (they are queries of their own); lists become child tables only directly on the row;
  child-table cycles are cut. Relaxing any of these blew PokeAPI's catalog up to 35 MB.
- **Never mutate catalog objects** after build; they are cached and shared across runs.
- **Error messages**: `fail(code, message, detail, hint)` from `errors.ts`. The hint is shown
  to the user; make it an action.
- SQL text is built only through `duck/sql-util.ts` (`quoteIdent`, `quoteLiteral`,
  `assertSafeDuckType`). Never interpolate a user value into SQL directly.

## DuckDB and library quirks (each cost a debugging session)

- `getRowsJson()` returns BIGINT, HUGEINT and DECIMAL as **strings**; `duck/encode.ts` narrows
  them only when lossless.
- DuckDB's JSON type reports as **VARCHAR** (`to_json` included); `refineJsonColumns` detects
  JSON by sampling.
- `QUALIFY` cannot be combined with `GROUP BY ALL` in DuckDB -- list the grouping columns.
- Quote identifiers: GraphQL field names like `at` are DuckDB reserved words.
- Backslashes inside a DuckDB string literal are literal, so Windows paths embed as-is.
- **node-sql-parser is CommonJS**: `import sqlParser from 'node-sql-parser'; const { Parser } =
  sqlParser;`. A named import works under Vite/Vitest but crashes plain Node (the server).
- node-sql-parser AST: `column_ref.column` is usually `{ expr: { value } }` and `table` may be
  `{ value }` -- use `readColumnName`/`readTableName`. `distinct` is always an object (check
  `.type`), `over` is `null` on plain calls, `groupby` may be `{ columns }`. `GROUP BY ALL` is
  rewritten to `GROUP BY 1` before parsing.
- `graphql` 17: build AST nodes with explicit types (`NameNode`, `ArgumentNode`); `Kind.X as
  const` is a compile error. The printer wraps long argument lists and drops the commas, so tests
  should assert on the parsed AST, not printed text.
- On a POST, Fastify's `request.raw` 'close' fires when the *body* is read. Detect client
  disconnects on `reply.raw` 'close' (see `routes/run.ts`).

## Tests

`test/helpers/demo-server.ts` boots the demo API on an ephemeral port (`startDemoApi()`) and
builds connections (`demoConnection(endpoint, overrides)`, small pages so loops really loop).
End-to-end assertions compare against `packages/demo-api/src/expected.ts`, which computes the
same numbers in plain JS -- never hardcode an expected aggregate.

| File | Covers |
| --- | --- |
| `catalog.test.ts` | schema -> catalog on fixture SDL |
| `catalog-demo.test.ts` | live introspection, caching, SDL fallback |
| `fetch.test.ts` | document generation, every pagination style, retries, 429, cancel, cache |
| `prepass.test.ts` | lexer, argument syntax, bindings, statement analysis |
| `pushdown.test.ts` | every profile, auto discovery, and everything that must *not* be pushed |
| `pipeline.test.ts` | full SQL -> GraphQL -> DuckDB runs against ground truth |
