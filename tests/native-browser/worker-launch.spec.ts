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
  root = await mkdtemp(join(tmpdir(), 'open-harness-worker-launch-'));
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

test('Codex profile exposes ChatGPT plan billing, worker launch, and commands', async ({ page }) => {
  await page.goto(base);
  const create = page.locator('form[action="/ui/agents/create"]');
  await create.getByLabel('Name', { exact: true }).fill('Planner');
  await create.getByLabel('ID', { exact: true }).fill('planner');
  await create.getByLabel('Harness').selectOption('codex');
  await create.getByRole('button', { name: 'Create agent' }).click();
  await expect(page.getByText('Planner', { exact: true }).first()).toBeVisible();

  await page.goto(base + '/ui/profile?agent=planner');
  const form = page.locator('form[action="/ui/profile/agent"]');
  await expect(form.getByLabel('Billing')).toBeVisible();
  await form.getByLabel('Billing').selectOption('chatgpt-plan');
  await form.getByLabel(/Allow launches from the assigned worker/).check();
  await form.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByText('Profile saved.', { exact: true })).toBeVisible();

  await expect(form.getByLabel('Billing')).toHaveValue('chatgpt-plan');
  await expect(form.getByLabel('Provider')).toHaveValue('openai');
  await expect(form.getByLabel('Credential ref')).toHaveValue('');
  await expect(form.getByLabel('Base URL')).toHaveValue('');
  await expect(form.getByLabel('Inherit workspace model')).not.toBeChecked();
  await expect(page.getByText(/ChatGPT plan usage applies to this agent's manual runs, schedules, and handoffs/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Manage ChatGPT usage' })).toHaveAttribute(
    'href',
    'https://chatgpt.com/settings/usage',
  );
  await expect(page.getByText(/Assigned worker/)).toBeVisible();
  const commands = page.locator('pre.log');
  await expect(commands).toContainText('open-harness worker login --agent planner');
  await expect(commands).toContainText('open-harness worker status --agent planner');
  await expect(commands).toContainText('open-harness worker logout --agent planner');
  await expect(commands).toContainText('open-harness worker run --agent planner');
});

test('non-Codex profiles keep configured billing without a plan select', async ({ page }) => {
  await page.goto(base);
  const create = page.locator('form[action="/ui/agents/create"]');
  await create.getByLabel('Name', { exact: true }).fill('Researcher');
  await create.getByLabel('ID', { exact: true }).fill('researcher');
  await create.getByLabel('Harness').selectOption('hermes');
  await create.getByRole('button', { name: 'Create agent' }).click();
  await expect(page.getByText('Researcher', { exact: true }).first()).toBeVisible();

  await page.goto(base + '/ui/profile?agent=researcher');
  const form = page.locator('form[action="/ui/profile/agent"]');
  await expect(form.locator('select[name="modelAuth"]')).toHaveCount(0);
  await expect(form.locator('input[name="modelAuth"][type="hidden"]')).toHaveAttribute(
    'value',
    'configured',
  );
  await expect(form.getByLabel(/Allow launches from the assigned worker/)).toHaveCount(0);
  await expect(page.getByText(/ChatGPT plan usage applies/)).toHaveCount(0);
});

test('Claude Code worker launch surfaces the terminal command', async ({ page }) => {
  await page.goto(base);
  const create = page.locator('form[action="/ui/agents/create"]');
  await create.getByLabel('Name', { exact: true }).fill('Reviewer');
  await create.getByLabel('ID', { exact: true }).fill('reviewer');
  await create.getByLabel('Harness').selectOption('claude-code');
  await create.getByRole('button', { name: 'Create agent' }).click();
  await expect(page.getByText('Reviewer', { exact: true }).first()).toBeVisible();

  await page.goto(base + '/ui/profile?agent=reviewer');
  const form = page.locator('form[action="/ui/profile/agent"]');
  await expect(form.locator('select[name="modelAuth"]')).toHaveCount(0);
  await form.getByLabel(/Allow launches from the assigned worker/).check();
  await form.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByText('Profile saved.', { exact: true })).toBeVisible();
  const commands = page.locator('pre.log');
  await expect(commands).not.toContainText('open-harness worker login --agent reviewer');
  await expect(commands).toContainText('open-harness worker terminal --agent reviewer');
  await expect(commands).not.toContainText('open-harness worker run --agent reviewer');
});
