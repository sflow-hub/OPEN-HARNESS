import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentInstructions, prepareProfile } from '../runtime/profile-runtime';
import { API_TOOL, DEFAULT_MODEL, draftProfile } from '../lib/agent-profile';

const atlas = () => draftProfile({ id: 'atlas', name: 'Atlas', role: 'Research partner', description: 'Finds and compares sources.', tone: 0, instructions: 'Pull new tasks from the board each morning.', memory: [] });

test('every harness gets the agent identity, the operator instructions and its API grants', () => {
  const profile = { ...atlas(), allowedTools: [...atlas().allowedTools, API_TOOL], credentialGrants: [{ credentialRef: 'CRM_TOKEN', allowedOrigins: ['https://crm.example'], allowedMethods: ['GET'] }] } as ReturnType<typeof atlas>;
  assert.equal(agentInstructions(profile), '## Who you are\nYour name is Atlas. Your role: Research partner.\nFinds and compares sources.\n\nPull new tasks from the board each morning.\n\n## API access\nUse api_request with these credential references and permitted origins/methods:\nCRM_TOKEN: https://crm.example (GET)');
  assert.equal(agentInstructions({ ...atlas(), prompt: { enabled: false, text: 'Kept.' } }), '## Who you are\nYour name is Atlas. Your role: Research partner.\nFinds and compares sources.');
});

test('Hermes receives SOUL.md with a policy hash that lets the managed entry trust exactly that text', t => {
  const root = mkdtempSync(join(tmpdir(), 'harness-soul-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  prepareProfile(root, atlas(), DEFAULT_MODEL, { environment: () => ({}) }, '', 'run-1');
  const soul = readFileSync(join(root, 'agents/atlas/profile/SOUL.md'));
  assert.equal(soul.toString('utf8'), agentInstructions(atlas()));
  assert.equal(JSON.parse(readFileSync(join(root, 'agents/atlas/managed/policy.json'), 'utf8')).soulSha256, createHash('sha256').update(soul).digest('hex'));
});

test('the managed entry loads the trusted SOUL.md intact and still scans everything else', () => {
  const result = spawnSync('python3', ['tests/soul-trust-test.py'], { cwd: join(import.meta.dirname, '..'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
