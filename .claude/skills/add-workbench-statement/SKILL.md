---
name: add-workbench-statement
description: Add a statement that Graph-SQL-Workbench answers itself rather than passing to DuckDB (like SHOW TABLES, DESCRIBE, SET, MATERIALIZE, REFRESH, DROP SNAPSHOT), or a MySQL-compatibility macro. Use when adding new SQL syntax, session settings or catalog commands.
---

# Add a workbench statement

## Statements

1. **Recognise it** -- `packages/server/src/sql/statements.ts#classifyStatement`. Add a variant to
   the `Special` union and a regex. Return `null` for anything that is not yours so DuckDB still
   gets its own syntax (for example `SET memory_limit` must pass through).
2. **Answer it** -- `packages/server/src/plan/planner.ts#handleSpecial`. Row-producing answers go
   through `valuesQuery(...)` so they reach the grid like any result; commands return
   `kind: 'command'` with a `message`. Anything that fetches should reuse `runStatement` (see
   `materialize`), not duplicate the pipeline.
3. **Session settings** live in `getSession(connectionId)`; add the key to `SessionSettings`,
   `SHOW SETTINGS`, and wherever the planner reads it (`resolveEngineOptions`).
4. **Make it discoverable** -- add it to the cheat sheet (`packages/web/src/app/HelpSheet.tsx`),
   the command palette (`packages/web/src/app/CommandPalette.tsx`) if it is useful on its own, the
   keyword list in `packages/web/src/lib/sql-language.ts`, and the README's SQL table.
5. **Test it** in `packages/server/test/pipeline.test.ts` ("workbench statements"), including a
   bad input with a usable error message.

## MySQL-compatibility macros

Add to `MACROS` in `packages/server/src/duck/macros.ts`. A macro must not shadow a DuckDB builtin
with different behaviour. Add it to `FUNCTIONS` in `packages/web/src/lib/sql-language.ts` for
completion, and cover it in the "runs MySQL-flavoured functions" test.

Then run `verify-change`.
