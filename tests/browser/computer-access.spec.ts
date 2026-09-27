import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { initialWorkspace } from '../../lib/types';
import { draftProfile, type AgentProfile, type MachineInfo } from '../../lib/agent-profile';

// Where an agent works is an ordinary setting now: every agent runs in its own container,
// and the only desktop it can be given is a private one. Profiles saved before direct
// access and existing-desktop control were withdrawn are kept but blocked until they are
// moved into a container, deliberately, by the operator.
const control = `http://127.0.0.1:${process.env.OPEN_HARNESS_TEST_PORT || 4317}`;
type Capabilities = MachineInfo['capabilities'];

async function operator(request: APIRequestContext) {
  const { token } = await (await request.get(control + '/v1/bootstrap')).json();
  return { Authorization: `Bearer ${token}` };
}
async function seed(request: APIRequestContext) {
  const headers = await operator(request);
  await request.post(control + '/v1/agents/sync', { headers, data: { agents: initialWorkspace.agents } });
  const { profile } = await (await request.get(control + '/v1/agents/atlas/profile', { headers })).json();
  await request.put(control + '/v1/agents/atlas/profile', { headers, data: { ...draftProfile(initialWorkspace.agents[0]), revision: profile.revision } });
}
async function localMachine(request: APIRequestContext) {
  const { machines } = await (await request.get(control + '/v1/machines', { headers: await operator(request) })).json();
  return (machines as MachineInfo[]).find(machine => machine.id === 'local')!;
}
// A runner paired through the API, reporting exactly the capabilities the case needs, so the
// suite does not depend on what the computer running it can do. It is never saved onto an
// agent: a mock runner cannot complete the transfer that a save would start.
async function pairRunner(request: APIRequestContext, name: string, platform: 'linux' | 'win32', capabilities: Capabilities) {
  const headers = await operator(request);
  const pairing = await (await request.post(control + '/v1/machines', { headers, data: { name, platform } })).json();
  await request.post(control + '/v1/runner/pair', { data: { code: pairing.code, name, platform, arch: 'x64', capabilities } });
  const { machines } = await (await request.get(control + '/v1/machines', { headers })).json();
  return (machines as MachineInfo[]).find(machine => machine.name === name)!;
}
// What an older dashboard could have saved: the coordinator still returns it, so the editor
// has to show it and refuse to save it until it is changed.
const legacy = (computer: Partial<AgentProfile['computer']>) => async (page: Page) => {
  await page.route(`${control}/v1/agents/atlas/profile`, async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, profile: { ...body.profile, computer: { ...body.profile.computer, ...computer } } } });
  });
};
async function openComputerTab(page: Page, name = 'Atlas') {
  await page.getByRole('button', { name: `Edit ${name} profile` }).click();
  const panel = page.getByRole('dialog', { name: 'Agent settings' });
  await expect(panel.getByText('Loading saved profile…')).toBeHidden();
  await panel.getByRole('tab', { name: 'Computer', exact: true }).click();
  return panel;
}

test.beforeEach(async ({ request, page }) => {
  await seed(request);
  await page.addInitScript(() => { localStorage.setItem('open-harness.onboarding.v1', 'done'); localStorage.setItem('open-harness.advanced.v1', 'off'); });
});

test('an agent can be given a private agent desktop from Computer settings, without Advanced features', async ({ page, request }) => {
  const local = await localMachine(request);
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  await expect(page.getByRole('button', { name: 'Edit Atlas profile' })).toBeVisible();
  const panel = await openComputerTab(page);
  await expect(panel.getByRole('radio', { name: 'Private workspace' })).toBeChecked();
  // The withdrawn modes are not on offer at all, not merely disabled.
  await expect(panel.getByText('Direct computer access', { exact: true })).toHaveCount(0);
  await expect(panel.getByText(/signed-in desktop is not available|signed in to is not available/)).toBeVisible();
  await expect(panel.getByLabel('Desktop access')).toHaveCount(0);
  // Reservations and resource limits stay behind Advanced features.
  await expect(panel.getByRole('switch', { name: 'Reserve this computer for this agent' })).toHaveCount(0);
  const desktop = panel.getByRole('switch', { name: 'Private agent desktop' });
  if (!local.capabilities.virtualDesktop) {
    // The computer running this suite cannot host one; the switch says why instead of failing later.
    await expect(desktop).toBeDisabled();
    await expect(panel.getByText(/Private agent desktops run in Linux containers|Docker is not available/)).toBeVisible();
    return;
  }
  await expect(desktop).toBeEnabled();
  await desktop.check();
  // The desktop is provided, but nothing is granted behind the operator's back: the tools to
  // use it are switched on in Tools & connections, and the note beside the switch says so.
  await expect(panel.getByText(/switch on Desktop control in Tools & connections/)).toBeVisible();
  await panel.getByRole('button', { name: 'Open Tools & connections' }).click();
  await expect(panel.getByRole('tab', { name: 'Tools & connections' })).toHaveAttribute('aria-selected', 'true');
  const desktopTools = panel.getByRole('checkbox', { name: 'Enable Desktop control', exact: true });
  await expect(desktopTools).not.toBeChecked();
  await desktopTools.check();
  await panel.getByRole('button', { name: 'Save changes' }).click();
  await expect(panel.getByText('Saved. Ready for the next task.')).toBeVisible();
  const headers = await operator(request);
  const saved = await (await request.get(control + '/v1/agents/atlas/profile', { headers })).json();
  expect(saved.profile.computer).toMatchObject({ access: 'private', desktop: 'virtual' });
  expect(saved.profile.allowedTools).toContain('computer_use');
  await panel.getByRole('tab', { name: 'Computer', exact: true }).click();
  await expect(panel.getByText('Desktop control tools are switched on for this agent in Tools & connections.')).toBeVisible();
  // Reopening shows the choice as saved.
  await panel.getByRole('button', { name: 'Close agent settings' }).click();
  await expect(panel).toBeHidden();
  const again = await openComputerTab(page);
  await expect(again.getByRole('switch', { name: 'Private agent desktop' })).toBeChecked();
});

