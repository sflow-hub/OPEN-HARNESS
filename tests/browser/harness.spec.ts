import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { initialWorkspace } from '../../lib/types';
import { draftProfile } from '../../lib/agent-profile';
import type { HarnessInfo } from '../../lib/harness';
// The harness picker is built against the contract in COORDINATION.md before the coordinator
// implements it, so these routes stand in for GET /v1/harnesses and a profile store that keeps
// `harness`. The last test runs against the unmodified mock coordinator on purpose.
const control = `http://127.0.0.1:${process.env.OPEN_HARNESS_TEST_PORT || 4317}`;
async function seed(request: APIRequestContext) {
  const { token } = await (await request.get(control + '/v1/bootstrap')).json();
  const headers = { Authorization: `Bearer ${token}` };
  await request.post(control + '/v1/agents/sync', { headers, data: { agents: initialWorkspace.agents } });
  for (const agent of initialWorkspace.agents) {
    const { profile } = await (await request.get(control + `/v1/agents/${agent.id}/profile`, { headers })).json();
    await request.put(control + `/v1/agents/${agent.id}/profile`, { headers, data: { ...draftProfile(agent), revision: profile.revision } });
  }
}
const features = { memory: true, skills: true, sessionRecall: true, scheduling: true, desktop: true, mcp: true, approvals: true, steer: true, clarify: true };
function catalog(opencode: Partial<HarnessInfo> = {}): HarnessInfo[] {
  return [
    { kind: 'hermes', label: 'Hermes', version: 'v2026.9.11', license: 'MIT', description: 'Fixture Hermes runtime.', available: true, features, providers: [] },
    { kind: 'opencode', label: 'OpenCode', version: 'v1.0.0-fixture', license: 'MIT', description: 'Fixture OpenCode runtime.', available: true, features: { ...features, memory: false, skills: false, sessionRecall: false, desktop: false, steer: false, clarify: false }, providers: ['xai', 'openai', 'openrouter'], ...opencode },
  ];
}
// Keeps `harness` beside the real saved profile, the way the contract's coordinator will.
async function harnessStore(page: Page, harnesses: HarnessInfo[]) {
  let saved: unknown = undefined; const puts: Array<Record<string, unknown>> = [];
  await page.route('**/v1/harnesses', route => route.fulfill({ json: { harnesses } }));
  await page.route('**/v1/agents/atlas/profile', async route => {
    const method = route.request().method();
    if (method !== 'GET' && method !== 'PUT') return route.fallback();
    const body = method === 'PUT' ? route.request().postDataJSON() : null; if (body) puts.push(body);
    const response = await route.fetch(); const json = await response.json();
    if (body && response.ok()) saved = body.harness;
    return route.fulfill({ response, json: json.profile && saved ? { ...json, profile: { ...json.profile, harness: saved } } : json });
  });
  return puts;
}
async function openHarnessTab(page: Page) {
  await page.getByRole('button', { name: 'Edit Atlas profile' }).click();
  const panel = page.getByRole('dialog', { name: 'Agent settings' });
  await expect(panel.getByText('Loading saved profile…')).toBeHidden();
  await panel.getByRole('tab', { name: 'Harness', exact: true }).click();
  return panel;
}
test.beforeEach(async ({ request, page }) => { await seed(request); await page.addInitScript(() => { localStorage.setItem('open-harness.onboarding.v1', 'done'); localStorage.setItem('open-harness.advanced.v1', 'on'); }); });
const goto = (page: Page) => page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);

