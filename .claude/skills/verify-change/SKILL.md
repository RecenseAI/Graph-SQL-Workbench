---
name: verify-change
description: Run the full verification sequence for a change to GraphQL Workbench before calling it done -- typecheck, unit/integration tests, browser tests, a real-API probe for engine changes, and a production start. Use after any code change, before committing, or when asked "does it work?".
---

# Verify a change

Run these in order and stop at the first failure. Report what ran and the actual output; never
say something passes without having run it.

## 1. Free the ports and the database lock

A leftover server holds ports 5470/5471 and the DuckDB file lock, which makes later steps fail in
confusing ways.

```powershell
foreach ($p in 5470,5471,5173) { Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force } }
```
(On macOS/Linux: `lsof -ti:5470,5471,5173 | xargs -r kill`.)

## 2. Types

```bash
npm run typecheck
```
Covers all four packages. No output after the header means clean.

## 3. Unit and integration tests

```bash
npm test
```
Expect every test to pass. If a test fails intermittently, suspect shared state (the DuckDB file,
ports, the demo API request log), not flakiness to be retried away.

## 4. Browser tests (if anything in `packages/web` or an API the UI calls changed)

```bash
npm run test:e2e
```
This builds the UI and starts both servers itself. If Chromium is missing:
`npx playwright install chromium`.

## 5. Real APIs (if `catalog/`, `plan/`, `fetch/` or `duck/` changed)

```bash
npx tsx scripts/probe-apis.ts            # catalog summary for every probe
npx tsx scripts/probe-apis.ts countries  # plus queries, per API
```
Compare with the "Tested against public APIs" table in `README.md`. Table counts, pagination
styles and query results should match unless the change was meant to alter them; if so, update
the table. A public API being down (HTML instead of JSON) is not a regression -- say so.

## 6. Production start (if build config, dependencies or `package.json` changed)

Start `npm start` in the background, wait for `app + api  http://127.0.0.1:5470` in its output,
then confirm `http://127.0.0.1:5470/` and `http://127.0.0.1:5471/health` both return 200. Stop it
afterwards (step 1). A BOM in `package.json` passes typecheck and tests but breaks this step.

## 7. Report

State which steps ran, their results (test counts, probe differences), and anything skipped and
why.
