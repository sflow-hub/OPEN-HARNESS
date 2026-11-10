import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { initialWorkspace } from '../../lib/types';
import { draftProfile } from '../../lib/agent-profile';

const control = `http://127.0.0.1:${process.env.OPEN_HARNESS_TEST_PORT || 4317}`;
async function operator(request: APIRequestContext) { const { token } = await (await request.get(control + '/v1/bootstrap')).json(); return { Authorization: `Bearer ${token}` }; }
async function takeControl(panel: ReturnType<Page['getByRole']>) {
  await panel.getByRole('button', { name: 'Take control', exact: true }).click();
  await expect(panel.getByRole('group', { name: 'Confirm taking control' })).toContainText('The browser and its open pages stay as they are.');
  await panel.getByRole('button', { name: 'Stop agent work and take control' }).click();
}
async function openDesktop(page: Page) {
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  await page.getByRole('button', { name: 'Meet Atlas' }).click();
  // Mobile layout can enlarge innerWidth to fit an overflowing toolbar, so compare with
  // the actual viewport before a modal obscures the chat and its desktop action buttons.
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  await page.getByRole('button', { name: 'Open agent computer' }).click();
  return page.getByRole('dialog', { name: 'Atlas’s computer' });
}
test.beforeEach(async ({ request, page }) => {
  const headers = await operator(request);
  await request.post(control + '/v1/agents/sync', { headers, data: { agents: initialWorkspace.agents } });
  const { profile } = await (await request.get(control + '/v1/agents/atlas/profile', { headers })).json();
  const next = draftProfile(initialWorkspace.agents[0]); next.revision = profile.revision; next.computer.desktop = 'virtual';
  const saved = await request.put(control + '/v1/agents/atlas/profile', { headers, data: next }); expect(saved.ok()).toBeTruthy();
  await page.addInitScript(() => { localStorage.setItem('open-harness.onboarding.v1', 'done'); localStorage.setItem('open-harness.advanced.v1', 'on'); });
});
test.afterEach(async ({ request }) => {
  const headers = await operator(request), status = await (await request.get(control + '/v1/agents/atlas/desktop/status', { headers })).json();
  if (status.recording) await request.post(control + '/v1/agents/atlas/desktop/record-stop', { headers, data: { leaseId: status.leaseId } });
  if (status.controlled) await request.post(control + '/v1/agents/atlas/desktop/release', { headers, data: { leaseId: status.leaseId } });
  await request.post(control + '/v1/runs/stop-all', { headers });
});