test('the private desktop switch explains why a computer cannot provide one', async ({ page, request }, testInfo) => {
  const windows = await pairRunner(request, `Design box ${testInfo.project.name}`, 'win32', { container: true, direct: false, desktop: false, virtualDesktop: false });
  const linuxNoDocker = await pairRunner(request, `Bare Linux ${testInfo.project.name}`, 'linux', { container: false, direct: false, desktop: false, virtualDesktop: false });
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  await expect(page.getByRole('button', { name: 'Edit Atlas profile' })).toBeVisible();
  const panel = await openComputerTab(page);
  const desktop = panel.getByRole('switch', { name: 'Private agent desktop' });
  await panel.getByLabel('Connected computer').selectOption(windows.id);
  await expect(desktop).toBeDisabled();
  await expect(panel.getByText(`Private agent desktops run in Linux containers. ${windows.name} runs Windows; connect a Linux computer with Docker to give this agent a desktop.`)).toBeVisible();
  await panel.getByLabel('Connected computer').selectOption(linuxNoDocker.id);
  await expect(desktop).toBeDisabled();
  await expect(panel.getByText(`Docker is not available on ${linuxNoDocker.name}. Install and start Docker there to give this agent a desktop.`)).toBeVisible();
  // Nothing was saved onto Atlas; leave the draft behind.
  await panel.getByRole('button', { name: 'Close agent settings' }).click();
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await expect(panel).toBeHidden();
});

