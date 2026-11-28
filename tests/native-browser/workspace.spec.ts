import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

let coordinator: ChildProcess;
let root: string;
let base: string;

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'open-harness-native-browser-'));
  const binary = process.env.OPEN_HARNESS_TEST_NATIVE_BINARY || resolve('target/debug/open-harness');
  coordinator = spawn(binary, ['serve', '--port', '0', '--bind', '127.0.0.1', '--state-dir', root], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, OPEN_HARNESS_MOCK: '1', OPEN_HARNESS_DISABLE_OS_VAULT: '1' },
  });
  base = await new Promise<string>((ok, fail) => {
    let output = '';
    coordinator.once('error', fail);
    coordinator.once('exit', code => fail(new Error('Coordinator exited with ' + code + '\n' + output)));
    coordinator.stderr!.on('data', chunk => { output += chunk; });
    coordinator.stdout!.on('data', chunk => {
      output += chunk;
      const match = output.match(/serving (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) ok(match[1]);
    });
  });
});

test.afterAll(async () => {
  if (coordinator?.pid && coordinator.exitCode === null && !coordinator.signalCode) {
    const closed = once(coordinator, 'exit');
    coordinator.kill('SIGTERM');
    await closed;
  }
  if (root) await rm(root, { recursive: true, force: true });
});

test('submit jobs and reopen results with JavaScript disabled', async ({ page, context }) => {
  await page.goto(base);
  await expect(page.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible();
  const agents = [
    ['Researcher', 'researcher', 'hermes', 'Hermes'],
    ['Reviewer', 'reviewer', 'claude-code', 'Claude Code'],
    ['Navigator', 'navigator', 'opencode', 'OpenCode'],
    ['Pilot', 'pilot', 'pi', 'Pi'],
    ['Caretaker', 'caretaker', 'openhands', 'OpenHands'],
    ['Builder', 'builder', 'codex', 'Codex'],
  ] as const;
  for (const [agent, id, harness] of agents) {
    const form = page.locator('form[action="/ui/agents/create"]');
    await form.getByLabel('Name', { exact: true }).fill(agent);
    await form.getByLabel('ID', { exact: true }).fill(id);
    await form.getByLabel('Harness').selectOption(harness);
    await form.getByRole('button', { name: 'Create agent' }).click();
    await expect(page.getByText(agent, { exact: true }).first()).toBeVisible();
  }
  async function submit(id: string, prompt: string) {
    await page.goto(base + '/ui/jobs');
    const form = page.locator('form[action="/ui/jobs/submit"]');
    await form.getByLabel('Agent').selectOption(id);
    await form.getByLabel('Prompt').fill(prompt);
    await form.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page).toHaveURL(/\/ui\/jobs\/[\da-f-]+/);
    return page.url();
  }
  for (const [, id, , name] of agents.filter(([, , harness]) => harness !== 'codex')) {
    await submit(id, 'Verify the headless workspace.');
    await expect(page.locator('pre').first()).toContainText(`${name} mock completed the task.`, { timeout: 20_000 });
  }
  const runUrl = await submit('builder', 'MOCK_SLOW verify the headless workspace.');
  await page.close();
  const { token } = await (await context.request.get(base + '/v1/bootstrap')).json();
  const runId = new URL(runUrl).pathname.split('/').pop();
  await expect.poll(async () => {
    const response = await context.request.get(base + '/v1/runs/' + runId, { headers: { Authorization: 'Bearer ' + token } });
    return (await response.json()).state;
  }, { timeout: 20_000 }).toBe('completed');
  const reopened = await context.newPage();
  await reopened.goto(runUrl);
  await expect(reopened.locator('pre').first()).toContainText('Codex mock completed the task.', { timeout: 20_000 });
  for (const section of ['profile', 'credentials', 'teams', 'boards', 'routines', 'memory', 'skills', 'files', 'machines']) {
    const response = await reopened.goto(base + '/ui/' + section);
    expect(response?.status()).toBe(200);
    await expect(reopened.locator('h1')).toBeVisible();
  }
});

