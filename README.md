# GraphQL Workbench

A MySQL-Workbench-style SQL IDE for **any** GraphQL endpoint.

GraphQL fetches data, but it can't query it: you can't join two root fields on a relationship the
schema doesn't model, and you can't use `GROUP BY`, `SUM`, `MAX` or `RANK()`. This tool adds all
of that:

> **GraphQL fetches. DuckDB computes.**

Point it at an endpoint and every field on the `Query` type becomes a table. When you write SQL,
the workbench:

1. works out which GraphQL requests it needs,
2. sends the filters the endpoint supports as arguments,
3. pages through the results,
4. loads the JSON into typed DuckDB tables,
5. runs your full SQL locally.

```sql
SELECT u.country,
       COUNT(*)     AS orders,
       SUM(o.total) AS revenue,
       MAX(o.total) AS biggest
FROM users u
JOIN orders(status: "PAID") o ON o.userId = u.id
GROUP BY u.country
ORDER BY revenue DESC;
```

Neither `users` nor `orders` knows about the other. The join is yours.

## Quick start

Requires Node 20.11 or newer.

```bash
npm install
npm start          # builds the UI, then serves the app and a demo API
```

Open **http://localhost:5470**. On first launch, add a connection (the form is pre-filled with
the bundled demo API at `http://127.0.0.1:5471/graphql`), then press **Ctrl+Enter**.

For development with hot reload:

```bash
npm run dev        # demo API :5471, workbench API :5470, Vite UI :5173
```

## What you can write

The dialect is **DuckDB SQL**, which is close to PostgreSQL. Window functions, CTEs, `QUALIFY`,
`PIVOT`, `UNNEST` and `GROUP BY ALL` all work. Common MySQL functions (`IFNULL`, `DATE_FORMAT`,
`CHAR_LENGTH`, `STR_TO_DATE` …) are provided as macros.

On top of that, the workbench adds:

| Syntax | What it does |
| --- | --- |
| `FROM users(first: 500, role: ADMIN)` | GraphQL arguments, written as the endpoint documents them. `first:` / `limit:` also cap how many rows are fetched. |
| `JOIN orders o ON o.userId = u.id` | Join anything to anything, whether or not the schema models the relationship. |
| `JOIN orders__items i ON i._parent_rowid = o._rowid` | A list of objects inside a row becomes its own child table. |
| `FROM users(@maxRows: 50000, @pageSize: 500)` | Engine options: `@maxRows`, `@pageSize`, `@allPages`, `@cache`, `@depth`. |
| `SELECT _raw FROM users` | Every row as the endpoint returned it. This is the escape hatch for anything that couldn't be flattened. |
| `SHOW TABLES` / `DESCRIBE users` / `SHOW SETTINGS` | Read the catalog: GraphQL and DuckDB types side by side. |
| `SET pushdown = off` / `SET max_rows = 50000` | Change settings for the rest of the session. |
| `MATERIALIZE users(first: 5000) AS snap` | Save a fetch as a real table that still works when the endpoint is offline. Also `REFRESH snap`, `DROP SNAPSHOT snap`, `SHOW SNAPSHOTS`. |

Press **F1** in the app for the full cheat sheet.

## The workbench

- **Schema tree.** Tables, flattened columns, types, arguments and pagination style. Click a column
  to insert it. The ▷ button next to a table runs `SELECT * … LIMIT 100`.
- **Editor.** Completion comes from the connected schema and understands aliases (after `u.` it
  offers that table's columns; inside `users(` it offers that field's GraphQL arguments). Hovering
  shows docs, and unknown tables get a warning squiggle.
  - **Ctrl+Enter** runs the whole script.
  - **Ctrl+Shift+Enter** runs only the statement under the cursor.
- **Result grid.** Rows and columns are virtualised, so large results scroll smoothly. NULLs are
  styled distinctly, numbers are right-aligned, and JSON cells can be expanded.
  - Sorting and filtering run in DuckDB over the **whole** result, not just the loaded page.
  - You can resize and pin columns, and select a range to copy it as TSV.
  - Export to CSV, JSON, Parquet, Markdown or SQL INSERTs.
- **Generated GraphQL.** The exact documents and variables that were sent. You can copy them or
  open them in a GraphQL tab.
