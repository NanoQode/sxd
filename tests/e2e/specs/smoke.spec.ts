import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Smoke and accessibility checks against a running web app seeded with the
 * demo accounts (pnpm db:seed && pnpm --filter @simplexd/web seed:demo).
 */

const DEMO_PASSWORD = 'DemoPassword-2026!';

test('health endpoint reports database ok', async ({ request }) => {
  const res = await request.get('/api/v1/health');
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { ok: boolean; database: string };
  expect(body.ok).toBe(true);
  expect(body.database).toBe('ok');
});

test('homepage renders and has no critical accessibility violations @a11y', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('main')).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
  const critical = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  expect(critical, JSON.stringify(critical.map((v) => ({ id: v.id, nodes: v.nodes.length })), null, 2)).toEqual([]);
});

test('sign-in page is keyboard operable and themed @a11y', async ({ page }) => {
  await page.goto('/sign-in');
  await page.keyboard.press('Tab');
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  expect(results.violations.filter((v) => v.impact === 'critical')).toEqual([]);
  await page.locator('[role="radiogroup"][aria-label="Colour theme"] [role="radio"]').nth(1).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('demo customer can sign in and reach the portal', async ({ page }) => {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill('owner@demo.simplexd.local');
  await page.getByLabel('Password').fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/(portal|onboarding)/);
  expect(page.url()).toMatch(/\/(portal|onboarding)/);
});

test('private surfaces redirect anonymous visitors to sign-in', async ({ page }) => {
  await page.goto('/admin');
  await page.waitForURL(/\/sign-in\?next=%2Fadmin/);
});