test('a legacy direct-access profile is blocked until it is moved into a container, deliberately', async ({ page, request }) => {
  const local = await localMachine(request);
  await legacy({ access: 'direct', desktop: 'existing', folders: [{ id: 'kept', path: '/tmp/open-harness-kept', mode: 'read' }] })(page);
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  await expect(page.getByRole('button', { name: 'Edit Atlas profile' })).toBeVisible();
  const panel = await openComputerTab(page);
  const notice = panel.getByRole('alert').filter({ hasText: 'no longer available' });
  await expect(notice).toContainText('Control of this computer’s signed-in desktop is no longer available.');
  await expect(notice).toContainText('will not start this agent or save its settings');
  // Nothing is chosen for it, and nothing can be saved or probed, until the operator decides.
  await expect(panel.getByRole('radio', { name: 'Private workspace' })).not.toBeChecked();
  await expect(panel.getByRole('radio', { name: 'Selected folders' })).not.toBeChecked();
  await expect(panel.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Test access' })).toBeDisabled();
  await expect(panel.getByText('Computer settings must change before this agent can be saved.')).toBeVisible();
  await expect(panel.getByRole('switch', { name: 'Private agent desktop' })).toBeDisabled();
  if (local.capabilities.virtualDesktop) {
    await notice.getByRole('button', { name: 'Use a private agent desktop' }).click();
    await expect(panel.getByRole('switch', { name: 'Private agent desktop' })).toBeChecked();
  } else {
    await expect(notice.getByRole('button', { name: 'Use a private agent desktop' })).toHaveCount(0);
    await notice.getByRole('button', { name: 'Use a private workspace' }).click();
    await expect(panel.getByRole('switch', { name: 'Private agent desktop' })).not.toBeChecked();
  }
  await expect(notice).toHaveCount(0);
  // The folder it already listed stays a granted folder; access narrows, it never widens.
  await expect(panel.getByRole('radio', { name: 'Selected folders' })).toBeChecked();
  await panel.getByText('Advanced resources and shared folders').click();
  await expect(panel.getByLabel('Shared folder 1 path')).toHaveValue('/tmp/open-harness-kept');
  await expect(panel.getByLabel('Shared folder 1 access')).toHaveValue('read');
  await panel.getByRole('button', { name: 'Save changes' }).click();
  await expect(panel.getByText('Saved. Ready for the next task.')).toBeVisible();
  const headers = await operator(request);
  const saved = await (await request.get(control + '/v1/agents/atlas/profile', { headers })).json();
  expect(saved.profile.computer).toMatchObject({ access: 'folders', desktop: local.capabilities.virtualDesktop ? 'virtual' : 'none', folders: [{ path: '/tmp/open-harness-kept', mode: 'read' }] });
});

test('a conversation with a legacy agent says so and opens its Computer settings', async ({ page }, testInfo) => {
  await legacy({ access: 'direct', desktop: 'none' })(page);
  // The workspace learns each agent's saved computer settings from the sync reply.
  await page.route(`${control}/v1/agents/sync`, async route => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, agents: body.agents.map((agent: { id: string; profile?: AgentProfile }) => agent.id === 'atlas' && agent.profile ? { ...agent, profile: { ...agent.profile, computer: { ...agent.profile.computer, access: 'direct' } } } : agent) } });
  });
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  await expect(page.getByRole('button', { name: 'Edit Atlas profile' })).toBeVisible();
  await expect(page.locator('.agent-card').filter({ hasText: 'Atlas' })).toContainText('Needs new computer settings');
  if (testInfo.project.name === 'mobile') await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.locator('aside.sidebar .agent-row', { hasText: 'Atlas' }).click();
  const banner = page.getByRole('alert').filter({ hasText: 'Atlas needs new computer settings' });
  await expect(banner).toContainText('no longer available because it ran outside the sandbox');
  await banner.getByRole('button', { name: 'Open Computer settings' }).click();
  const panel = page.getByRole('dialog', { name: 'Agent settings' });
  await expect(panel.getByRole('tab', { name: 'Computer', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByText('Loading saved profile…')).toBeHidden();
  await expect(panel.getByRole('alert').filter({ hasText: 'Direct computer access is no longer available.' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  await panel.getByRole('button', { name: 'Close agent settings' }).click();
  await expect(panel).toBeHidden();
  await page.unroute(`${control}/v1/agents/sync`);
});

// The Docker Desktop install reports the host folders exported to it (`folderExports`); a
// native or remote runner reports nothing and keeps the typed-path editor. The mock
// coordinator never sets the field, so these cases add it to the local machine's answer.
const exporting = (folderExports: MachineInfo['folderExports']) => async (page: Page) => {
  await page.route(`${control}/v1/machines`, async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const body = await response.json() as { machines: MachineInfo[] };
    await route.fulfill({ response, json: { ...body, machines: body.machines.map(machine => machine.id === 'local' ? { ...machine, folderExports } : machine) } });
  });
};

test('a Docker Desktop install offers only the folders exported to it, at their container paths', async ({ page, request }) => {
  await exporting([{ path: '/host-folders/project', mode: 'read' }, { path: '/host-folders/notes', mode: 'write' }])(page);
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  await expect(page.getByRole('button', { name: 'Edit Atlas profile' })).toBeVisible();
  const panel = await openComputerTab(page);
  await panel.getByRole('radio', { name: 'Selected folders' }).check();
  await panel.getByText('Advanced resources and shared folders').click();
  // A path on the computer is named only to say it cannot be used here.
  const note = panel.getByText('Open Harness is running in Docker Desktop.');
  await expect(note).toContainText('C:\\Projects\\website');
  await expect(note).toContainText('cannot be selected here directly');
  await expect(note).toContainText('Exported now: /host-folders/project (read-only), /host-folders/notes (read/write)');
  await panel.getByRole('button', { name: 'Add folder' }).click();
  const path = panel.getByLabel('Shared folder 1 path');
  await expect(path).toHaveRole('combobox');
  await expect(panel.getByRole('textbox', { name: 'Shared folder 1 path' })).toHaveCount(0);
  await expect(path.getByRole('option')).toHaveText(['/host-folders/project · read-only', '/host-folders/notes · read/write']);
  await expect(path).toHaveValue('/host-folders/project');
  // A read-only export cannot be granted read/write: the choice is not offered.
  const access = panel.getByLabel('Shared folder 1 access');
  await expect(access).toHaveValue('read');
  await expect(access).toBeDisabled();
  await expect(access.getByRole('option')).toHaveText(['Read only']);
  await expect(panel.getByText('Shared read-only with Open Harness.')).toBeVisible();
  await path.selectOption('/host-folders/notes');
  await expect(access).toBeEnabled();
  await access.selectOption('write');
  await panel.getByRole('button', { name: 'Save changes' }).click();
  await expect(panel.getByText('Saved. Ready for the next task.')).toBeVisible();
  const headers = await operator(request);
  const saved = await (await request.get(control + '/v1/agents/atlas/profile', { headers })).json();
  expect(saved.profile.computer.access).toBe('folders');
  expect(saved.profile.computer.folders.map(({ path, mode }: { path: string; mode: string }) => ({ path, mode }))).toEqual([{ path: '/host-folders/notes', mode: 'write' }]);
  // The same installation refuses model servers on this computer's loopback or Docker's host
  // aliases, so the endpoint hint on the Model tab does not suggest them.
  await panel.getByRole('tab', { name: 'Model' }).click();
  await panel.getByText('Advanced endpoint').click();
  await expect(panel.getByLabel('Model API base URL')).toHaveAttribute('placeholder', 'https://models.example.com/v1');
  await expect(panel.getByText(/host\.docker\.internal on this computer are refused here/)).toBeVisible();
  await expect(panel.getByText(/use host\.docker\.internal/)).toHaveCount(0);
  // Back on a computer that reports no exports, the same grant is an ordinary typed path, and
  // the endpoint hint is the native one again.
  await page.unroute(`${control}/v1/machines`);
  await panel.getByRole('button', { name: 'Close agent settings' }).click();
  await expect(panel).toBeHidden();
  const again = await openComputerTab(page);
  await again.getByText('Advanced resources and shared folders').click();
  await expect(again.getByRole('textbox', { name: 'Shared folder 1 path' })).toHaveValue('/host-folders/notes');
  await expect(again.getByText('Open Harness is running in Docker Desktop.')).toHaveCount(0);
  await again.getByRole('tab', { name: 'Model' }).click();
  await again.getByText('Advanced endpoint').click();
  await expect(again.getByLabel('Model API base URL')).toHaveAttribute('placeholder', 'http://host.docker.internal:11434/v1');
  await expect(again.getByText(/for a model server on the computer running the agent, use host\.docker\.internal/)).toBeVisible();
});

test('with nothing exported, the editor says how to export a folder instead of offering a path box', async ({ page }) => {
  await exporting([])(page);
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  await expect(page.getByRole('button', { name: 'Edit Atlas profile' })).toBeVisible();
  const panel = await openComputerTab(page);
  await panel.getByRole('radio', { name: 'Selected folders' }).check();
  await panel.getByText('Advanced resources and shared folders').click();
  await expect(panel.getByRole('button', { name: 'Add folder' })).toBeDisabled();
  const note = panel.getByText('Open Harness is running in Docker Desktop.');
  await expect(note).toContainText('No folders are exported yet.');
  await expect(note).toContainText('compose.host-folders.example.yaml');
  await expect(note).toContainText('--override');
  await expect(note).toContainText('Exports change only at a relaunch.');
  await expect(panel.getByLabel('Shared folder 1 path')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Close agent settings' }).click();
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await expect(panel).toBeHidden();
});

test('a saved grant the exports no longer cover is shown as such, and a read-only export asks for read-only access', async ({ page }) => {
  await exporting([{ path: '/host-folders/project', mode: 'read' }])(page);
  await legacy({ access: 'folders', folders: [{ id: 'gone', path: '/host-folders/old', mode: 'read' }, { id: 'narrowed', path: '/host-folders/project', mode: 'write' }] })(page);
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  await expect(page.getByRole('button', { name: 'Edit Atlas profile' })).toBeVisible();
  const panel = await openComputerTab(page);
  await panel.getByText('Advanced resources and shared folders').click();
  const gone = panel.getByLabel('Shared folder 1 path');
  await expect(gone).toHaveValue('/host-folders/old');
  await expect(gone.getByRole('option').first()).toHaveText('/host-folders/old · no longer exported');
  // The export was narrowed to read-only after this grant was saved: the stored choice stays
  // visible, and the way to make it saveable is spelled out rather than changed silently.
  const narrowed = panel.getByLabel('Shared folder 2 access');
  await expect(narrowed).toHaveValue('write');
  await expect(narrowed).toBeEnabled();
  await expect(panel.getByText('This folder is now shared read-only with Open Harness. Choose Read only to save.')).toBeVisible();
  await narrowed.selectOption('read');
  await expect(narrowed).toBeDisabled();
  await expect(panel.getByText('Shared read-only with Open Harness.')).toBeVisible();
  await panel.getByRole('button', { name: 'Close agent settings' }).click();
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await expect(panel).toBeHidden();
});
