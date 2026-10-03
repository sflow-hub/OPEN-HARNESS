import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { runSoakLoop } from './soak-loop.mjs';

// The dashboard's cached workspace: STORAGE_KEY and LEGACY_STORAGE_KEY in app/page.tsx. The
// browser's pairing token has its own key (open-harness.pair.v1:<origin>/api/local) and is kept.
export const WORKSPACE_CACHE_KEYS = Object.freeze(['open-harness.workspace.v2', 'open-harness.workspace.v1']);

export function assertSoakResources(resources) {
  for (const location of ['artifacts', 'data', 'engine']) {
    const value = resources[location];
    assert.ok(Number.isSafeInteger(value?.availableBytes) && value.availableBytes >= 4 * 1024 ** 3, `${location} has less than the 4 GiB soak stop floor or no valid measurement.`);
  }
  for (const location of ['data', 'engine']) assert.ok(Number.isSafeInteger(resources[location].usedKiB) && resources[location].usedKiB >= 0, `${location} size was not measured.`);
}

// Uses a real browser with the normal pairing link, without request interception,
// injected operator tokens, or mocked coordinator responses.
export async function runComposeSoak({ mode, root, api, waitRun, dc, nodeIn, refreshEndpoint, getEndpoint, mintBrowserCode, agentIds, sampleResources, imageBindings, containerStates, watchContainers }) {
  const { chromium, expect } = await import('@playwright/test');
  const fd = openSync(join(root, 'soak-journal.jsonl'), 'wx', 0o600);
  const record = entry => { writeSync(fd, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'); fsyncSync(fd); };
  let browser, context, page, monitor, pairRequests = 0, latest, originalBindings, containers, plannedRestart = false;
  const id = randomUUID().slice(0, 8), pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  // Shows the marker's conversation through the real search and sidebar. The question banner
  // falls back to any pending input (app/page.tsx pendingInput), so the transcript on screen
  // must first be this conversation's own prompt.
  const enter = async marker => {
    await expect(page).not.toHaveURL(/#/);
    await expect(page.locator('.sidebar-bottom')).toContainText('Agent runtime ready', { timeout: 45_000 });
    assert.equal(pairRequests, 1, 'A reopened browser must use its saved pairing session.');
    if (marker) {
      await page.getByRole('textbox', { name: 'Search conversations' }).fill(marker);
      const found = page.locator('aside.sidebar .recent');
      await expect(found).toHaveCount(1, { timeout: 30_000 });
      await found.click();
      await expect(page.locator('.transcript .message.user').filter({ hasText: `COMPOSE_SOAK:${marker}` })).toHaveCount(1, { timeout: 30_000 });
    }
  };
  const load = async code => {
    try { await page.goto(getEndpoint() + (code ? `/#pair=${encodeURIComponent(code)}` : '/')); }
    catch { throw new Error('Soak browser could not load the dashboard.'); }
  };
  const open = async (marker, code) => { page = await context.newPage(); await load(code); await enter(marker); };
  // A completed reply must come back without the browser's own copy. The cached workspace is
  // removed before any page script runs, the conversation list the page then fetches must hold
  // the completed run, and the transcript can only have been rebuilt from that list.
  const replay = async ({ marker, runId, reply }, navigate) => {
    await page.addInitScript(keys => { for (const key of keys) localStorage.removeItem(key); }, [...WORKSPACE_CACHE_KEYS]);
    const listed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/local/v1/conversations', { timeout: 45_000 });
    listed.catch(() => {}); // awaited below, after the page has shown whether it connected at all
    await navigate();
    await enter(null);
    const history = await listed;
    assert.equal(history.status(), 200, 'The coordinator did not serve conversation history.');
    const served = (await history.json()).conversations.filter(item => item.id === `soak-${marker}`);
    assert.equal(served.length, 1, 'The coordinator did not serve the soak conversation to a browser without its cache.');
    const run = served[0].runs.find(item => item.id === runId);
    assert.ok(run?.state === 'completed' && run.result === reply, 'The coordinator did not serve the completed soak reply.');
    await enter(marker);
    await expect(page.locator('.transcript .message.assistant .markdown').last()).toHaveText(reply, { timeout: 30_000 });
    assert.deepEqual(await page.evaluate(() => Object.keys(localStorage).filter(key => /^open-harness\.workspace\.v\d+$/.test(key) && key !== 'open-harness.workspace.v2')), [], 'The dashboard caches its workspace under another key; update the soak replay check.');
  };
  const close = async () => { await page.close(); page = null; assert.equal(context.pages().length, 0, 'All dashboard pages must be closed.'); };
  // A restart policy can restart a crashed service between two checks without changing any
  // image. Only the planned coordinator restart may change a start time; no container may be
  // replaced. Returns whether that planned restart was observed.
  const checkContainers = async () => {
    monitor.assertHealthy();
    const current = await containerStates();
    assert.deepEqual(Object.keys(current).sort(), Object.keys(containers).sort(), 'Soak services changed.');
    let restarted = false;
    for (const [service, state] of Object.entries(current)) {
      assert.equal(state.id, containers[service].id, `${service} container was replaced during the soak.`);
      if (state.startedAt === containers[service].startedAt) continue;
      assert.ok(service === 'open-harness' && plannedRestart, `${service} restarted outside the planned coordinator restart.`);
      plannedRestart = false;
      restarted = true;
    }
    containers = current;
    return restarted;
  };
  try {
    // Chromium's singleton socket cannot fit below a long durable evidence path.
    // Only the browser's transient sockets use /tmp; evidence remains in root.
    browser = await chromium.launch({ env: { ...process.env, ...(process.platform === 'win32' ? {} : { TMPDIR: '/tmp' }) }, ...(process.env.OPEN_HARNESS_SOAK_CHROMIUM ? { executablePath: process.env.OPEN_HARNESS_SOAK_CHROMIUM } : {}) });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    // Setup was already exercised by the surrounding fixture; pairing and
    // workspace hydration still go through the real browser and coordinator.
    await context.addInitScript(() => localStorage.setItem('open-harness.onboarding.v1', 'done'));
    context.on('request', request => { if (new URL(request.url()).pathname === '/api/local/v1/browser/pair') pairRequests += 1; });
    originalBindings = await imageBindings();
    const since = new Date().toISOString();
    containers = await containerStates();
    monitor = await watchContainers({ containers, since, record });
    const sources = ['../compose-smoke.mjs', './compose-soak.mjs', './soak-loop.mjs', './compose-provider.mjs', './soak-containers.mjs'].map(path => ({ path, sha256: createHash('sha256').update(readFileSync(new URL(path, import.meta.url))).digest('hex') }));
    record({ type: 'identity', images: originalBindings, containers, browserVersion: browser.version(), agentIds, sources });
    const pairing = await mintBrowserCode();
    try { await open(null, pairing.code); }
    catch (error) {
      const detail = String(error).replaceAll(pairing.code, '[redacted]').replaceAll(encodeURIComponent(pairing.code), '[redacted]');
      throw new Error(`Initial soak browser pairing failed: ${detail}`);
    }
    await close();
    const result = await runSoakLoop({
      mode, record,
      sample: async () => {
        await checkContainers();
        const resources = await sampleResources();
        try { assertSoakResources(resources); }
        catch (error) { record({ type: 'resource-rejected', resources }); throw error; }
        return resources;
      },
      restart: async () => {
        assert.ok(latest, 'The soak restart needs a completed cycle whose history it can verify.');
        const before = getEndpoint();
        await monitor.beforeRestart();
        plannedRestart = true;
        await dc(['restart', 'open-harness'], 45_000);
        await monitor.afterRestart();
        await refreshEndpoint();
        assert.equal(getEndpoint(), before, 'Soak restart changed the dashboard origin; preserved browser pairing cannot be verified.');
        let ready = false;
        for (let i = 0; i < 100; i += 1) { try { await api('/v1/agents'); ready = true; break; } catch { await pause(300); } }
        assert.ok(ready, 'Coordinator did not recover during soak.');
        assert.ok(await checkContainers(), 'The planned restart did not restart the coordinator container.');
        assert.deepEqual((await api(`/v1/runs/${latest.runId}/events?after=0`)).events, latest.events, 'Restart changed completed run history.');
        assert.deepEqual(await imageBindings(), originalBindings, 'Soak image identities changed at restart.');
        page = await context.newPage();
        await replay(latest, () => load());
        await close();
        return { completedRunPreserved: latest.runId, historyServedAfterRestart: true, browserSessionPreserved: true, imagesUnchanged: true, containersPreserved: true };
      },
      cycle: async index => {
        const agentId = agentIds[index % agentIds.length], marker = `${id}-${index}-${agentId}`;
        const reply = `COMPOSE_SOAK_COMPLETE:${marker}`;
        const run = await api('/v1/runs', 'POST', { agentId, conversationId: `soak-${marker}`, prompt: `COMPOSE_SOAK:${marker} COMPOSE_SMOKE COMPOSE_SEED_729: write, clarify, list tasks, and finish.` });
        record({ type: 'run-created', index, runId: run.id, agentId, marker });
        const waiting = await waitRun(run, { waitForInput: true });
        assert.equal(waiting.run.pendingInputs.length, 1);
        assert.equal(await dc(['exec', '-T', 'docker', 'docker', 'inspect', '-f', '{{.Image}}', `open-harness-${agentId}`]), originalBindings.runtime, 'Agent must execute the recorded runtime image.');
        await open(marker);
        const question = () => page.getByRole('form', { name: `${agentId} has a question` });
        await expect(question()).toBeVisible({ timeout: 30_000 });
        await close();
        await pause(5_000);
        const reconnect = await api(`/v1/runs/${run.id}/events?after=0`);
        assert.equal(reconnect.run.id, run.id);
        assert.deepEqual(reconnect.run.pendingInputs, waiting.run.pendingInputs, 'Closing the browser lost or replaced the pending input.');
        const peer = agentIds.find(id => id !== agentId);
        const isolation = JSON.parse(await dc(['exec', '-T', 'docker', 'docker', 'exec', `open-harness-${agentId}`, 'python', '-c', `import json\nfrom pathlib import Path\nassert Path('/workspace/private/desktop-owner.txt').read_text() == '${agentId}'\nfor p in ['/data','/var/run/docker.sock','/run/open-harness-docker/docker.sock','/home/node','/data/agents/${peer}']:\n assert not Path(p).exists(), p\nprint(json.dumps({'privateOwner':'${agentId}','hostPathsAbsent':True}))`]));
        assert.equal(isolation.privateOwner, agentId);
        if (index % 2) {
          await open(marker);
          await expect(question()).toBeVisible({ timeout: 30_000 });
          await question().getByRole('textbox', { name: 'Your answer' }).fill('compose-soak-answer');
          await question().getByRole('button', { name: 'Send answer' }).click();
          await expect(question()).toBeHidden({ timeout: 30_000 });
        } else {
          await api(`/v1/runs/${run.id}/input`, 'POST', { inputId: waiting.run.pendingInputs[0].inputId, value: 'compose-soak-answer' });
        }
        const completed = await waitRun(run, { answerInputs: false });
        assert.equal(completed.run.result, reply);
        for (const type of ['clarify.request', 'input.resolved', 'message.complete']) assert.ok(completed.events.some(event => event.type === type), type);
        assert.equal(completed.events.filter(event => event.type === 'input.resolved').length, 1, 'The input must be resolved once.');
        for (const name of ['write_file', 'mcp__open_harness__task']) assert.ok(completed.events.some(event => event.type === 'tool.complete' && event.payload.name === name), name);
        assert.equal((await api('/v1/files?scope=shared&name=compose-soak.txt')).content, `COMPOSE_SOAK:${marker}\n`);
        assert.equal(await nodeIn('open-harness', "import fs from 'node:fs'; console.log(JSON.stringify(fs.existsSync('/data/shared/compose-forbidden.txt')));"), false);
        assert.equal(await dc(['exec', '-T', 'docker', 'docker', 'inspect', '-f', '{{.State.Running}}', `open-harness-${agentId}`]), 'false');
        if (!page) await open(marker);
        await expect(page.locator('.transcript .message.assistant .markdown').last()).toHaveText(reply, { timeout: 30_000 });
        await expect(page.locator('.transcript .working')).toHaveCount(0);
        // A reload returns the dashboard to Home (view and conversation are page state only),
        // and the reply must come back from the coordinator, not from the page's cached copy.
        await replay({ marker, runId: run.id, reply }, () => page.reload());
        assert.deepEqual((await api(`/v1/runs/${run.id}/events?after=0`)).events, completed.events);
        await close();
        latest = { marker, runId: run.id, events: completed.events, reply };
        return { agentId, marker, runId: run.id, inputId: waiting.run.pendingInputs[0].inputId, answeredFrom: index % 2 ? 'reopened-browser' : 'api-while-browser-closed', completionReplayed: true, replayedWithoutBrowserCache: true, artifactVerified: true, isolation, containerStopped: true };
      },
    });
    assert.deepEqual(await imageBindings(), originalBindings, 'Soak ended with different images.');
    await checkContainers();
    assert.equal(pairRequests, 1);
    for (const source of sources) assert.equal(createHash('sha256').update(readFileSync(new URL(source.path, import.meta.url))).digest('hex'), source.sha256, 'Soak source changed during execution.');
    const containerLifecycle = await monitor.finish();
    const final = { ...result, images: originalBindings, containers, containerLifecycle, sources, browserVersion: browser.version(), pairedOnce: true, scriptedProvider: true, releaseScope: 'Requires independent matching to final release digests and all other release gates.' };
    // The journal's only success receipt, written after every end-of-run check has passed.
    record({ type: 'complete', result: final });
    return final;
  } catch (error) {
    record({ type: 'fixture-failed', error: String(error) });
    if (page && !page.url().includes('#')) await page.screenshot({ path: join(root, 'soak-failure.png') }).catch(() => {});
    throw error;
  } finally { await monitor?.close(); closeSync(fd); await browser?.close(); }
}
