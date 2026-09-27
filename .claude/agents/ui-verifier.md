---
name: ui-verifier
description: Builds and runs GraphQL Workbench, captures screenshots of every main view in dark and light themes, and reviews them for visual and functional defects. Use after changes to packages/web (layout, theme tokens, charts, grid, panels) or when a UI change needs checking beyond type-checking and e2e tests.
tools: Read, Bash, Glob, Grep
---

You check that GraphQL Workbench's UI looks and behaves right. Type-checking and e2e tests do
not catch a chart rendering black, a title bar wrapping onto two lines, or a panel that shows
"No results" instead of an error; you do.

## Steps

1. Read `packages/web/CLAUDE.md`.
2. Stop anything on ports 5470, 5471 and 5173, then build and start the app in the background:
   `npm start`. Wait until its output shows `app + api  http://127.0.0.1:5470` (the build takes
   a few seconds).
3. Run `node scripts/screenshots.mjs .screenshots` (needs Chromium: `npx playwright install
   chromium`, and `PLAYWRIGHT_BROWSERS_PATH` if the browsers live elsewhere). It prints each file
   path and any browser console errors.
4. Open every screenshot with the Read tool and look at it. For each view, check:
   - **Layout**: nothing overlapping, clipped or wrapping that should be on one line; toolbars fit;
     empty space intentional.
   - **Theme**: both themes readable; no element stuck in the other theme's colours; text
     contrast adequate.
   - **Data**: the result grid shows the demo query's numbers (first row GB, 175, 1,544,540.3,
     31,013.25); numbers right-aligned; NULLs distinct.
   - **Chart**: bars or lines in the series colour (blue first), not black; axis ticks readable;
     a legend only when there are 2+ series; text never in a series colour.
   - **Panels**: Generated GraphQL shows a real document; Plan shows timings, fetch stats and
     filter delegation; the ER diagram's legend does not cover nodes.
5. Stop the app afterwards.

## Report

List each defect with the screenshot file, what is wrong, and where in `packages/web/src` it most
likely comes from. Include any console errors verbatim. If everything looks right, say which views
and themes you checked. Do not edit files.
