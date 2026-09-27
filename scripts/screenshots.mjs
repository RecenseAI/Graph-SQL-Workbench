/**
 * Drives the running app through its main views in both themes and saves screenshots, plus any
 * console errors. Type-checking cannot catch a black chart or a wrapping title bar; this can.
 *
 * Requires the app on :5470 and the demo API on :5471 (npm start), with a connection to the demo
 * API (created here if missing).
 *
 *   node scripts/screenshots.mjs [outDir]      # default .screenshots/
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const BASE = process.env.GQLWB_URL ?? 'http://127.0.0.1:5470';
const DEMO = 'http://127.0.0.1:5471/graphql';
const outDir = process.argv[2] ?? '.screenshots';
mkdirSync(outDir, { recursive: true });

const list = await (await fetch(`${BASE}/api/connections`)).json();
if (!list.connections.some((c) => c.endpoint === DEMO)) {
  await fetch(`${BASE}/api/connections`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Demo API', endpoint: DEMO, cacheTtlSeconds: 300 }),
  });
}

const browser = await chromium.launch();
const errors = [];

for (const theme of ['dark', 'light']) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 920 }, colorScheme: theme });
  page.on('pageerror', (err) => errors.push(`[${theme}] pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`[${theme}] console: ${msg.text()}`);
  });
  await page.addInitScript(() => localStorage.clear());
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.locator('aside').getByText('users', { exact: true }).waitFor({ timeout: 20_000 });

  const shot = async (name) => {
    const file = join(outDir, `${theme}-${name}.png`);
    await page.screenshot({ path: file });
    console.log(file);
  };

  await shot('01-start');
  await page.locator('.monaco-editor').first().click();
  await page.keyboard.press('Control+Enter');
  await page.getByTestId('dock').getByText(/\d+ rows/).first().waitFor({ timeout: 30_000 });
  await shot('02-result-grid');

  for (const [tab, name] of [['Generated GraphQL', '03-generated-graphql'], ['Plan', '04-plan'], ['Chart', '05-chart'], ['Messages', '06-messages']]) {
    await page.getByRole('tab', { name: new RegExp(tab) }).click();
    await page.waitForTimeout(600);
    await shot(name);
  }

  await page.getByRole('button', { name: 'Relationship diagram' }).click();
  await page.getByRole('button', { name: 'Diagram', exact: true }).click();
  await page.waitForTimeout(800);
  await shot('07-er-diagram');
  await page.keyboard.press('Escape');

  await page.keyboard.press('F1');
  await page.waitForTimeout(400);
  await shot('08-cheat-sheet');
  await page.keyboard.press('Escape');

  await page.keyboard.press('Control+k');
  await page.keyboard.type('show');
  await page.waitForTimeout(400);
  await shot('09-command-palette');
  await page.close();
}

await browser.close();
console.log(`\nconsole errors: ${errors.length}`);
for (const error of errors) console.log(`  ${error}`);
process.exitCode = errors.length ? 1 : 0;
