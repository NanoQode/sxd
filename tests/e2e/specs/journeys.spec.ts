import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { storageStateFor, type DemoRole } from '../global-setup';

/**
 * End-to-end journeys across every surface, run at desktop width and at 360 px
 * (the `mobile-360` project). Each page is checked for serious or critical
 * accessibility violations and for horizontal page scroll. Requires the demo
 * seed (pnpm db:seed && pnpm --filter @simplexd/web seed:demo); signed-in
 * journeys reuse the sessions created by global-setup.ts.
 */

async function expectAccessible(page: Page, label: string) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag22aa'])
    .analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'critical' || v.impact === 'serious',
  );
  expect(
    serious,
    `${label}: ${JSON.stringify(
      serious.map((v) => ({
        id: v.id,
        nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')),
      })),
      null,
      2,
    )}`,
  ).toEqual([]);
}

async function expectNoHorizontalScroll(page: Page, label: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `${label} scrolls horizontally by ${overflow}px`).toBeLessThanOrEqual(1);
}

const PUBLIC_PAGES = [
  '/',
  '/services',
  '/pricing',
  '/how-it-works',
  '/locations',
  '/explore?view=list',
  '/diaspora',
  '/contact',
  '/book',
];

test.describe('public website', () => {
  for (const path of PUBLIC_PAGES) {
    test(`${path} is accessible and fits the viewport @a11y`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole('main')).toBeVisible();
      await page.waitForLoadState('networkidle');
      await expectAccessible(page, path);
      await expectNoHorizontalScroll(page, path);
    });
  }

  test('an unknown address answers with the not-found page', async ({ page }) => {
    const res = await page.goto('/this-page-does-not-exist');
    expect(res?.status()).toBe(404);
    await expect(page.getByRole('main')).toBeVisible();
  });
});

test.describe('dark theme and reduced motion', () => {
  test.use({ colorScheme: 'dark', reducedMotion: 'reduce' });

  for (const path of ['/', '/explore?view=list', '/sign-in']) {
    test(`${path} follows the system dark theme @a11y`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole('main')).toBeVisible();
      await page.waitForLoadState('networkidle');
      const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      // Dark surfaces are near-black; light surfaces are near-white.
      const [r = 255, g = 255, b = 255] = background.match(/\d+/g)?.map(Number) ?? [];
      expect(r + g + b, `body background ${background}`).toBeLessThan(200);
      const motion = await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--sx-motion-base').trim(),
      );
      // Browsers may serialise the zero duration as 0s or 0ms.
      expect(motion).toMatch(/^0m?s$/);
      await expectAccessible(page, `${path} (dark)`);
    });
  }
});

test.describe('location explorer', () => {
  test('filter, compare, save a scenario and restore it after reload', async ({ page }) => {
    await page.goto('/explore?view=list&q=Lagos');
    const results = page.getByTestId('results-list');
    await expect(results.getByText(/\d+ of \d+ markets? match/)).toBeVisible();
    const summary = await results.getByText(/\d+ of \d+ markets? match/).innerText();
    const [matching = 0, total = 0] = summary.match(/\d+/g)?.map(Number) ?? [];
    expect(matching).toBeGreaterThan(0);
    expect(matching).toBeLessThan(total);

    const firstMarket = results.locator('ul[aria-label="Markets"] > li').first();
    await firstMarket.getByRole('button', { name: 'Compare', exact: true }).click();
    const tray = page.getByRole('region', { name: 'Comparison tray' });
    await expect(tray.locator('ul[aria-label="Markets in the comparison"] li')).toHaveCount(1);
    await expect(page).toHaveURL(/compare=/);

    await page.getByRole('button', { name: 'Save scenario' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Save scenario' });
    await dialog.getByLabel('Scenario name').fill('E2E Lagos shortlist');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page).toHaveURL(/scenario=/);

    await page.reload();
    await expect(
      page
        .getByRole('region', { name: 'Comparison tray' })
        .locator('ul[aria-label="Markets in the comparison"] li'),
    ).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Saved' }).first()).toBeVisible();
  });
});

const SIGNED_IN: { role: DemoRole; pages: string[] }[] = [
  {
    role: 'owner',
    pages: ['/portal', '/portal/properties', '/portal/requests', '/portal/invoices'],
  },
  { role: 'tenant', pages: ['/tenant'] },
  { role: 'contractor', pages: ['/partner', '/partner/assignments', '/partner/availability'] },
  {
    role: 'admin',
    pages: ['/admin', '/admin/market-data', '/admin/integrations', '/admin/finance'],
  },
];

for (const { role, pages } of SIGNED_IN) {
  test.describe(`signed-in ${role}`, () => {
    test.use({ storageState: storageStateFor(role) });

    test(`${role} workspace is accessible and fits the viewport @a11y`, async ({ page }) => {
      for (const path of pages) {
        const res = await page.goto(path);
        expect(res?.status(), path).toBeLessThan(400);
        expect(new URL(page.url()).pathname, `${path} redirected`).toBe(path);
        await expect(page.getByRole('main')).toBeVisible();
        await page.waitForLoadState('networkidle');
        await expectAccessible(page, path);
        await expectNoHorizontalScroll(page, path);
      }
    });
  });
}

test.describe('authorisation boundaries', () => {
  test.use({ storageState: storageStateFor('owner') });

  test('a customer cannot open the admin console', async ({ page }) => {
    const res = await page.goto('/admin');
    const landed = new URL(page.url()).pathname;
    expect(res?.status() === 404 || res?.status() === 403 || !landed.startsWith('/admin')).toBe(
      true,
    );
  });
});
