# GraphQL Workbench

A SQL IDE for any GraphQL endpoint. **GraphQL fetches, DuckDB computes**: SQL is parsed, turned
into GraphQL requests (with filter pushdown and pagination), the JSON is loaded into DuckDB, and
the user's full SQL runs locally. Read `README.md` for the product; this file is for changing it.

## Layout

| Package | What it is | Guide |
| --- | --- | --- |
| `packages/shared` | Types shared by server and UI (catalog, plan, result, SSE events) | `packages/shared/CLAUDE.md` |
| `packages/server` | Fastify API + the engine: catalog, SQL analysis, planner, fetcher, DuckDB | `packages/server/CLAUDE.md` |
| `packages/web` | React 19 UI: Monaco editor, virtualised grid, charts, ER diagram | `packages/web/CLAUDE.md` |
| `packages/demo-api` | Deterministic GraphQL API used by tests and first-run demos | `packages/demo-api/CLAUDE.md` |
| `e2e/` | Playwright tests driving the real app | |
| `scripts/` | `probe-apis.ts` (real public APIs), `run-sql.ts` (one statement, full trace) | |
| `docs/plans/` | Agreed plans not yet implemented -- read before starting related work | |

Ports: workbench API `5470`, demo API `5471`, Vite dev UI `5173`.

## Commands

```bash
npm install
npm run dev            # demo API + workbench API + Vite UI, hot reload
npm start              # build UI, serve app + API on :5470, plus the demo API
npm run typecheck      # tsc over every package -- run before claiming anything compiles
npm test               # vitest: unit + integration (boots the demo API in-process)
npm run test:e2e       # playwright; builds the UI and starts servers itself
npx tsx scripts/run-sql.ts <endpoint> "<sql>"     # trace one statement end to end
npx tsx scripts/probe-apis.ts [name]              # catalog + queries against public APIs
```

`test:e2e` needs Chromium: `npx playwright install chromium` (set `PLAYWRIGHT_BROWSERS_PATH` if
browsers live elsewhere).

## Definition of done

A change is done when `npm run typecheck`, `npm test` and, for anything the UI touches,
`npm run test:e2e` all pass. For engine changes that affect how schemas or pages are read, also
run `npx tsx scripts/probe-apis.ts` and compare against the table in the README. The
`verify-change` skill has the full sequence.

## Invariants that must not break

These were each learned from a real bug. Tests cover them; do not weaken the tests.

1. **Pushdown is only a fetch optimisation.** A predicate sent to the endpoint is *also* kept in
   the SQL. That protects against an upstream filter that is looser than SQL, but *not* one that
   is stricter -- so only push through arguments the introspected schema declares, with a
   compatible type, via operators whose meaning is unambiguous (`eq gt in ...`, never
   `contains`/`regex`). The test "returns identical rows whether or not filters are pushed" is
   the contract.
2. **LIMIT goes upstream only when it cannot change the answer**: one table, no join, aggregate,
   window, DISTINCT or ORDER BY, and *every* WHERE term delegated.
3. **Zero rows still produce typed columns.** Column types come from the catalog, never from
   DuckDB sampling.
4. **Truncation is always reported.** Stopping at the row budget warns; stopping where the
   statement asked (`first:`/`limit:`/pushed LIMIT) does not.
5. **Catalog objects are shared and never mutated** after `buildCatalog` returns.
6. **The workbench is read-only.** Mutations and subscriptions are refused.
7. **The fetch cache key includes request headers** (branch headers, tenants, tokens).

## Environment gotchas (Windows especially)

- PowerShell 5 `Set-Content -Encoding utf8` and `Out-File` write a **BOM**; a BOM in
  `package.json` breaks the Vite build. Write files with the editor tools, or
  `[IO.File]::WriteAllText(path, text, (New-Object Text.UTF8Encoding($false)))`.
- Some files have CRLF endings; exact-match replacements from PowerShell here-strings (LF) will
  silently miss. Prefer the Edit tool. The repo normalises to LF on commit via `.gitattributes`.
- **DuckDB allows one process per database file.** A running workbench locks
  `%APPDATA%\graphql-workbench\cache.duckdb`. Use `GQLWB_DATA_DIR` for anything that must run
  alongside it. Vitest gives each worker its own dir (`vitest.setup.ts`).
- Stop leftover servers before re-running: find the PID listening on 5470/5471 and stop it.
- Background processes started with `&` in one shell call may not survive to the next.

## Conventions

- TypeScript strict with `noUncheckedIndexedAccess`; no `any` in `src/` (tests may use it).
- Comments explain *why*, in full sentences; match the surrounding density.
- Errors a user can hit go through `fail(code, message, detail?, hint?)` in
  `packages/server/src/errors.ts`, with a hint that says what to do next.
- User-visible text is plain and specific; say what happened and what to do.
- Commit messages: imperative subject, a body explaining why.
