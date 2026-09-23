import { expect, test, type Locator, type Page } from '@playwright/test';
import { DEMO_PASSWORD, ROLES, storageStateFor } from '../global-setup';

/**
 * Acceptance scenario 1 (brief §21): a visitor filters the 50 locations,
 * switches map/list (the map falls back honestly when no tile provider is
 * configured), compares four markets and saves a scenario; reload preserves
 * it. Unknown data never yields an invented price. Saving needs an account
 * (brief §5, `core.anonymous_scenarios` off): the visitor is sent to sign-in
 * with the explorer state in `next`, and the save completes after sign-in.
 *
 * Plus scenario 11's keyboard-only journey at 360 px: sign-in → portal home →
 * the request path, with Tab/Enter only and a visible focus indicator.
 *
 * Runs against a web app seeded with the demo accounts and with the
 * `core.anonymous_scenarios` flag off (the seed default).
 */

const MARKET_ROWS = 'ul[aria-label="Markets"] > li';
const TRAY_ITEMS = 'ul[aria-label="Markets in the comparison"] li';

async function resultCounts(results: Locator): Promise<{ matching: number; total: number }> {
  const summary = results.getByText(/\d+ of \d+ markets? match/);
  await expect(summary).toBeVisible();
  const [matching = 0, total = 0] = (await summary.innerText()).match(/\d+/g)?.map(Number) ?? [];
  return { matching, total };
}

/** The filter panel is a column on desktop and a bottom sheet on mobile. */
async function withFilters(page: Page, apply: (panel: Locator) => Promise<void>): Promise<void> {
  const sheetButton = page.getByRole('button', { name: /^Filters/ });
  const inSheet = await sheetButton.isVisible();
  if (inSheet) await sheetButton.click();
  const panel = inSheet
    ? page.getByRole('dialog', { name: 'Filters' }).getByTestId('filter-panel')
    : page.getByTestId('filter-panel');
  await expect(panel).toBeVisible();
  await apply(panel);
  if (inSheet) await page.getByRole('button', { name: 'Show results' }).click();
}

