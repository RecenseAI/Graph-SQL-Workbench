# Plan: the engine as a library, plus a CLI

Status: **planned, not started**. Written 2026-09-27 against commit `5cc7cd3`.

## Why

Today the engine (schema -> catalog, SQL analysis, pushdown, GraphQL generation, pagination,
DuckDB) is only reachable by running the web app. As a library it can be used from scripts,
scheduled jobs, backends (including a frontend's own server routes), notebooks and CI, and a CLI
can be built on it. This is also the easiest way for other developers to try the project.

## Goals

- `packages/engine`: the engine as an importable Node library with a small, stable API.
- `packages/cli`: a command-line tool built only on that API.
- `packages/server` becomes a thin HTTP layer over the engine, with no behaviour change for the UI.
- Structure the engine as a runtime-neutral core plus a Node adapter, so a browser build stays
  possible later without a second rewrite.

## Non-goals (for this plan)

- A browser build (designed for below, built later only if there is a concrete use).
- A hosted multi-user deployment. That needs auth, per-user secrets, SSRF protection and
  multi-process storage; see "Hosted version" at the end.
- New query features. Wrapper root fields (AniList's `Page(...)`, a Dolt `branch(name:)` wrapper)
  are a separate piece of work; doing them first means the library launches with wider API
  coverage.

## Proposed API

```ts
import { createWorkbench, WorkbenchError } from '<package-name>';

const wb = await createWorkbench({
  dataDir: './.gql-cache',   // or ':memory:' (default) -- no files left behind
  cacheTtlSeconds: 300,      // 0 disables the fetch cache
  logger: console,           // optional; silent by default
});

const api = await wb.connect({
  endpoint: 'https://api.example.com/graphql',
  auth: { kind: 'bearer', token: process.env.TOKEN },
  headers: { 'X-Dolt-Branch': 'main' },
  pushdownProfile: 'auto',   // same options as the UI's connection form
  pageSize: 100,
  maxRows: 10_000,
  sdl: undefined,            // pass SDL when introspection is disabled
});

const catalog = await api.catalog();              // tables, columns, args, pagination

const result = await api.query(
  `SELECT country, SUM(total) AS revenue FROM orders(status: "PAID") GROUP BY 1`,
  { signal, onProgress: (e) => {}, pushdown: true, maxRows: 50_000 },
);
result.rows;        // [{ country: 'GB', revenue: 1544540.3 }, ...]  ('arrays' also available)
result.columns;     // names, DuckDB types, null counts
result.plan;        // GraphQL documents sent, filters pushed / kept local and why
result.stats;       // rows, pages, requests, bytes, cache hit, truncated
result.warnings;

const plan = await api.explain(sql);  // dry run: the GraphQL it *would* send, no fetching
await api.query('MATERIALIZE users(first: 5000) AS users_snap');

await wb.close();
```

Design rules:
- Everything the UI can configure on a connection is a `connect()` option; nothing is read from
  `workspace.json`, environment variables or fixed paths unless the caller passes them.
- Errors are `WorkbenchError` with the existing stable `code`, `message`, `hint`, `detail`.
- Every long operation accepts an `AbortSignal`.
- Large results: `query()` returns up to `resultRows` (default 10,000) and a
  `result.page(offset, limit)` for the rest, backed by the stored result table.
- **New capability: `explain()` as a dry run.** The planner currently always fetches; it needs a
  plan-only mode. That is useful on its own (checking what a query will cost before running it)
  and for the CLI's `--explain`.

## Package layout after the change

```
packages/
  shared/   types, unchanged (published or bundled -- decide in phase 3)
  engine/   core/     catalog, sql, plan, pagination loop, pushdown  (runtime-neutral)
            node/     native DuckDB, file-based NDJSON + cache, Node fetch
            index.ts  createWorkbench, public types, WorkbenchError
  cli/      bin: argument parsing and output formats, on the engine API only
  server/   routes + workspace/secrets/history store, on the engine API
  web/      unchanged
  demo-api/ unchanged
```

## What has to change (inventory at `5cc7cd3`)

**Global state in engine folders** -- each becomes a field of a per-workbench context object
(`EngineContext`) created by `createWorkbench`:

| Where | State | Becomes |
| --- | --- | --- |
| `duck/pool.ts` | `instancePromise`, `cachedVersion` | the context's DuckDB instance |
| `duck/results.ts` | `schemaReady` | per-instance flag |
| `duck/macros.ts` | `installed` | per-instance flag |
| `fetch/cache.ts` | `CACHE_DIR` (from `DATA_DIR`), `initialised` | from `dataDir`; memory store for `:memory:` |
| `fetch/limiter.ts` | `limiters` map | per-context map |
| `catalog/introspect.ts` | catalog `cache` map | per-context map |
| `sql/statements.ts` | `sessions` map | per-connection state |

**Imports of server-only modules** (13 today):
- `../log.ts` in 8 engine files -> an injected `Logger` interface, silent by default.
- `../env.ts` in `duck/pool.ts` and `fetch/cache.ts` -> `dataDir` / memory options from the context.
- `../store/workspace.ts` in `fetch/client.ts` (for `interpolateEnv`) -> the `${env:VAR}`
  expansion stays a server/CLI feature; the engine receives final header values.

**Other things to decide**:
- Consumers cannot run `.ts` sources, and `packages/shared` currently exports its source
  directly. The engine must be compiled to `dist/` (ESM + `.d.ts`) with an `exports` map.
- Module format: ESM only (`"type": "module"`), Node >= 20.11. CommonJS consumers use `import()`.
- `graphql` should be a regular dependency, not a peer: callers never pass schema objects in, and
  a shared peer copy risks graphql-js's "another module or realm" duplicate-instance error.
- `node-sql-parser` is CommonJS; keep the default-import pattern (see `packages/server/CLAUDE.md`).

## Phases

Each phase ends with the full suite passing (`verify-change` skill). No phase changes UI behaviour.

1. **Inject state (in place, no moves).** Introduce `EngineContext` and `Logger`, thread them
   through the engine, remove the module-level state above, and have the server create one context
   at startup. Add a test running two contexts side by side with different data dirs. *~1 day.*
2. **Move into `packages/engine`.** Move `catalog/ sql/ plan/ fetch/ duck/` plus `errors.ts`,
   split into `core/` and `node/`, move the engine tests with them, point the server at the
   package. *~0.5 day.*
3. **Public API.** `createWorkbench`, `connect`, `query`, `explain` (planner plan-only mode),
   `catalog`, `close`; result paging; typed exports; a build to `dist/`; a README with examples.
   API-level tests against the demo API. *~1–1.5 days.*
4. **CLI** (`packages/cli`). `<name> <endpoint> "<sql>"`, SQL from a file or stdin;
   `--format table|csv|json|ndjson|parquet`, `--output file`, `--header`, `--bearer`,
   `--bearer-env VAR`, `--profile`, `--max-rows`, `--explain`, `--no-pushdown`, `--sdl file`.
   Exit codes: 0 ok, 1 query error, 2 usage error. Tests with the demo API. *~0.5–1 day.*
5. **Packaging check.** `npm pack` both packages, install the tarballs into a clean temporary
   project, and import and run them from plain Node (not the monorepo). Run on Windows, macOS and
   Linux in CI. *~0.5 day.*
6. **Publish (when open-sourcing).** Choose the name (check npm and GitHub for clashes, including
   Hasura's `graphql-bench`), a scope such as `@recenseai/...`, semantic versioning starting at
   0.x, npm provenance from CI, a changelog. *~0.5 day.*

Total: about 4–5 days of focused work.

## Later: browser build (only with a concrete use case)

- Add a `browser/` adapter beside `node/`: DuckDB-Wasm instead of native DuckDB; rows handed to
  DuckDB from memory instead of NDJSON files; cache in memory or IndexedDB; exports as downloads.
- **Verify first**: that DuckDB-Wasm's `read_json` with an explicit `columns` spec behaves like the
  native one on registered in-memory data, including zero rows.
- Hard limits to document: CORS (only APIs that allow browser origins), tokens visible to the
  user, DuckDB-Wasm size (lazy-load it), tab memory.

## Later: hosted version (separate plan if ever wanted)

Needs, at minimum: authentication; per-user connections with encrypted secrets; an allowlist or
block of private address ranges for endpoint URLs (SSRF); per-user limits on rows, memory and
concurrency; storage that works with more than one server process (DuckDB is single-writer per
file).

## Risks

- `@duckdb/node-api` is still on `-r` release versions; its API may change. Pin it and keep all
  DuckDB calls inside `node/`.
- The DuckDB native binary is about 30 MB per platform, with no Windows-on-ARM build.
- Freezing a public API too early. Stay on 0.x until at least a few outside users have tried it.

## Definition of done

- The server and UI work exactly as before, and all existing tests pass.
- A clean project can `npm install` the packed engine and run a query against the demo API and
  one public API (Countries) on all three operating systems.
- The CLI produces CSV and JSON for the README examples.
- `README.md`, the root `CLAUDE.md` and each package's `CLAUDE.md` describe the new layout.
