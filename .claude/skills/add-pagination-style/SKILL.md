---
name: add-pagination-style
description: Teach Graph-SQL-Workbench a new way that GraphQL APIs page through results (a new argument convention, a next-page field, a cursor inside a wrapper). Use when a probe or bug report shows a list API read as `pagination none`, stopping after one page, or looping.
---

# Add a pagination style

Pagination touches four places that must agree. Change them together.

## 1. Detect it -- `packages/server/src/catalog/pagination.ts`

`analyseRootField` decides, from the schema alone, the `PaginationSpec` for a root field:
`style` (`relay` | `offset` | `page` | `none`), `nodesPath` (where the rows are), and the argument
and field names the loop needs. Prefer extending the ordered candidate lists (`CURSOR_FIRST`,
`LIMIT_ARGS`, `PAGE_ARGS`, `NODE_LIST_NAMES`, `TOTAL_FIELDS`, `findNextIndicator`) over new
special cases. Only unwrap an object as a collection when something proves it is one
(`looksLikeCollection`); otherwise single-item lookups get misread.

If a new field is needed on the spec, add it as **optional** in
`packages/shared/src/catalog.ts` (e.g. `nextPagePath`).

## 2. Request it -- `packages/server/src/plan/document.ts`

`buildFetchDocument` adds the page-size argument, declares the page variable (so one document
serves every page), and selects whatever the loop must read back (pageInfo, a total, a next
indicator). A user-written value for the paging argument must *seed* the variable, not be emitted
twice. Expose anything the loop needs on `DocumentPlan`.

## 3. Follow it -- `packages/server/src/fetch/paginate.ts`

`fetchTable` stops on: an empty page; the endpoint saying there is no next page; a short page
*only when the page size is known* (`pageSizeKnown`); a repeated cursor (loop guard); the row
budget (which must warn); the absolute page cap. A new style must never silently return fewer
rows than exist and never loop forever.

## 4. Test it

- `packages/server/test/catalog.test.ts` -- SDL fixture -> expected `PaginationSpec`.
- `packages/server/test/fetch.test.ts` -- document shape (assert on the parsed AST, not printed
  text) and, if the demo API can serve it, a live loop that fetches every row.
- Add the shape to `packages/demo-api` if it is common enough to deserve an end-to-end test.
- Run `npx tsx scripts/probe-apis.ts` and check every API still pages as before.

Then run the `verify-change` skill.
