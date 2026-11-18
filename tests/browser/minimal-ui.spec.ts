import { test, expect, type APIRequestContext } from '@playwright/test';
import { initialWorkspace } from '../../lib/types';

const control = `http://127.0.0.1:${process.env.OPEN_HARNESS_TEST_PORT || 4317}`;

async function seed(request: APIRequestContext) {
  const { token } = await (await request.get(control + '/v1/bootstrap')).json();
  await request.post(control + '/v1/agents/sync', {
    headers: { Authorization: `Bearer ${token}` },
    data: { agents: initialWorkspace.agents },
  });
}

async function openNavigation(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Open navigation' }).click();
}

test.beforeEach(async ({ request, page }) => {
  await seed(request);
  await page.addInitScript(() => {
    localStorage.setItem('open-harness.onboarding.v1', 'done');
    localStorage.setItem('open-harness.advanced.v1', 'on');
  });
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  await expect(page.getByRole('button', { name: 'Edit Atlas profile' })).toBeVisible();
});

test.afterEach(async ({ request }) => {
  const { token } = await (await request.get(control + '/v1/bootstrap')).json();
  await request.post(control + '/v1/runs/stop-all', { headers: { Authorization: `Bearer ${token}` } });
});

test('keeps navigation collapsed by default and expands a full sidebar overlay', async ({ page }) => {
  // Slim icon rail is the default on desktop and mobile; labeled workspace items live in the overlay.
  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible();
  await expect(page.getByRole('button', { name: /New agent/ })).toHaveCount(0);
  await expect(page.getByLabel('Search conversations')).toBeHidden();

  await openNavigation(page);
  await expect(page.getByRole('button', { name: /New agent/ })).toBeVisible();
  await expect(page.getByLabel('Search conversations')).toBeVisible();
  await expect(page.getByRole('button', { name: /Agents/ }).first()).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /New agent/ })).toHaveCount(0);
  await expect(page.getByLabel('Search conversations')).toBeHidden();
});

test('opens and closes workspace settings from the header', async ({ page }) => {
  const settings = page.locator('header').getByRole('button', { name: 'Settings' });
  await expect(settings).toBeVisible();
  await settings.click();

  const dialog = page.getByRole('dialog', { name: 'Workspace settings' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Provider')).toBeVisible();

  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(dialog).toHaveCount(0);
});

test('home stays quiet without credential selectors and Meet Atlas opens chat', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'What are we working on?' })).toBeVisible();
  await expect(page.getByText('A little direction.')).toHaveCount(0);
  await expect(page.getByText('YOUR PERSONAL AGENT WORKSPACE')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Credential for Atlas' })).toHaveCount(0);

  const atlas = page.locator('button.home-agent-start').filter({ has: page.getByRole('heading', { name: 'Atlas' }) });
  await expect(atlas).toHaveAttribute('aria-label', 'Meet Atlas');
  await page.getByRole('button', { name: 'Meet Atlas' }).click();

  await expect(page.getByLabel('Message Atlas')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Credential for Atlas' })).toHaveCount(0);
});

test('inspector starts closed and toggles open, including Escape dismiss', async ({ page }) => {
  await page.getByRole('button', { name: 'Meet Atlas' }).click();
  await expect(page.getByLabel('Message Atlas')).toBeVisible();

  await expect(page.getByRole('button', { name: 'Close workspace panel' })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Agent workspace' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Toggle workspace panel' }).click();
  await expect(page.getByRole('button', { name: 'Close workspace panel' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Agent workspace' })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Close workspace panel' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Toggle workspace panel' }).click();
  await expect(page.getByRole('button', { name: 'Close workspace panel' })).toBeVisible();
  await page.getByRole('button', { name: 'Close workspace panel' }).click();
  await expect(page.getByRole('button', { name: 'Close workspace panel' })).toHaveCount(0);
});

test('the workspace panel opens the skill editor and returns an invoked skill to the composer', async ({ page, isMobile }) => {
  await page.route('**/v1/agents/atlas/context', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), skills: ['weekly-digest'] } });
  });
  await page.reload();
  await page.getByRole('button', { name: 'Meet Atlas' }).click();
  await page.getByRole('button', { name: 'Toggle workspace panel' }).click();
  const workspace = page.getByRole('dialog', { name: 'Agent workspace' });
  await workspace.getByRole('button', { name: 'New skill' }).click();
  const editor = page.getByRole('dialog', { name: 'New skill' });
  await expect(editor.getByLabel('Skill name')).toBeFocused();
  await editor.getByLabel('Skill name').fill('draft-skill');
  if (isMobile) await page.goBack();
  else await editor.getByRole('button', { name: 'Cancel' }).click();
  await expect(editor).toBeHidden();
  await workspace.getByRole('button', { name: '/weekly-digest' }).click();
  const composer = page.getByLabel('Message Atlas');
  await expect(workspace).toHaveCount(0);
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue('/weekly-digest ');
});

test('navigation reaches Files and Routines from the expanded sidebar', async ({ page }) => {
  await openNavigation(page);
  await page.getByRole('button', { name: /Files/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Workspace files' })).toBeVisible();

  await openNavigation(page);
  await page.getByRole('button', { name: /Routines/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Routines', exact: true })).toBeVisible();
});

test('mobile viewport does not scroll horizontally', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'Overflow guard is for the mobile project');

  const noOverflow = async () => {
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
  };

  await noOverflow();

  await openNavigation(page);
  await noOverflow();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Meet Atlas' }).click();
  await expect(page.getByLabel('Message Atlas')).toBeVisible();
  await noOverflow();

  await page.getByRole('button', { name: 'Toggle workspace panel' }).click();
  await expect(page.getByRole('button', { name: 'Close workspace panel' })).toBeVisible();
  await noOverflow();
});
