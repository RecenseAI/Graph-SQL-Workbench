import { expect, test, type Page } from '@playwright/test';

/**
 * End-to-end: the real server, the real engine and the demo GraphQL API, driven through the UI.
 */

const DEMO = 'http://127.0.0.1:5471/graphql';

test.beforeAll(async ({ request }) => {
  const { connections } = (await (await request.get('/api/connections')).json()) as {
    connections: { endpoint: string }[];
  };
  if (!connections.some((c) => c.endpoint === DEMO)) {
    const res = await request.post('/api/connections', {
      data: { name: 'Demo API', endpoint: DEMO, pageSize: 200, maxRows: 20000, cacheTtlSeconds: 300 },
    });
    expect(res.ok()).toBeTruthy();
  }
});

async function open(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await page.addInitScript(() => localStorage.clear());
  await page.goto('/');
  await expect(page.locator('aside').getByText('users', { exact: true })).toBeVisible();
  return errors;
}

async function runEditor(page: Page, sql: string) {
  await page.locator('.monaco-editor').first().click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  // insertText lands as one input event, so auto-closing brackets cannot alter the statement.
  await page.keyboard.insertText(sql);
  await page.keyboard.press('Control+Enter');
}

test('runs a join GraphQL cannot express and shows correct numbers', async ({ page }) => {
  const errors = await open(page);
  await page.locator('.monaco-editor').first().click();
  await page.keyboard.press('Control+Enter');

  const grid = page.getByTestId('dock');
  await expect(grid.getByText('10 rows').first()).toBeVisible();
  await expect(grid.getByText('GB', { exact: true })).toBeVisible();
  await expect(grid.getByText('1,544,540.3')).toBeVisible();
  await expect(page.locator('footer')).toContainText('fetched');
  expect(errors).toEqual([]);
});

test('explains the translation in the GraphQL and Plan panels', async ({ page }) => {
  await open(page);
  await page.locator('.monaco-editor').first().click();
  await page.keyboard.press('Control+Enter');
  const dock = page.getByTestId('dock');
  await expect(dock.getByText('10 rows').first()).toBeVisible();

  await page.getByRole('tab', { name: /Generated GraphQL/ }).click();
  await expect(dock).toContainText('query WorkbenchFetch');
  await expect(dock).toContainText('status: PAID');

  await page.getByRole('tab', { name: /Plan/ }).click();
  await expect(dock).toContainText('users');
  await expect(dock).toContainText('never change the');

  await page.getByRole('tab', { name: /Chart/ }).click();
  await expect(dock.locator('svg path').first()).toBeVisible();
});

test('pushes a WHERE filter to the endpoint and reports it', async ({ page }) => {
  await open(page);
  await runEditor(page, "SELECT count(*) AS n FROM users WHERE country = 'DE' AND active = true;");
  const dock = page.getByTestId('dock');
  await expect(dock.getByText('1 rows').first()).toBeVisible();
  await page.getByRole('tab', { name: /Plan/ }).click();
  await expect(dock).toContainText('sent as');
});

test('sorts and filters the grid over the whole result', async ({ page }) => {
  await open(page);
  await runEditor(page, 'SELECT id, country, lifetimeValue FROM users;');
  const dock = page.getByTestId('dock');
  await expect(dock.getByText('800 rows').first()).toBeVisible();

  await dock.getByPlaceholder('Filter all columns').fill('DE');
  await dock.getByPlaceholder('Filter all columns').press('Enter');
  await expect(dock.getByText(/of 800/)).toBeVisible();

  await dock.getByRole('button', { name: /^lifetimeValue/ }).click();
  await expect(dock.getByText(/sorted by lifetimeValue asc/)).toBeVisible();
});

test('surfaces a GraphQL error instead of an empty grid', async ({ page }) => {
  await open(page);
  await runEditor(page, 'SELECT id FROM users(after: "bogus");');
  await expect(page.getByTestId('dock')).toContainText('Malformed cursor');
});

test('command palette runs workbench statements', async ({ page }) => {
  await open(page);
  await page.keyboard.press('Control+k');
  await page.keyboard.type('SHOW TABLES');
  await page.keyboard.press('Enter');
  const dock = page.getByTestId('dock');
  await expect(dock).toContainText('table_name');
  await expect(dock).toContainText('orders__items');
});

test('relationship view proposes the unmodelled join', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Relationship diagram' }).click();
  await expect(page.locator('aside')).toContainText('orders.userId');
  await page.getByRole('button', { name: 'Diagram', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('inferred join');
});

test('cheat sheet opens with F1', async ({ page }) => {
  await open(page);
  await page.keyboard.press('F1');
  await expect(page.getByRole('dialog')).toContainText('MATERIALIZE');
});