- **Plan.** Shows:
  - which filters were sent to the endpoint and which stayed local (with the reason for each),
  - rows, pages, requests, bytes, and whether each fetch was a cache hit,
  - a timing breakdown,
  - DuckDB's `EXPLAIN` output.
- **Chart.** Suggests a form from the result's shape: a line for time series, columns for
  categories, a scatter for two measures. The palette has been checked for colour-blind safety in
  both themes.
- **Relationships.** Lists joins guessed from column names (for example `orders.userId → users.id`)
  alongside the certain nested ones, and draws them as a diagram.
- **GraphQL tab.** Talks to the endpoint directly. It's read-only: mutations are refused.
- Also: a command palette (**Ctrl+K**), history, and dark and light themes.

## Filter pushdown, and why it's safe

A `WHERE` filter is sent as a GraphQL argument only when the schema actually has a matching
argument with a compatible type. Each connection has a pushdown profile:

| Profile | Filters it sends |
| --- | --- |
| `auto` | Exact argument names, equality only. Safe for any endpoint. |
| `hasura` | `where: {col: {_eq: …}}` |
| `strapi` | Strapi's filter format |
| `flat` | Arguments named like `col_gt` |
| `none` | Nothing. All filtering happens locally. |

**A filter that's sent to the endpoint is also kept in the SQL.** So if the workbench misreads what
an argument means, the only effect is fetching more rows than necessary. The answer never changes.
The test suite checks this: the same query runs with pushdown on and off, and the results must match.

## Architecture

```
Browser (React 19) --SSE--> Fastify server --HTTP--> GraphQL endpoint
                             pre-pass -> analyse -> plan -> fetch/paginate -> shred -> DuckDB
```

| Package | Role |
| --- | --- |
| `packages/shared` | Types shared by the server and the UI |
| `packages/server` | Catalog, planner, pushdown, fetcher, cache, DuckDB engine, HTTP API |
| `packages/web` | The UI (Monaco editor, virtualised grid, charts, ER diagram) |
| `packages/demo-api` | A local GraphQL endpoint that covers Relay, offset, page-based and Hasura-style APIs |

There are two reasons it runs a server instead of being browser-only:

- Browsers can't POST to arbitrary third-party endpoints because of CORS.
- Native DuckDB gives real memory limits, can spill to disk, and writes Parquet.

## Connections

A connection has:

- an endpoint and authentication (bearer token, custom header, or basic auth),
- extra headers (`${env:VAR}` is replaced with an environment variable),
- a pushdown profile,
- column depth, page size, row budget, concurrency, requests per second, timeout and cache lifetime,
- custom scalar types (for example `{"Money": "DECIMAL(38,9)"}`),
- optionally, pasted **SDL** for endpoints that have introspection disabled.

Tokens are kept in a separate `secrets.json`, so `workspace.json` holds no secrets and can be
shared.

Local state lives in `%APPDATA%\graphql-workbench` on Windows,
`~/Library/Application Support/graphql-workbench` on macOS, or `$XDG_DATA_HOME/graphql-workbench`
on Linux. Set `GQLWB_DATA_DIR` to use a different folder. Only one running instance can open that
folder's database at a time.

## Tests

```bash
npm test           # 207 unit + integration tests (catalog, pre-pass, pushdown, fetcher, full pipeline)
npm run test:e2e   # 8 browser tests driving the real app (Playwright)
npm run typecheck
```

The end-to-end suite runs queries through the full stack against the demo API and compares the
results with totals computed independently in plain JavaScript from the same seed data.

For `test:e2e`, Playwright needs a Chromium build. Run `npx playwright install chromium` once. If
your browsers live elsewhere, set `PLAYWRIGHT_BROWSERS_PATH`.

## Limitations

- **Row budget.** Rows are fetched before they're computed over, so analysis is capped by the row
  budget (default 10,000 per table; you can raise it). When a fetch is cut short, the workbench
  always says so.
- **Pushdown needs matching arguments.** Filters only go to the endpoint when it has an argument
  for them. Otherwise everything is fetched and filtered locally.
- **Interfaces and unions.** Fields that exist only on one concrete type under an interface or
  union are reachable only through `_raw`.
- **`QUALIFY` + `GROUP BY ALL`.** DuckDB can't combine these. List the grouping columns explicitly.
- **Read-only.** Mutations are deliberately not supported.
