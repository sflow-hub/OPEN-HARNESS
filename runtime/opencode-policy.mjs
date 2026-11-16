import { readFileSync } from 'node:fs';
import { createManagedPolicy } from './opencode-policy-core.mjs';

export default async function ManagedPolicy() {
  const policy = JSON.parse(readFileSync('/run/open-harness/policy.json','utf8'));
  const hooks = createManagedPolicy(policy);
  process.stderr.write('OPEN_HARNESS_POLICY_READY=' + policy.runId + '\n');
  return hooks;
}
