import { test, expect, type APIRequestContext } from '@playwright/test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialWorkspace } from '../../lib/types';
import { draftProfile } from '../../lib/agent-profile';
const control = `http://127.0.0.1:${process.env.OPEN_HARNESS_TEST_PORT || 4317}`;
async function operator(request: APIRequestContext) { const { token } = await (await request.get(control + '/v1/bootstrap')).json(); return { Authorization: `Bearer ${token}` }; }
async function seed(request: APIRequestContext) {
  const headers = await operator(request);
  await request.post(control + '/v1/agents/sync', { headers, data: { agents: initialWorkspace.agents } });
  for (const agent of initialWorkspace.agents) {
    const { profile } = await (await request.get(control + `/v1/agents/${agent.id}/profile`, { headers })).json();
    await request.put(control + `/v1/agents/${agent.id}/profile`, { headers, data: { ...draftProfile(agent), revision: profile.revision } });
  }
}
test.beforeEach(async ({ request, page }) => { await seed(request); await page.addInitScript(() => { localStorage.setItem('open-harness.onboarding.v1', 'done'); localStorage.setItem('open-harness.advanced.v1', 'on'); }); await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`); await expect(page.getByRole('button', { name: 'Edit Atlas profile' })).toBeVisible(); });

test('a project shares a folder and gives each agent its own access, capped by the folder', async ({ page, request }, testInfo) => {
  const name = `Folders ${testInfo.project.name}`, folder = join(mkdtempSync(join(tmpdir(), 'harness-project-site-')), 'site');
  mkdirSync(folder);
  const headers = await operator(request);
  await request.post(control + '/v1/boards', { headers, data: { name } });
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'Projects', exact: true }).click();
  await page.getByRole('button', { name: `Settings for ${name}` }).click();
  const dialog = page.getByRole('dialog', { name: 'Project settings' });
  await dialog.getByRole('button', { name: 'Add folder' }).click();

  // A grant of the whole disk is refused, and the reason is shown in the dialog itself.
  const path = dialog.getByLabel('Project folder 1 path');
  await path.fill('/');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('never shares / with agents');

  await path.fill(folder);
  await expect(dialog.getByLabel('Project folder 1 name')).toHaveValue('site');
  await expect(dialog.getByText('/workspace/project/site', { exact: true })).toBeVisible();
  const atlas = dialog.getByLabel('Atlas access to site');
  await expect(atlas).toHaveValue('');
  await expect(atlas.getByRole('option')).toHaveText(['No access', 'Read only']);
  await dialog.getByLabel('Project folder 1 access').selectOption('write');
  await atlas.selectOption('write');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();

  const boards = (await (await request.get(control + '/v1/boards', { headers })).json()).boards as Array<{ name: string; folders: Array<{ name: string; path: string; mode: string; agents: Record<string, string> }> }>;
  expect(boards.find(board => board.name === name)!.folders.map(({ name, path, mode, agents }) => ({ name, path, mode, agents }))).toEqual([{ name: 'site', path: folder, mode: 'write', agents: { atlas: 'write' } }]);

  // Lowering the folder to read-only lowers Atlas with it before anything is saved.
  await page.getByRole('button', { name: `Settings for ${name}` }).click();
  await dialog.getByLabel('Project folder 1 access').selectOption('read');
  await expect(dialog.getByLabel('Atlas access to site')).toHaveValue('read');
});

test('a chat uses the agent’s own folders unless a project with folders is chosen', async ({ page, request }, testInfo) => {
  const name = `Chat folders ${testInfo.project.name}`, folder = mkdtempSync(join(tmpdir(), 'harness-chat-folder-'));
  const headers = await operator(request);
  await request.post(control + '/v1/boards', { headers, data: { name, folders: [{ name: 'shared', path: folder, mode: 'read', agents: { scout: 'read' } }] } });
  await page.reload();
  await page.getByRole('button', { name: 'Meet Atlas' }).click();
  await page.getByRole('button', { name: 'New conversation' }).click();
  const picker = page.getByLabel('Project folders');
  await expect(picker).toHaveValue('');
  await expect(picker.getByRole('option', { name })).toHaveCount(1);
  await picker.selectOption({ label: name });
  // Atlas was given nothing in this project, so picking it changes nothing, and the composer says so.
  await expect(page.locator('.chat-project')).toContainText('No access');
});

test('the Folders screen chooses which folders each agent keeps, and the agent’s settings show them', async ({ page, request }, testInfo) => {
  const folder = mkdtempSync(join(tmpdir(), 'harness-kept-folder-')), name = `kept-${testInfo.project.name}`;
  const headers = await operator(request);
  await page.getByRole('button', { name: 'Edit Atlas profile' }).click();
  const panel = page.getByRole('dialog', { name: 'Agent settings' });
  await panel.getByRole('tab', { name: 'Computer', exact: true }).click();
  await panel.getByRole('button', { name: 'Manage folders' }).click();
  await expect(panel).toBeHidden();
  const screen = page.locator('.folders-content');
  await screen.getByRole('button', { name: 'Add folder' }).click();
  const index = await screen.locator('.computer-folder').count();
  await screen.getByLabel(`Folder ${index} path`).fill(folder);
  await screen.getByLabel(`Folder ${index} name`).fill(name);
  await screen.getByLabel(`Atlas access to ${name}`).selectOption('read');
  await screen.getByRole('button', { name: 'Save folders' }).click();
  await expect(screen.getByText('Saved. Agents use these folders from their next task.')).toBeVisible();
  const { folders } = await (await request.get(control + '/v1/folders', { headers })).json();
  expect(folders.find((item: { name: string }) => item.name === name)).toMatchObject({ path: folder, mode: 'read', agents: { atlas: 'read' } });

  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  await page.getByRole('button', { name: 'Edit Atlas profile' }).click();
  await panel.getByRole('tab', { name: 'Computer', exact: true }).click();
  await expect(panel.getByRole('list', { name: 'Folders this agent can always use' })).toContainText(`/workspace/folders/${name}`);
});
