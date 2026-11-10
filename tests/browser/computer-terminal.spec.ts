import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { initialWorkspace } from '../../lib/types';
import { draftProfile } from '../../lib/agent-profile';

const control = `http://127.0.0.1:${process.env.OPEN_HARNESS_TEST_PORT || 4317}`;
async function operator(request: APIRequestContext) { const { token } = await (await request.get(control + '/v1/bootstrap')).json(); return { Authorization: `Bearer ${token}` }; }
async function seed(request: APIRequestContext, tools?: string[]) {
  const headers = await operator(request);
  await request.post(control + '/v1/agents/sync', { headers, data: { agents: initialWorkspace.agents } });
  const { profile } = await (await request.get(control + '/v1/agents/atlas/profile', { headers })).json();
  const next = draftProfile(initialWorkspace.agents[0]); next.revision = profile.revision; next.computer.desktop = 'virtual';
  if (tools) next.allowedTools = tools;
  const saved = await request.put(control + '/v1/agents/atlas/profile', { headers, data: { ...next, ...(tools?.includes('terminal') ? { terminalConsent: true } : {}) } });
  expect(saved.ok(), await saved.text()).toBeTruthy();
}
async function openComputer(page: Page) {
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  await page.getByRole('button', { name: 'Meet Atlas' }).click();
  await page.getByRole('button', { name: 'Open agent computer' }).click();
  return page.getByRole('dialog', { name: 'Atlas’s computer' });
}
test.beforeEach(async ({ page }) => { await page.addInitScript(() => { localStorage.setItem('open-harness.onboarding.v1', 'done'); localStorage.setItem('open-harness.advanced.v1', 'on'); }); });
test.afterEach(async ({ request }) => {
  const headers = await operator(request), status = await (await request.get(control + '/v1/agents/atlas/desktop/status', { headers })).json();
  if (status.controlled) await request.post(control + '/v1/agents/atlas/desktop/release', { headers, data: { leaseId: status.leaseId } });
  await request.post(control + '/v1/runs/stop-all', { headers });
});

for (const human of [true, false]) test(`read-only computer viewers see ${human ? 'human ownership' : 'agent activity'} without opening private streams`, async ({page,request}) => {
  await seed(request); const privateRequests:string[]=[];
  page.on('request',value=>{if(/\/v1\/agents\/atlas\/(?:terminal|desktop\/(?:frame|stream|take-control|input|release))/.test(value.url()))privateRequests.push(value.url());});
  let reads=0;
  await page.route('**/v1/agents/atlas/desktop/status',async route=>{
    const response=await route.fetch(),value=await response.json();reads++;
    return route.fulfill({response,json:{...value,readOnly:true,agentActive:!human,controlled:human,ownershipState:human?'human':'agent',controllerName:human?'Dana':'',youControl:false,canRelease:false,ready:false,canContinue:false,leaseId:'',terminal:{available:false,ready:false}}});
  });
  const panel=await openComputer(page);
  await expect(panel.getByRole('status').filter({hasText:'Read-only access.'})).toBeVisible();
  await expect(panel.getByText(human?'Atlas has no active work.':'Atlas has active work.',{exact:true})).toBeVisible();
  await expect(panel.getByTestId('computer-controller')).toHaveText(`Control: ${human?'Dana':'Atlas'}`);
  for(const name of ['Take control','Watch desktop','Hand back and continue','Hand back, don’t continue','Save browser sharing'])await expect(panel.getByRole('button',{name,exact:true})).toHaveCount(0);
  await expect(panel.getByTestId('workspace-terminal-screen')).toHaveCount(0);
  await expect.poll(()=>reads).toBeGreaterThan(1);
  expect(privateRequests).toEqual([]);
});