test.describe('acceptance scenario 1: explore, compare, save, reload', () => {
  test('anonymous exploration works, saving asks for an account and completes after sign-in', async ({
    page,
    browser,
  }) => {
    await page.goto('/explore?view=list');
    const results = page.getByTestId('results-list');
    const before = await resultCounts(results);
    expect(before.total).toBe(50);
    expect(before.matching).toBe(50);

    // Anonymous visitors are told what needs an account and what does not.
    const hint = page.getByTestId('account-hint');
    await expect(hint).toContainText('need no account');
    await expect(hint).toContainText('Saving, sharing, local verification and starting a service');
    await expect(hint.getByRole('link', { name: 'sign in' })).toHaveAttribute(
      'href',
      /^\/sign-in\?next=%2Fexplore/,
    );

    // Filter: objective and a preferred region narrow the list without an account.
    await withFilters(page, async (panel) => {
      await panel.getByLabel('Objective').selectOption('commercial');
      await panel.getByLabel('South West').check();
    });
    await expect(page).toHaveURL(/objective=commercial/);
    await expect(page).toHaveURL(/zones=SW/);
    await expect
      .poll(async () => (await resultCounts(results)).matching)
      .toBeLessThan(before.total);
    const filtered = await resultCounts(results);
    expect(filtered.matching).toBeGreaterThanOrEqual(5);

    // Map view: no tile provider in test environments, so the honest fallback
    // shows with a working way back to the equivalent list.
    const viewSwitch = page.getByRole('radiogroup', { name: 'Map or list view' });
    await viewSwitch.getByRole('radio', { name: 'Map' }).click();
    await expect(page.getByText('Map tiles are not configured yet')).toBeVisible();
    await page.getByRole('button', { name: 'Use the results list' }).click();
    await expect(viewSwitch.getByRole('radio', { name: 'List' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(page).toHaveURL(/view=list/);

    // Unknown data never becomes a price: rows needing local data carry no naira figure.
    // (The ranking status arrives with the recommendation response, after the list.)
    const rows = results.locator(MARKET_ROWS);
    const needingData = rows.filter({ hasText: 'More local data needed' });
    await expect(needingData.first()).toBeVisible();
    expect(await needingData.count()).toBeGreaterThan(0);
    for (const row of (await needingData.all()).slice(0, 5)) {
      const text = await row.innerText();
      expect(text).not.toContain('₦');
      expect(text).not.toMatch(/NGN\s?\d/);
    }

    // Compare four markets: the tray fills to 4/4 and the fifth button explains why it is disabled.
    for (let i = 0; i < 4; i += 1) {
      await rows.nth(i).getByRole('button', { name: 'Compare', exact: true }).click();
    }
    const tray = page.getByRole('region', { name: 'Comparison tray' });
    await expect(tray).toContainText('Compare (4/4)');
    await expect(tray.locator(TRAY_ITEMS)).toHaveCount(4);
    await expect(page).toHaveURL(/compare=[^&]+(,|%2C)[^&]+(,|%2C)[^&]+(,|%2C)[^&]+/);
    const fifth = rows.nth(4).getByRole('button', { name: 'Compare', exact: true });
    await expect(fifth).toBeDisabled();
    await expect(fifth).toHaveAttribute('title', 'Comparison tray is full (four markets)');
    const trayNames = await tray.locator(TRAY_ITEMS).allInnerTexts();

    // The comparison view shows all four with unknown cells left unknown.
    await tray.getByRole('button', { name: 'Compare', exact: true }).click();
    const comparison = page.getByRole('dialog', { name: /^Compare / });
    await expect(comparison).toBeVisible();
    const table = comparison.getByTestId('comparison-table');
    await expect(table).toBeVisible();
    await expect(table.locator('thead th')).toHaveCount(5);
    const cells = await table.locator('tbody td').allInnerTexts();
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) expect(cell).not.toContain('₦');
    expect(cells.some((cell) => cell.includes('Unknown'))).toBe(true);
    await expect(comparison).toContainText('no value was invented');
    await page.keyboard.press('Escape');
    await expect(comparison).toBeHidden();

    // Saving anonymously asks for an account and carries the whole explorer state along.
    const explorerUrl = new URL(page.url());
    await page.getByRole('button', { name: 'Save scenario' }).first().click();
    await page.waitForURL(/\/sign-in\?next=/);
    const next = new URL(page.url()).searchParams.get('next') ?? '';
    expect(next.startsWith('/explore?')).toBe(true);
    const carried = new URLSearchParams(next.slice(next.indexOf('?') + 1));
    expect(carried.get('resume')).toBe('save');
    expect(carried.get('objective')).toBe('commercial');
    expect(carried.get('zones')).toBe('SW');
    expect(carried.get('view')).toBe('list');
    expect(carried.get('compare')).toBe(explorerUrl.searchParams.get('compare'));
    expect(carried.get('compare')?.split(',')).toHaveLength(4);
    await expect(page.getByText('Sign in to save this scenario')).toBeVisible();
    const signInUrl = page.url();

    // Signed-in demo customer: the sign-in page sends them straight on, the
    // explorer restores the state from the URL and re-opens the save dialog.
    const signedIn = await browser.newContext({ storageState: storageStateFor('owner') });
    const customer = await signedIn.newPage();
    try {
      await customer.goto(signInUrl);
      await customer.waitForURL(/\/explore\?/);
      const dialog = customer.getByRole('dialog', { name: 'Save scenario' });
      await expect(dialog).toBeVisible();
      await expect(customer).not.toHaveURL(/resume=/);
      expect(new URL(customer.url()).searchParams.get('compare')).toBe(carried.get('compare'));
      // The modal hides the rest of the page from the accessibility tree, so
      // the tray is checked by test id here and by role once the dialog closes.
      await expect(customer.getByTestId('compare-tray')).toContainText('Compare (4/4)');
      await expect(dialog.getByLabel('Scenario name')).not.toHaveValue('');
      await dialog.getByLabel('Scenario name').fill('E2E scenario 1');
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(customer).toHaveURL(/scenario=/);
      await expect(dialog).toBeHidden();
      await expect(customer.getByRole('button', { name: 'Saved' }).first()).toBeVisible();
      await expect(customer.getByTestId('scenario-actions')).toContainText('in your account');
      const customerTray = customer.getByRole('region', { name: 'Comparison tray' });
      await expect(customerTray.locator(TRAY_ITEMS)).toHaveCount(4);
      expect(await customerTray.locator(TRAY_ITEMS).allInnerTexts()).toEqual(trayNames);

      // Reload preserves the same four markets and filters.
      await customer.reload();
      const customerResults = customer.getByTestId('results-list');
      const afterReload = await resultCounts(customerResults);
      expect(afterReload.matching).toBe(filtered.matching);
      await expect(customer).toHaveURL(/objective=commercial/);
      await expect(customer).toHaveURL(/zones=SW/);
      await expect(customerTray.locator(TRAY_ITEMS)).toHaveCount(4);
      expect(await customerTray.locator(TRAY_ITEMS).allInnerTexts()).toEqual(trayNames);
      await expect(customer.getByRole('button', { name: 'Saved' }).first()).toBeVisible();
      await expect(customer.getByTestId('scenario-actions')).toContainText('E2E scenario 1');
    } finally {
      await signedIn.close();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Keyboard-only journey at 360 px (acceptance scenario 11)                    */
/* -------------------------------------------------------------------------- */

async function activeElementIs(page: Page, target: Locator): Promise<boolean> {
  return target.evaluate((el) => el === document.activeElement).catch(() => false);
}

/** Presses Tab until `target` has focus (bounded), then asserts the focus ring is visible. */
async function tabTo(page: Page, target: Locator, maxTabs = 120): Promise<void> {
  for (let i = 0; i < maxTabs; i += 1) {
    if (await activeElementIs(page, target)) break;
    await page.keyboard.press('Tab');
  }
  expect(await activeElementIs(page, target), 'reached the target with Tab').toBe(true);
  const focus = await target.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      focusVisible: el.matches(':focus-visible'),
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
    };
  });
  expect(focus.focusVisible).toBe(true);
  expect(focus.outlineStyle).not.toBe('none');
  expect(focus.outlineWidth).not.toBe('0px');
}

test.describe('keyboard-only journey at 360 px', () => {
  test('sign-in, portal home and the request path work with Tab and Enter only', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'mobile-360',
      'the 360 px keyboard journey runs on the mobile project only',
    );
    await page.goto('/sign-in');
    await tabTo(page, page.getByLabel('Email'));
    await page.keyboard.type(ROLES.owner);
    await page.keyboard.press('Tab');
    expect(await activeElementIs(page, page.getByLabel('Password'))).toBe(true);
    await page.keyboard.type(DEMO_PASSWORD);
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/(portal|onboarding)/);
    expect(new URL(page.url()).pathname).toBe('/portal');
    await expect(page.getByRole('main')).toBeVisible();

    // Portal home → requests, through the primary navigation.
    await tabTo(
      page,
      page.getByRole('navigation', { name: 'Portal' }).getByRole('link', {
        name: 'Requests',
      }),
    );
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/portal\/requests$/);
    await expect(page.getByRole('heading', { name: 'Requests' })).toBeVisible();

    // Open a request when one exists (the visible reference link: the table is
    // stacked into cards at 360 px); otherwise the path to start one.
    const existing = page
      .getByRole('main')
      .getByRole('link', { name: /^SR-\d{4}-\d+$/ })
      .first();
    if (await existing.count()) {
      await tabTo(page, existing);
      await page.keyboard.press('Enter');
      await page.waitForURL(/\/portal\/requests\/[0-9a-f-]{36}$/);
    } else {
      await tabTo(page, page.getByRole('link', { name: /^(New request|Start a request)$/ }));
      await page.keyboard.press('Enter');
      await page.waitForURL(/\/portal\/requests\/new$/);
      await expect(page.getByRole('heading', { name: 'New request' })).toBeVisible();
      await expect(page.getByLabel('Title')).toBeVisible();
    }
    await expect(page.getByRole('main')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