test('moves an agent to OpenCode after reviewing what changes, and keeps it on reload', async ({ page }) => {
  const puts = await harnessStore(page, catalog());
  await goto(page);
  const panel = await openHarnessTab(page);
  const options = panel.getByRole('radiogroup', { name: 'Agent harness' });
  await expect(options.getByRole('radio', { name: 'Hermes' })).toBeChecked();
  await expect(panel.getByText('Pinned v1.0.0-fixture')).toBeVisible();
  await expect(panel.getByRole('list', { name: 'OpenCode capabilities' }).getByText('Durable memory: not included')).toBeAttached();
  await options.getByText('OpenCode', { exact: true }).click();
  const review = panel.getByRole('region', { name: 'Review harness change' });
  await expect(review).toContainText('Before Atlas moves to OpenCode');
  await expect(review).toContainText('5 tools turn off because OpenCode doesn’t offer them: memory, session search, skills list, skill view, skill manage.');
  await expect(review).toContainText('Memories and skills this agent saved stay in its private storage');
  await expect(panel.getByText('Unsaved changes')).toHaveCount(0);
  await review.getByRole('button', { name: 'Switch to OpenCode' }).click();
  await expect(review).toBeHidden();
  await expect(options.getByRole('radio', { name: 'OpenCode' })).toBeChecked();
  await expect(panel.locator('.harness-badge')).toHaveText('OpenCode');
  await expect(panel.getByText('Unsaved changes')).toBeVisible();
  await panel.getByRole('tab', { name: 'Tools & connections' }).click();
  await expect(panel.getByRole('checkbox', { name: 'Enable Memory', exact: true })).toBeDisabled();
  await panel.getByText('Memory', { exact: true }).click();
  await expect(panel.getByText('OpenCode doesn’t offer these tools. Choose another harness to use them.').filter({ visible: true })).toHaveCount(1);
  await expect(panel.getByText('These switches control OpenCode tools.', { exact: false })).toBeVisible();
  await panel.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(panel.getByText('Saved. Ready for the next task.')).toBeVisible();
  const sent = puts.at(-1)!;
  expect(sent.harness).toEqual({ kind: 'opencode' });
  expect(sent.allowedTools).not.toContain('memory');
  expect(sent.allowedTools).not.toContain('terminal');
  await panel.getByRole('button', { name: 'Close agent settings' }).click();
  await page.reload();
  const reopened = await openHarnessTab(page);
  await expect(reopened.getByRole('radio', { name: 'OpenCode' })).toBeChecked();
  await expect(reopened.getByText('All changes saved', { exact: false })).toBeVisible();
});

test('keeps Hermes when the review is dismissed and flags a model the harness cannot use', async ({ page }) => {
  await harnessStore(page, catalog({ providers: ['openrouter'] }));
  await goto(page);
  const panel = await openHarnessTab(page);
  await panel.getByRole('radiogroup', { name: 'Agent harness' }).getByText('OpenCode', { exact: true }).click();
  const review = panel.getByRole('region', { name: 'Review harness change' });
  await expect(review).toContainText('OpenCode can’t use the xai model provider.');
  await review.getByRole('button', { name: 'Keep Hermes' }).click();
  await expect(review).toBeHidden();
  await expect(panel.getByRole('radio', { name: 'Hermes' })).toBeChecked();
  await expect(panel.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
  await panel.getByRole('radiogroup', { name: 'Agent harness' }).getByText('OpenCode', { exact: true }).click();
  await review.getByRole('button', { name: 'Switch to OpenCode' }).click();
  await panel.getByRole('button', { name: 'Choose another model' }).click();
  await expect(panel.getByRole('tab', { name: 'Model', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByText('OpenCode, this agent’s harness, can’t use the xai provider.')).toBeVisible();
  await panel.getByRole('switch', { name: 'Use workspace default' }).uncheck();
  await panel.getByLabel('Provider', { exact: true }).selectOption('openrouter');
  await expect(panel.getByText('can’t use the xai provider', { exact: false })).toHaveCount(0);
  // Back to Hermes needs no review: it offers everything OpenCode does.
  await panel.getByRole('tab', { name: 'Harness', exact: true }).click();
  await panel.getByRole('radiogroup', { name: 'Agent harness' }).getByText('Hermes', { exact: true }).click();
  await expect(panel.getByRole('region', { name: 'Review harness change' })).toHaveCount(0);
  await expect(panel.getByRole('radio', { name: 'Hermes' })).toBeChecked();
});

test('says plainly when the coordinator has not set up OpenCode or did not keep the choice', async ({ page }) => {
  await goto(page);
  const panel = await openHarnessTab(page);
  const options = panel.getByRole('radiogroup', { name: 'Agent harness' });
  await expect(options.locator('.harness-option', { hasText: 'OpenCode' }).getByText('Not set up')).toBeVisible();
  await options.getByText('OpenCode', { exact: true }).click();
  await panel.getByRole('region', { name: 'Review harness change' }).getByRole('button', { name: 'Switch to OpenCode' }).click();
  await expect(panel.getByRole('note').filter({ hasText: 'This coordinator does not offer OpenCode yet.' })).toBeVisible();
  await panel.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(panel.getByRole('alert')).toHaveText('Saved, but this coordinator kept Hermes. Update Open Harness to run agents on OpenCode.');
  await expect(options.getByRole('radio', { name: 'Hermes' })).toBeChecked();
});