test('the human terminal opens only for the controller and streams through the leased ticket', async ({ page, request }) => {
  await seed(request);
  const tickets: Array<Record<string, unknown>> = [], received: string[] = [];
  await page.route('**/v1/agents/atlas/terminal', route => { tickets.push(route.request().postDataJSON()); return route.fulfill({ status: 201, json: { path: '/v1/terminal-stream?ticket=fixture', url: '/v1/terminal-stream?ticket=fixture', expiresIn: 30 } }); });
  await page.routeWebSocket(/\/v1\/terminal-stream/, ws => {
    ws.onMessage(message => {
      const value = JSON.parse(String(message));
      if (value.type === 'input') { received.push(value.data); if (value.data.includes('whoami')) ws.send(JSON.stringify({ type: 'output', data: 'agent-workspace-user\r\n$ ' })); }
    });
    ws.send(JSON.stringify({ type: 'output', data: 'fixture shell ready\r\n$ ' }));
  });
  const panel = await openComputer(page);
  await panel.getByRole('tab', { name: 'Terminal' }).click();
  await expect(panel.getByText(/Take control to open your own terminal in Atlas’s private workspace/)).toBeVisible();
  expect(tickets).toHaveLength(0);
  await panel.getByRole('button', { name: 'Take control', exact: true }).click();
  await panel.getByRole('button', { name: 'Stop agent work and take control' }).click();
  await expect(panel.getByText(/It is for you only and does not give Atlas terminal access\. Harness does not record/)).toBeVisible();
  await expect(panel.getByRole('status').filter({ hasText: 'Connected to this agent’s workspace' })).toBeVisible();
  const status = await (await request.get(control + '/v1/agents/atlas/desktop/status', { headers: await operator(request) })).json();
  expect(tickets).toEqual([{ leaseId: status.leaseId }]);
  await expect(panel.getByTestId('workspace-terminal-screen')).toContainText('fixture shell ready');
  await panel.getByLabel('Terminal command').fill('whoami');
  await panel.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(panel.getByTestId('workspace-terminal-screen')).toContainText('agent-workspace-user');
  expect(received).toContain('whoami\r');
  await panel.getByRole('tab',{name:'Desktop',exact:true}).click();
  await panel.getByRole('tab',{name:'Terminal',exact:true}).click();
  await expect(panel.getByTestId('workspace-terminal-screen')).toContainText('agent-workspace-user');expect(tickets).toHaveLength(1);
  await panel.getByRole('button', { name: 'Ctrl+C' }).click();
  await expect.poll(() => received).toContain('\u0003');
  // The agent's own tools are untouched by the human terminal.
  const { profile } = await (await request.get(control + '/v1/agents/atlas/profile', { headers: await operator(request) })).json();
  expect(profile.allowedTools).not.toContain('terminal');
  await panel.getByRole('button', { name: 'Hand back, don’t continue' }).click();
  await expect(panel.getByText(/Commands you left running were stopped/)).toBeVisible();
  await expect(panel.getByTestId('workspace-terminal-screen')).toHaveCount(0);
});

