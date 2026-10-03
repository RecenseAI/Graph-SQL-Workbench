---
name: onboard-graphql-api
description: Check how well Graph-SQL-Workbench handles a specific GraphQL endpoint (a user's API, a public API, a Dolt- or Hasura-backed server) and fix or configure what doesn't work. Use when someone asks "will this work with <API>?", reports a table missing, wrong pagination, too few rows, dates read as text, or filters not being pushed.
---

# Onboard a GraphQL API

## 1. Trace a query end to end

```bash
npx tsx scripts/run-sql.ts <endpoint> "SELECT * FROM <table> LIMIT 5"
```
Options: `--bearer <token>`, `--header "X-Name: value"` (repeatable), `--profile hasura|strapi|flat|none`,
`--depth <n>`, `--page-size <n>`, `--max-rows <n>`, `--no-pushdown`, `--sdl <file>`.

It prints, for each referenced table: the catalog entry (root field, row type, pagination spec,
args, columns, child tables), the exact GraphQL sent, which filters were pushed or kept local and
why, pages/requests/retries, the result, and warnings. Never paste a real token into a file or a
commit; pass it on the command line or via `${env:VAR}` in a connection header.

## 2. Diagnose from the trace

| Symptom | Likely cause | Where |
| --- | --- | --- |
| Catalog fails, "introspection disabled" | Endpoint refuses introspection | Get the SDL; `--sdl schema.graphql`, or paste it into the connection |
| A list shows `pagination: none` but the API does page | Paging args or wrapper not recognised | `catalog/pagination.ts` (`LIMIT_ARGS`, `OFFSET_ARGS`, `PAGE_ARGS`, `findNextIndicator`, wrapper regex) |
| A lookup like `thing(id:)` returns its nested list as rows | Object treated as a collection | `looksLikeCollection` in `catalog/pagination.ts` |
| Fewer rows than exist, no warning | Loop stopped early (short page with a server-chosen page size, missing next indicator) | `fetch/paginate.ts`, and the `nextPagePath`/`pageSizeKnown` plan fields |
| Dates, money or ids come back as `VARCHAR` | Custom scalar name not recognised | `catalog/typemap.ts` patterns, or the connection's scalar type map |
| "did not match its expected column types, read as text" | Scalar mapped to the wrong DuckDB type | Same as above |
| Filter kept local that the API supports | Unrecognised filter dialect | `plan/pushdown.ts` -- a profile, or `discoverFilterObject` / `AUTO_OPERATORS` |
| Many tables, huge catalog, warning flood | Schema shape we expand too eagerly | `catalog/build.ts` (arg-taking fields, child-table rules, caps) |
| Data sits inside a wrapper, e.g. `Page(page:) { media {...} }` or `branch(name:) { users {...} }` | Wrapper root fields are not yet split into tables | Not supported yet -- see the README "Tested against public APIs" table |

## 3. Configure before coding

Many problems are configuration, not bugs: auth, extra headers (a Dolt branch header), the
pushdown profile, depth, page size (must not exceed the API's own maximum), requests per second,
the scalar type map, pasted SDL. Try the connection options first.

## 4. If it is a bug, fix it generally

- Reproduce the failing shape as SDL in a unit test (`packages/server/test/catalog.test.ts`,
  `fetch.test.ts`, `pushdown.test.ts`). Do not make tests depend on a public API being up.
- If the demo API lacks the shape, consider adding it to `packages/demo-api` (see its
  `CLAUDE.md` -- do not disturb the seed's `rand()` order).
- Fix for the general pattern, not the one API. Then run
  `npx tsx scripts/probe-apis.ts` to confirm the other APIs did not regress.
- Pushdown changes must keep the invariants in the root `CLAUDE.md`; get the
  `pushdown-safety-reviewer` agent to review them.

## 5. Record it

If the API is public, add it to `PROBES` in `scripts/probe-apis.ts` with a couple of queries, and
to the README table with the honest result, including "partly supported".