test('configure new headless harnesses and model connections with JavaScript disabled', async ({ page }) => {
  await page.goto(base);
  const form = page.locator('form[action="/ui/agents/create"]');
  const harnesses = [
    ['OpenCode', 'opencode', 'openai'],
    ['Pi', 'pi', 'local'],
    ['OpenHands', 'openhands', 'openrouter'],
  ];
  for (const [name, harness, provider] of harnesses) {
    await form.getByLabel('Name', { exact: true }).fill(name + ' Agent');
    await form.getByLabel('ID', { exact: true }).fill(harness + '-agent');
    await form.getByLabel('Harness').selectOption(harness);
    await form.getByText('Model connection', { exact: true }).click();
    await expect(page.locator('#model-providers option')).toHaveCount(6);
    await form.getByLabel('Provider', { exact: true }).fill(provider);
    await form.getByLabel('Model ID', { exact: true }).fill('fixture-model');
    if (provider === 'local') {
      await form.getByLabel('Base URL', { exact: true }).fill('http://model.invalid/v1');
    }
    await form.getByRole('button', { name: 'Create agent' }).click();
    await expect(page.getByText('Agent created.', { exact: true })).toBeVisible();
    await expect(page.getByText(harness + '-agent · ' + name, { exact: true })).toBeVisible();
  }

  await page.goto(base + '/ui/profile?agent=openhands-agent');
  const profile = page.locator('form[action="/ui/profile/agent"]');
  await expect(profile.getByLabel('Harness')).toHaveValue('openhands');
  await expect(profile.getByLabel('Provider', { exact: true })).toHaveValue('openrouter');
  await expect(profile.getByLabel('Credential ref', { exact: true })).toHaveValue('OPENROUTER_API_KEY');
  await expect(profile.getByLabel('Read, write and edit files', { exact: true })).toBeChecked();
  await expect(profile.getByLabel('Search files', { exact: true })).toHaveCount(0);
  await profile.getByLabel('Read, write and edit files', { exact: true }).uncheck();
  await profile.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByText('Profile saved.', { exact: true })).toBeVisible();
  await expect(profile.getByLabel('Read, write and edit files', { exact: true })).not.toBeChecked();
  await page.getByRole('button', { name: 'Install / retry harness' }).click();
  await expect(page.getByText('Harness install requested.', { exact: true })).toBeVisible();
  await expect.poll(async () => {
    await page.reload();
    return page.getByText('Harness installation ready.', { exact: false }).count();
  }).toBe(1);
});

test('persist memory, skills and private files for the selected agent', async ({ page }) => {
  await page.goto(base);
  const create = page.locator('form[action="/ui/agents/create"]');
  await create.getByLabel('Name', { exact: true }).fill('Writer');
  await create.getByLabel('ID', { exact: true }).fill('writer');
  await create.getByRole('button', { name: 'Create agent' }).click();
  await expect(page.getByText('Writer', { exact: true }).first()).toBeVisible();

  await page.goto(base + '/ui/memory?agent=writer');
  await page.getByRole('textbox', { name: 'Memory', exact: true }).fill('Use A+B for the totals.');
  await page.getByRole('button', { name: 'Save memory' }).click();
  await expect(page.getByText('Memory saved.', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Memory', exact: true })).toHaveValue('Use A+B for the totals.');

  await page.goto(base + '/ui/skills?agent=writer');
  await page.getByLabel('Name', { exact: true }).fill('summarize');
  await page.getByLabel('Content').fill('Write a short summary.');
  await page.getByRole('button', { name: 'Save skill' }).click();
  await expect(page.getByText('Skill saved.', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Open', exact: true }).click();
  await expect(page.getByLabel('Content')).toHaveValue('Write a short summary.');

  await page.goto(base + '/ui/files?scope=private&agent=writer');
  await page.getByLabel('Name', { exact: true }).fill('notes.txt');
  await page.getByLabel('Content').fill('Keep with Writer.');
  await page.getByRole('button', { name: 'Save file' }).click();
  await expect(page.getByText('File saved.', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Open', exact: true }).click();
  await expect(page.getByLabel('Content')).toHaveValue('Keep with Writer.');
  await page.goto(base + '/ui/files?scope=shared');
  await expect(page.getByText('notes.txt', { exact: true })).toHaveCount(0);
});

test('upload and download the original bytes from the jobs workspace', async ({ page, context }) => {
  await page.goto(base);
  await page.goto(base + '/ui/jobs');
  const tab = context.waitForEvent('page');
  await page.getByRole('link', { name: 'Upload shared files' }).click();
  const files = await tab;
  const upload = files.locator('form#upload');
  const name = 'measurements.txt';
  const original = Buffer.from([0x00, 0xc3, 0x28, 0xfe, 0x0a]);
  const file = { name, mimeType: 'application/octet-stream', buffer: original };
  await upload.locator('input[type=file]').setInputFiles(file);
  await upload.getByRole('button', { name: 'Upload files' }).click();
  const entry = files.getByRole('listitem').filter({ hasText: name });
  await expect(entry).toBeVisible();
  await upload.locator('input[type=file]').setInputFiles({ ...file, buffer: Buffer.from('replacement') });
  await upload.getByRole('button', { name: 'Upload files' }).click();
  await expect(files.getByText(/already exists/).first()).toBeVisible();
  const ready = files.waitForEvent('download');
  await entry.getByRole('link', { name: 'Download' }).click();
  const download = await ready;
  expect(download.suggestedFilename()).toBe(name);
  const chunks = [];
  for await (const bytes of await download.createReadStream()) chunks.push(bytes);
  expect(Buffer.concat(chunks)).toEqual(original);
});
