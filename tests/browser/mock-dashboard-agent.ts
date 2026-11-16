import { HermesGateway } from '../../runtime/hermes';
import { atomicWorkspaceWrite, readWorkspaceFile, safeWorkspacePath } from '../../runtime/path-safety';

// Only the model's edit is deterministic. The coordinator still runs its ordinary
// task, freezes the resulting source, builds it, and applies the reviewed version.
if (process.env.OPEN_HARNESS_MOCK === '1') {
  const original = HermesGateway.prototype.submitPrompt;
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const candidateLine = new RegExp('^Edit the private dashboard source at /workspace/private/(improvement-' + uuid + '-' + uuid + ')\\.$', 'i');
  HermesGateway.prototype.submitPrompt = async function (sessionId, text, timeout) {
    const state = process.env.OPEN_HARNESS_STATE_DIR;
    const candidate = candidateLine.exec(text.split('\n')[0])?.[1];
    const agent = /^mock-([a-zA-Z0-9_-]+)$/.exec(this.container)?.[1];
    if (!state || !candidate || !agent || !text.includes('Change the Assistant heading to “How can I help?”')) return original.call(this, sessionId, text, timeout);
    // Keep the task live across the browser reconnect exercised by this scenario.
    await new Promise(resolve => setTimeout(resolve, 1500));
    const path = safeWorkspacePath(state, 'agents/' + agent + '/private/' + candidate + '/components/assistant-workspace.tsx');
    const source = readWorkspaceFile(path).toString('utf8');
    const before = '<h1>What would you like done?</h1>';
    if (!source.includes(before)) throw new Error('The expected Assistant heading was missing from the browser test candidate.');
    atomicWorkspaceWrite(path, source.replace(before, '<h1>How can I help?</h1>'));
    return { final_response: 'Updated the Assistant heading in the dashboard source.' };
  };
}