test('turning on Terminal needs persistent owner consent, and revoking shows pending cleanup', async ({ page, request }) => {
  await seed(request);
  const puts: Array<Record<string, unknown>> = [];
  await page.route('**/v1/agents/atlas/profile', async route => {
    if (route.request().method() !== 'PUT') return route.fallback();
    const body = route.request().postDataJSON(); puts.push(body);
    const response = await route.fetch(), value = await response.json();
    // A revoke is final only once the computer confirms; the fixture holds it pending.
    const revoked = response.ok() && !body.allowedTools.includes('terminal') && puts.length > 1;
    return route.fulfill({ response, json: revoked ? { ...value, terminalRevocation: { state: 'pending', requestedAt: new Date().toISOString(), confirmedAt: null, reason: 'Waiting' } } : value });
  });
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  await page.getByRole('button', { name: 'Edit Atlas profile' }).click();
  const panel = page.getByRole('dialog', { name: 'Agent settings' });
  await expect(panel.getByText('Loading saved profile…')).toBeHidden();
  await panel.getByRole('tab', { name: 'Computer', exact: true }).click();
  const access = panel.getByLabel('Terminal access', { exact: true });
  await expect(access).toContainText('Atlas does not have terminal or process tools.');
  await access.getByRole('button', { name: 'Allow terminal access…' }).click();
  await expect(access.getByRole('group',{name:'Terminal access consent'})).toContainText('Shared folders: none.');
  await expect(access).toContainText('make network requests');
  await expect(access).toContainText('Code execution and MCP permissions are controlled separately.');
  await expect(access).toContainText('Commands never run on your computer’s own shell.');
  await panel.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('Confirm terminal access for Atlas before saving');
  expect(puts).toHaveLength(0);
  await access.getByRole('checkbox', { name: /I allow Atlas to run commands and manage processes inside its private workspace/ }).check();
  await panel.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(panel.getByText(/^Saved/)).toBeVisible();
  expect(puts[0]).toMatchObject({ terminalConsent: true });
  expect(puts[0].allowedTools).toEqual(expect.arrayContaining(['terminal', 'process_manage']));
  await expect(access).toContainText('This permission stays on until you revoke it.');
  await expect(access.getByRole('checkbox')).toHaveCount(0);
  await access.getByRole('button', { name: 'Revoke terminal access' }).click();
  await expect(access).toContainText('Save to revoke.');
  await panel.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(access.getByRole('status').filter({ hasText: 'Revocation pending. Waiting for' })).toBeVisible();
  expect(puts[1].terminalConsent).toBeUndefined();
  expect(puts[1].allowedTools).not.toContain('terminal');
  await expect(access.getByRole('button', { name: 'Allow terminal access…' })).toBeDisabled();
});

test('a saved terminal grant is kept without asking again', async ({ page, request }) => {
  await seed(request, [...draftProfile(initialWorkspace.agents[0]).allowedTools, 'terminal', 'process_manage']);
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  await page.getByRole('button', { name: 'Edit Atlas profile' }).click();
  const panel = page.getByRole('dialog', { name: 'Agent settings' });
  await expect(panel.getByText('Loading saved profile…')).toBeHidden();
  await panel.getByRole('tab', { name: 'Computer', exact: true }).click();
  const access = panel.getByLabel('Terminal access', { exact: true });
  await expect(access).toContainText('This permission stays on until you revoke it.');
  await expect(access.getByRole('checkbox')).toHaveCount(0);
});

for (const failure of ['error','timeout'] as const) test(`terminal socket ${failure} offers reconnect instead of staying on Opening`, async ({ page, request }) => {
  await seed(request);
  if (failure === 'timeout') await page.clock.install();
  await page.route('**/v1/agents/atlas/terminal', route => route.fulfill({status:201,json:{path:'/v1/terminal-stream?ticket=fixture',expiresIn:30}}));
  await page.addInitScript(mode => {
    class FailedSocket extends EventTarget {
      static OPEN = 1; readyState = 0;
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor() { super(); if (mode === 'error') queueMicrotask(() => this.onerror?.(new Event('error'))); }
      send() {}
      close() { this.readyState = 3; this.onclose?.(new Event('close')); }
    }
    window.WebSocket = FailedSocket as unknown as typeof WebSocket;
  }, failure);
  const panel = await openComputer(page);
  await panel.getByRole('tab',{name:'Terminal',exact:true}).click();
  await panel.getByRole('button',{name:'Take control',exact:true}).click(); await panel.getByRole('button',{name:'Stop agent work and take control'}).click();
  await expect(panel.getByTestId('workspace-terminal-screen').locator('.xterm')).toBeVisible();
  if (failure === 'timeout') await page.clock.fastForward(16000);
  await expect(panel.getByRole('status').filter({hasText:failure === 'error' ? 'The terminal connection failed.' : 'The terminal did not connect.'})).toBeVisible();
  await expect(panel.getByRole('button',{name:'Reconnect terminal'})).toBeEnabled();
  await expect(panel.getByRole('button',{name:'Run',exact:true})).toBeDisabled();
});
