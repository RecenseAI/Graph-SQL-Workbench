# packages/demo-api

A local GraphQL API (port 5471) that deliberately mixes every shape the workbench must handle:
Relay `users`, offset `orders` (nodes + totalCount), Hasura-style `products(where:)`,
page/perPage `productsPaged`, single object `me`, scalars-only `serverInfo`, a union (`search`),
an interface (`node`), a self-referential field (`User.manager`), a deprecated field, nullable
nested objects, a scalar list (`tags`) and an object list (`Order.items`).

## Files

- `src/seed.ts` -- deterministic data from a seeded LCG. **The order of `rand()` calls is part of
  the contract**: inserting or reordering a call changes every downstream number and breaks the
  pinned values in `test/seed.test.ts`. Adding a field that doesn't consume `rand()` is safe.
- `src/expected.ts` -- ground truth computed in plain JS. End-to-end tests compare SQL results
  against these functions; add a function here instead of hardcoding a number in a test.
- `src/schema.ts` -- SDL and resolvers. `rootValue` resolves Query fields; `FIELD_RESOLVERS`
  covers nested ones.
- `src/server.ts` -- `buildDemoApp()` (used in-process by tests) and a CLI entry point.

## Endpoints and switches

- `POST /graphql` -- the API. `POST /graphql-strict` -- same data, introspection refused (tests
  the SDL fallback). `GET /sdl`, `GET /health`, `GET|DELETE /_demo/requests` (request log, used
  to assert how many calls a statement cost).
- Request headers: `x-demo-latency: <ms>`, `x-demo-fail-first: <n>` (503s), `x-demo-rate-limit:
  <n>` (429 + Retry-After), scoped by `x-demo-run: <key>`. Use these to test resilience rather
  than mocking fetch.
