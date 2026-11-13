import { test, expect } from '@playwright/test';
import { initialWorkspace } from '../../lib/types';

// Run against a dashboard built with NEXT_PUBLIC_OPEN_HARNESS_CLOUD=1.
test('managed workspace switches hydrate only the selected workspace and preserve local-mode storage', async ({ page, isMobile }) => {
  test.skip(process.env.NEXT_PUBLIC_OPEN_HARNESS_CLOUD !== '1', 'Requires the managed dashboard build.');
  const cached = JSON.stringify({ ...initialWorkspace, conversations: [{ id: 'private-local', agentId: 'atlas', title: 'Private cached conversation', updatedAt: new Date().toISOString(), messages: [{ id: 'private-message', role: 'user', content: 'Other account content' }] }], files: [{ id: 'private-file', name: 'private-cached.txt', content: 'Other account file', agentId: 'atlas', updatedAt: new Date().toISOString() }] });
  await page.addInitScript(value => {
    localStorage.setItem('open-harness.workspace.v2', value);
    localStorage.setItem('open-harness.settings.v1', JSON.stringify({ provider: 'openai', model: 'private-cached-model' }));
    localStorage.setItem('open-harness.onboarding.v1', 'done');
  }, cached);
  await page.route('**/cloud/**', async route => {
    const url = new URL(route.request().url()), match = url.pathname.match(/^\/cloud\/v1\/workspaces\/([^/]+)\/(.*)$/), id = match?.[1] || 'first', path = match?.[2] || '';
    let body: unknown = {};
    if (url.pathname === '/cloud/v1/me') body = { accountId: 'current-account', workspaces: ['first', 'second'].map(id => ({ id, name: id, state: 'ready', role: 'viewer' })) };
    else if (path === 'usage') body = { wallet: { balance: '0', hard_limit: '0', reserved: '0' }, periods: [] };
    else if (path === 'models') body = { models: [] };
    else if (path === 'billing/products') body = { products: [] };
    else if (path === 'runtime/v1/client-status') body = { mode: 'live', token: '', runtime: { available: true, version: 'test', message: 'Ready' }, version: 'test', hermes: { release: 'test', commit: 'test' }, workspaceRole: 'viewer' };
    else if (path === 'runtime/v1/client-agents') body = { agents: initialWorkspace.agents };
    else if (path === 'runtime/v1/teams') body = { teams: [] };
    else if (path === 'runtime/v1/workspace/model') body = { revision: 1, model: { provider: 'openai', model: `${id}-model`, baseUrl: '', credentialRef: '' } };
    else if (path === 'runtime/v1/credentials') body = { credentials: [] };
    else if (path === 'runtime/v1/routines') body = { routines: [] };
    else if (path === 'runtime/v1/runs') body = { runs: [] };
    else if (path === 'runtime/v1/conversations') body = { conversations: [{ id: `${id}-conversation`, agentId: 'atlas', title: `${id} authorized conversation`, updatedAt: new Date().toISOString(), runs: [{ id: `${id}-run`, agent_id: 'atlas', conversation_id: `${id}-conversation`, prompt: `${id} authorized prompt`, state: 'completed', result: `${id} authorized result` }] }] };
    else if (path === 'runtime/v1/files') body = url.searchParams.has('name') ? { content: `${id} authorized file`, encoding: 'utf8', mimeType: 'text/plain' } : { files: [{ name: `${id}-authorized.txt`, size: 20, updatedAt: new Date().toISOString() }] };
    else if (path === 'runtime/v1/assistant') body = { profile: null, runs: [], responsibilities: [], pending: [], workspace: { id, name: id, actor: { id: 'current-account', role: 'viewer' } }, connections: [], catalog: [], actions: [], drafts: [] };
    else if (path.endsWith('/context')) body = { memory: '', user: '', skills: [], capabilities: {} };
    await route.fulfill({ json: body });
  });
  for (const id of ['first', 'second']) {
    await page.goto(`/?workspace=${id}`);
    await expect(page.getByRole('heading', { name: 'Meet your primary assistant' })).toBeVisible();
    if (isMobile) await page.getByRole('button', { name: 'Open navigation' }).click();
    await expect(page.getByRole('button', { name: `${id} authorized conversation`, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: `${id === 'first' ? 'second' : 'first'} authorized conversation`, exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Private cached conversation', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: /^Files\b/ }).click();
    await expect(page.getByRole('button', { name: `Download ${id}-authorized.txt` })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download private-cached.txt' })).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('open-harness.workspace.v2'))).toBe(cached);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('open-harness.settings.v1') || '{}').model)).toBe('private-cached-model');
  }
});
