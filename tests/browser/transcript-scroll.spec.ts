import { expect, test } from '@playwright/test';
import { initialWorkspace, type Conversation } from '../../lib/types';

test('keeps the reading position during streaming, resumes at the latest reply and resets on thread switch', async ({ page }) => {
  const threads: Conversation[] = ['Research notes', 'Planning notes'].map((title, index) => ({
    id: 'notes-' + index, agentId: 'atlas', title, updatedAt: new Date().toISOString(),
    messages: Array.from({ length: 24 }, (_, i) => ({
      id: 'note-' + i, role: 'user', content: title + ' entry ' + (i + 1),
    })),
  }));
  const run = { id: 'scroll-test-run', agent_id: 'atlas', conversation_id: threads[0].id, prompt: 'Summarize these notes', state: 'running' };
  const chunks: string[] = [];
  let finished = false;
  await page.addInitScript(workspace => {
    localStorage.setItem('open-harness.workspace.v2', JSON.stringify(workspace));
    localStorage.setItem('open-harness.onboarding.v1', 'done');
    localStorage.setItem('open-harness.migrated.v1', 'done');
  }, { ...initialWorkspace, conversations: threads });
  await page.route('**/v1/runs', route => route.fulfill({ json: { runs: [run] } }));
  await page.route('**/v1/runs/scroll-test-run/events?*', route => {
    const after = Number(new URL(route.request().url()).searchParams.get('after'));
    const events = chunks.map((text, i) => ({ seq: i + 1, id: String(i + 1), type: 'message.delta', payload: { text } }));
    return route.fulfill({ json: { run: { ...run, state: finished ? 'completed' : 'running' }, events: events.slice(after) } });
  });

  await page.goto('/?controlPort=' + (process.env.OPEN_HARNESS_TEST_PORT || 4317));
  const transcript = page.getByRole('region', { name: 'Conversation messages' });
  const jump = page.getByRole('button', { name: 'Jump to latest' });
  const bottomGap = () => transcript.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop);
  await expect(transcript).toContainText('Research notes entry 24');
  await expect.poll(bottomGap).toBeLessThanOrEqual(1);
  await expect(jump).toHaveCount(0);

  await transcript.evaluate(el => { el.scrollTop = 120; });
  await expect(jump).toBeVisible();
  const readingPosition = await transcript.evaluate(el => el.scrollTop);
  chunks.push('Additional research.\n\n'.repeat(16) + 'First update.');
  await expect(transcript).toContainText('First update.');
  expect(await transcript.evaluate(el => el.scrollTop)).toBe(readingPosition);

  await jump.focus();
  await jump.press('Enter');
  await expect(transcript).toBeFocused();
  await expect(jump).toHaveCount(0);
  await expect.poll(bottomGap).toBeLessThanOrEqual(1);

  await transcript.evaluate(el => { el.scrollTop = el.scrollHeight - el.clientHeight - 24; });
  chunks.push('\n\n' + 'Further research.\n\n'.repeat(16) + 'Final update.');
  finished = true;
  await expect(transcript).toContainText('Final update.');
  await expect.poll(bottomGap).toBeLessThanOrEqual(1);
  await expect(jump).toHaveCount(0);

  await transcript.evaluate(el => { el.scrollTop = 120; });
  await expect(jump).toBeVisible();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Planning notes', exact: true }).click();
  await expect(transcript).toContainText('Planning notes entry 24');
  await expect.poll(bottomGap).toBeLessThanOrEqual(1);
  await expect(jump).toHaveCount(0);
});
