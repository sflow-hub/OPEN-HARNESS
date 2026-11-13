import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { initialWorkspace } from '../../lib/types';
import { draftProfile } from '../../lib/agent-profile';

const control = `http://127.0.0.1:${process.env.OPEN_HARNESS_TEST_PORT || 4317}`;
async function seed(request: APIRequestContext) {
  const { token } = await (await request.get(control + '/v1/bootstrap')).json();
  const headers = { Authorization: `Bearer ${token}` };
  await request.post(control + '/v1/agents/sync', { headers, data: { agents: initialWorkspace.agents } });
  for (const agent of initialWorkspace.agents) {
    const { profile } = await (await request.get(control + `/v1/agents/${agent.id}/profile`, { headers })).json();
    await request.put(control + `/v1/agents/${agent.id}/profile`, { headers, data: { ...draftProfile(agent), revision: profile.revision } });
  }
  const response = await request.post(control + '/v1/teams', { headers, data: { name: `Conversation crew ${crypto.randomUUID().slice(0, 8)}`, description: '', color: 'sage', icon: 'people', memberAgentIds: ['atlas', 'scout'] } });
  expect(response.ok()).toBeTruthy();
  return { team: await response.json() as { id: string; name: string }, headers };
}
async function openGroups(page: Page, mobile: boolean) {
  if (mobile) await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Group conversations', exact: true }).click();
  return page.getByRole('region', { name: 'Group conversations', exact: true });
}
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('open-harness.onboarding.v1', 'done'); localStorage.setItem('open-harness.advanced.v1', 'on'); });
});

test('creates a group, dispatches two replies and keeps the transcript after reload', async ({ page, request }, testInfo) => {
  const { team, headers } = await seed(request), title = `Launch discussion ${testInfo.project.name}`;
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  let groups = await openGroups(page, testInfo.project.name === 'mobile');
  await groups.getByLabel('Team', { exact: true }).selectOption(team.id);
  await groups.getByLabel('Conversation name').fill(title);
  const participants = groups.getByRole('group', { name: 'Participants' });
  await participants.getByRole('checkbox', { name: 'Atlas', exact: true }).check();
  await participants.getByRole('checkbox', { name: 'Scout', exact: true }).check();
  await groups.getByRole('button', { name: 'Create group conversation', exact: true }).click();
  await expect(groups.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await groups.getByLabel('Message the group').fill('Prepare your own section of the launch brief.');
  await groups.getByRole('button', { name: 'Send and request replies' }).click();
  await expect(groups.getByText('Hermes mock completed the task.', { exact: true })).toHaveCount(2);
  const saved = await (await request.get(control + '/v1/groups', { headers })).json();
  const groupId = saved.groups.find((item: { title: string; teamId: string }) => item.title === title && item.teamId === team.id).id;
  const detail = await (await request.get(control + `/v1/groups/${groupId}`, { headers })).json();
  expect(detail.messages).toHaveLength(3); expect(detail.runs).toHaveLength(2);
  expect(detail.runs.map((run: { agent_id: string }) => run.agent_id).sort()).toEqual(['atlas', 'scout']);
  await page.reload(); groups = await openGroups(page, testInfo.project.name === 'mobile');
  await groups.getByRole('button', { name: title, exact: true }).click();
  await expect(groups.getByText('Prepare your own section of the launch brief.', { exact: true })).toBeVisible();
  await expect(groups.getByText('Hermes mock completed the task.', { exact: true })).toHaveCount(2);
});

test('failed group send retains the draft and retry ID and posting without recipients starts no work', async ({ page, request }, testInfo) => {
  const { team, headers } = await seed(request), title = `Ops notes ${testInfo.project.name}`;
  const created = await request.post(control + '/v1/groups', { headers, data: { teamId: team.id, title, memberAgentIds: ['atlas','scout'] } });
  const group = await created.json();
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  const groups = await openGroups(page, testInfo.project.name === 'mobile');
  await groups.getByRole('button', { name: title, exact: true }).click();
  const recipients = groups.getByRole('group', { name: 'Ask for a reply (up to four)' });
  await recipients.getByRole('checkbox', { name: 'Atlas', exact: true }).uncheck();
  await recipients.getByRole('checkbox', { name: 'Scout', exact: true }).uncheck();
  const retryIds: string[] = [];
  await page.route(`**/v1/groups/${group.id}/messages`, route => {
    retryIds.push(route.request().postDataJSON().requestId);
    return retryIds.length === 1 ? route.fulfill({ status: 503, json: { error: 'The coordinator is temporarily unavailable.' } }) : route.continue();
  });
  await groups.getByLabel('Message the group').fill('Save this decision for the next meeting.');
  await groups.getByRole('button', { name: 'Post without starting work' }).click();
  await expect(groups.getByRole('alert')).toContainText('temporarily unavailable');
  await expect(groups.getByLabel('Message the group')).toHaveValue('Save this decision for the next meeting.');
  await groups.getByRole('button', { name: 'Post without starting work' }).click();
  await expect(groups.getByText('Save this decision for the next meeting.', { exact: true })).toBeVisible();
  expect(retryIds).toHaveLength(2); expect(retryIds[0]).toBe(retryIds[1]);
  const saved = await (await request.get(control + `/v1/groups/${group.id}`, { headers })).json();
  expect(saved.messages).toHaveLength(1); expect(saved.runs).toHaveLength(0);
});
