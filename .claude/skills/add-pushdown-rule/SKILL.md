---
name: add-pushdown-rule
description: Add or change how SQL WHERE predicates or LIMIT are sent to a GraphQL endpoint as arguments -- a new pushdown profile, a new filter dialect, new operators, or LIMIT/ORDER BY handling. Use for anything in plan/pushdown.ts, sql/analyze.ts predicate extraction, or the LIMIT block in plan/planner.ts.
---

# Add a pushdown rule

Pushdown decides what the endpoint filters for us. A wrong rule is the one kind of bug in this
project that returns a **wrong answer silently**, so the bar is higher than elsewhere.

## The safety model (read before changing anything)

- A pushed predicate is also kept in the SQL. That removes extra rows if the upstream filter is
  **looser** than SQL.
- Nothing recovers rows an upstream filter wrongly **dropped**. So a predicate may be pushed only
  when:
  1. the argument or filter-object path exists in the introspected catalog,
  2. the literal's type is compatible (`typesAgree`), including enum membership,
  3. the operator's meaning is unambiguous across APIs. `eq ne gt gte lt lte in nin isNull` yes;
     `contains like regex search startsWith` no, unless a profile the user chose says otherwise,
  4. it comes from the top-level AND chain of the outermost WHERE (never under OR/NOT), and the
     relation is not on the nullable side of an outer join.
- Never overwrite an argument the user wrote by hand.
- LIMIT is pushed only for a single-relation scan with no join, aggregate, window, DISTINCT or
  ORDER BY, and only when every WHERE term was delegated (`analysis.whereTerms` vs pushed).

## Where things live

- `packages/server/src/sql/analyze.ts` -- extracts `ExtractedPredicate`s and LIMIT eligibility
  from the node-sql-parser AST (see the AST quirks in `packages/server/CLAUDE.md`).
- `packages/server/src/plan/pushdown.ts` -- `computePushdown`, `resolveTarget` (profiles),
  `discoverFilterObject` + `AUTO_OPERATORS` (the auto profile's schema discovery), `mergeArgs`.
- `packages/shared/src/connection.ts` -- `BUILTIN_PROFILES` and the profile schema.
- `packages/server/src/plan/planner.ts` -- applies pushdown and the LIMIT rule per root fetch.

## Required tests

In `packages/server/test/pushdown.test.ts`: the new mapping is produced, **and** the nearby cases
that must not be pushed are refused with a readable reason.

In `packages/server/test/pipeline.test.ts`, against the demo API: the same statement with
`pushdownOverride: true` and `false` returns identical rows, and the pushed run fetches fewer.

Then ask the `pushdown-safety-reviewer` agent to review the diff, and run `verify-change`.