test('phone and desktop takeover record a redacted draft for workflow review', async ({ page, request }, testInfo) => {
  const panel = await openDesktop(page);
  await takeControl(panel);
  await expect(panel.getByRole('img', { name: 'Current private agent desktop' })).toBeVisible();
  await panel.getByRole('button', { name: 'Record demonstration', exact: true }).click();
  const secret = `private-password-${testInfo.project.name}`;
  await panel.getByLabel('Text for desktop').fill(secret);
  await panel.getByRole('button', { name: 'Type into desktop' }).click();
  await expect(panel.getByLabel('Text for desktop')).toHaveValue('');
  await panel.getByRole('button', { name: 'Tab', exact: true }).click();
  await panel.getByRole('button', { name: /Finish demonstration/ }).click();
  const draft = panel.getByLabel('Demonstration draft');
  await expect(draft).toContainText('Typed text was omitted');
  expect(await draft.inputValue()).not.toContain(secret);
  await expect(panel.getByRole('button', { name: 'Save draft for review and testing' })).toBeDisabled();
  await panel.getByRole('button', { name: 'Hand back, don’t continue' }).click();
  const workflowName = `Desktop demonstration ${testInfo.project.name} ${Date.now()}`;
  await panel.getByLabel('Demonstration workflow name').fill(workflowName);
  await panel.getByRole('button', { name: 'Save draft for review and testing' }).click();
  await expect(panel).toBeHidden();
  const workflow = page.getByRole('region', { name: 'Reusable workflows' });
  await expect(workflow.getByLabel('Workflow instructions')).toContainText('Typed text was omitted');
  await expect(workflow.getByRole('button', { name: 'Run workflow test' })).toBeDisabled();
  const saved = await (await request.get(control + '/v1/workflows', { headers: await operator(request) })).json();
  const recorded = saved.workflows.find((item: { name: string }) => item.name === workflowName);
  expect(recorded.reviewedRevision).toBeNull(); expect(recorded.publishedRevision).toBeNull(); expect(recorded.tests).toHaveLength(0);
  expect(JSON.stringify(recorded)).not.toContain(secret);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test('sharing browser accounts requires an explicit team consent', async ({ page, request }, testInfo) => {
  const headers = await operator(request), team = await (await request.post(control + '/v1/teams', { headers, data: { name: `Desktop team ${testInfo.project.name} ${Date.now()}`, description: '', color: 'sage', icon: 'people', memberAgentIds: ['atlas', 'scout'] } })).json();
  const panel = await openDesktop(page);
  await panel.getByText('Share browser logins with teammates', { exact: true }).click();
  await panel.getByLabel('Browser sharing team').selectOption(team.id);
  await expect(panel.getByRole('button', { name: 'Save browser sharing' })).toBeDisabled();
  await panel.getByRole('checkbox', { name: 'I allow opted-in members of this team to use the same browser logins.' }).check();
  await panel.getByRole('button', { name: 'Save browser sharing' }).click();
  await expect(panel.getByRole('button', { name: 'Save browser sharing' })).toBeDisabled();
  const saved = await (await request.get(control + '/v1/agents/atlas/profile', { headers })).json();
  expect(saved.profile.computer.browserSessionTeamId).toBe(team.id);
  await panel.getByLabel('Browser sharing team').selectOption('');
  await panel.getByRole('button', { name: 'Save browser sharing' }).click();
  await expect(panel.getByRole('button', { name: 'Save browser sharing' })).toBeDisabled();
});

test('human control prevents profile changes and task admission until release', async ({ page, request }) => {
  const panel = await openDesktop(page), headers = await operator(request);
  await takeControl(panel);
  await expect(panel.getByRole('button', { name: 'Hand back, don’t continue' })).toBeVisible();
  const { profile } = await (await request.get(control + '/v1/agents/atlas/profile', { headers })).json();
  const save = await request.put(control + '/v1/agents/atlas/profile', { headers, data: { ...profile, description: 'Should stay a draft.' } });
  expect(save.status()).toBe(409);
  const moving = await request.post(control + '/v1/agents/atlas/transfer', { headers, data: { destinationMachineId: 'local' } }); expect(moving.status()).toBe(409);
  const response = await request.post(control + '/v1/runs', { headers, data: { agentId: 'atlas', prompt: 'Wait for the operator to release this desktop.' } });
  expect(response.ok()).toBeTruthy(); const run = await response.json();
  expect(run.state).toBe('queued');
  await panel.getByRole('button', { name: 'Hand back, don’t continue' }).click();
  await expect.poll(async () => (await (await request.get(control + `/v1/runs/${run.id}`, { headers })).json()).state).toBe('completed');
});

test('the computer header names the machine and controller, and pointer input uses the lease', async ({ page, isMobile }) => {
  const panel = await openDesktop(page), sent: Array<Record<string, unknown>> = [];
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/v1/agents/atlas/desktop/input')) sent.push(request.postDataJSON()); });
  const header = panel.getByLabel('Computer status');
  await expect(header).toContainText('this computer');
  await expect(header).toContainText('private agent workspace');
  await expect(panel.getByTestId('computer-controller')).toHaveText('Control: Atlas');
  await panel.getByRole('button', { name: 'Watch desktop' }).click();
  await expect(panel.getByText('View only', { exact: true })).toBeVisible();
  await takeControl(panel);
  await expect(panel.getByTestId('computer-controller')).toHaveText('Control: You');
  await expect(panel.getByText(/You are in control/)).toBeVisible();
  await expect(panel.getByRole('img', { name: 'Current private agent desktop' })).toBeVisible();
  await expect(panel.getByText(/The browser and its open pages are as the agent left them|A desktop browser session was started/)).toBeVisible();
  const surface = panel.getByRole('application', { name: 'Private agent desktop input' });
  await surface.scrollIntoViewIfNeeded(); const box = (await surface.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await page.mouse.move(box.x + 20, box.y + 20); await page.mouse.down(); await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 4 }); await page.mouse.up();
  await expect.poll(() => sent.length).toBeGreaterThanOrEqual(2);
  const lease = (await (await page.request.get(control + '/v1/agents/atlas/desktop/status', { headers: await operator(page.request) })).json()).leaseId;
  expect(sent.every(item => item.leaseId === lease)).toBe(true);
  expect(sent[0].input).toMatchObject({ type: 'click', button: 'right', x: 720, y: 450 });
  expect(sent[1].input).toMatchObject({ type: 'drag' });
  if(isMobile)await panel.getByRole('button',{name:'Scroll down',exact:true}).click();
  else {await surface.hover();await page.mouse.wheel(0,120);}
  await expect.poll(()=>sent.some(item=>(item.input as {type?:string}).type==='scroll')).toBe(true);
  await panel.getByRole('button', { name: 'Type on the desktop' }).click();
  await expect(panel.getByText(/Keyboard captured/)).toBeVisible();
  await page.keyboard.press('Control+Shift+t');
  await expect.poll(() => sent.some(item => (item.input as {key?:string}).key==='Control+Shift+t')).toBe(true);
  await page.keyboard.press('Control+Alt+Escape');
  await expect(panel.getByRole('button', { name: 'Type on the desktop' })).toBeVisible();
  await panel.getByRole('button', { name: 'Hand back, don’t continue' }).click();
  await expect(panel.getByText(/Handed back without starting a follow-up task/)).toBeVisible();
});

test('another member in control leaves this viewer view-only, and a lost lease stops input', async ({ page }) => {
  const panel = await openDesktop(page);
  await takeControl(panel);
  await page.route('**/v1/agents/atlas/desktop/input', route => route.fulfill({ status: 409, json: { error: 'Computer control changed. Reconnect before sending input.' } }));
  await panel.getByRole('button', { name: 'Tab', exact: true }).click();
  await expect(panel.getByRole('alert')).toContainText('Your control ended, so that input was not sent.');
  await page.unroute('**/v1/agents/atlas/desktop/input');
  await page.route('**/v1/agents/atlas/desktop/status', async route => { const response = await route.fetch(), value = await response.json(); return route.fulfill({ response, json: { ...value, youControl: false, canRelease: false, controllerName: 'Riley', ownershipState: 'human' } }); });
  await expect(panel.getByTestId('computer-controller')).toHaveText('Control: Riley', { timeout: 10_000 });
  await expect(panel.getByText(/Riley is in control/)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Hand back and continue' })).toHaveCount(0);
  await panel.getByRole('tab', { name: 'Terminal' }).click();
  await expect(panel.getByText('Riley is using this workspace. Only the person in control can open or see its terminal.')).toBeVisible();
  await expect(panel.getByTestId('workspace-terminal-screen')).toHaveCount(0);
  await page.unroute('**/v1/agents/atlas/desktop/status');
});

test('an offline assigned computer is labelled and blocks taking control', async ({ page }) => {
  await page.route('**/v1/agents/atlas/desktop/status', async route => { const response = await route.fetch(), value = await response.json(); return route.fulfill({ response, json: { ...value, machine: { id: 'runner-1', name: 'Studio Mac', status: 'offline', local: false } } }); });
  const panel = await openDesktop(page);
  await expect(panel.getByLabel('Computer status')).toContainText('Studio Mac · paired computer · offline');
  await expect(panel.getByRole('alert')).toContainText('Waiting for Studio Mac to reconnect');
  await expect(panel.getByRole('button', { name: 'Take control', exact: true })).toBeDisabled();
});

test('live desktop viewing renews its ticket without returning control or replaying input', async ({ page }) => {
  let tickets = 0, connections = 0;
  const inputs: number[] = [];
  await page.route('**/v1/agents/atlas/desktop/stream', route => route.fulfill({ status: 201, json: { path: `/v1/desktop-stream?ticket=viewer-${++tickets}`, sessionSeconds: 2 } }));
  await page.routeWebSocket(/\/v1\/desktop-stream\?/, ws => {
    connections++; let phase = 0;
    ws.onMessage(message => {
      const bytes = Buffer.from(message);
      if (phase++ === 0) ws.send(Buffer.from([1, 1]));
      else if (phase === 2) ws.send(Buffer.alloc(4));
      else if (phase === 3) {
        const init = Buffer.alloc(28); init.writeUInt16BE(2, 0); init.writeUInt16BE(2, 2);
        init[4] = 32; init[5] = 24; init[7] = 1;
        for (const offset of [8, 10, 12]) init.writeUInt16BE(255, offset);
        init[14] = 16; init[15] = 8; init.writeUInt32BE(4, 20); init.write('test', 24); ws.send(init);
      } else if ([4, 5, 6].includes(bytes[0])) inputs.push(bytes[0]);
    });
    ws.send(Buffer.from('RFB 003.008\n'));
  });
  const panel = await openDesktop(page);
  // Playwright's routed socket inherits methods one level deeper than a native socket.
  // noVNC checks the immediate prototype, so expose the same native interface in this fixture.
  await page.evaluate(() => {
    for (const key of ['send','close','binaryType','onerror','onmessage','onopen','protocol','readyState']) {
      if (Object.hasOwn(WebSocket.prototype,key)) continue;
      let parent=Object.getPrototypeOf(WebSocket.prototype);
      while(parent&&!Object.hasOwn(parent,key))parent=Object.getPrototypeOf(parent);
      if(parent)Object.defineProperty(WebSocket.prototype,key,Object.getOwnPropertyDescriptor(parent,key)!);
    }
  });
  await panel.getByRole('button', { name: 'Watch desktop' }).click();
  await panel.getByRole('button', { name: 'Use live desktop' }).click();
  await expect(panel.getByText('Live desktop · view only; input goes through your control session')).toBeVisible();
  await expect.poll(() => connections).toBeGreaterThanOrEqual(2);
  await expect(panel.getByText('Live desktop · view only; input goes through your control session')).toBeVisible();
  await expect(panel.getByTestId('computer-controller')).toHaveText('Control: Atlas');
  expect(tickets).toBeGreaterThanOrEqual(2); expect(inputs).toEqual([]);
});

test('a teammate agent holding the shared browser and an older runner are both explained', async ({ page }) => {
  await page.route('**/v1/agents/atlas/desktop/status', async route => { const response = await route.fetch(), value = await response.json(); return route.fulfill({ response, json: { ...value, controlled: true, youControl: false, ready: false, leaseId: '', canRelease: false, controllerAgentId: 'scout', controllerName: 'Scout', ownershipState: 'human', machine: { id: 'runner-2', name: 'Lab box', status: 'online', local: false, capabilities: { features: [] } } } }); });
  const panel = await openDesktop(page);
  await expect(panel.getByText('Scout is using this shared browser. You can watch; take control after it finishes.')).toBeVisible();
  await expect(panel.getByRole('button', { name: /Hand back|Release/ })).toHaveCount(0);
  await panel.getByRole('tab', { name: 'Terminal' }).click();
  await expect(panel.getByText('Update the Open Harness runner on Lab box to use continuous desktop control.').first()).toBeVisible();
});
