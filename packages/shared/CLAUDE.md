# packages/shared

Types shared by the server and the UI. There is no build step: packages import the TypeScript
source directly (`exports: "./src/index.ts"`).

- `catalog.ts` -- the relational catalog (`Catalog`, `CatalogTable`, `CatalogColumn`,
  `PaginationSpec`). The planner, SQL layer and UI all agree on this shape.
- `connection.ts` -- zod schemas for connections and pushdown profiles, plus `BUILTIN_PROFILES`.
  URL validation is a `refine`, deliberately, so it behaves the same across zod versions.
- `query.ts` -- plan entries, fetch stats, results, run requests.
- `events.ts` -- the SSE events streamed during a run.

A change here ripples to both sides: run `npm run typecheck` (it checks every package), then
update the producer in `packages/server` and every consumer in `packages/web`. Prefer adding an
optional field over changing an existing one.
