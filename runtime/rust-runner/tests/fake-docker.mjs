#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const [command, ...args] = process.argv.slice(2);
const state = process.env.OPEN_HARNESS_RUNNER_STATE_DIR;
const emit = (value) => console.log(JSON.stringify(value));
const sessionId = 'test-session';
const answer = 'The Rust runner completed the task.';
const event = (type, payload) => emit({ method: 'event', params: { type, session_id: sessionId, payload } });

switch (command) {
  case 'info':
    console.log('28.0.0');
    break;
  case 'image':
    console.log(`sha256:${'a'.repeat(64)} 3`);
    break;
  case 'ps':
  case 'rm':
    break;
  case 'run':
    appendFileSync(join(state, 'docker-starts'), 'start\n');
    break;
  case 'exec': {
    if (!args.includes('/opt/open-harness/managed_entry.py')) process.exit(1);
    const profile = join(state, 'agents', 'atlas', 'profile');
    if (!readFileSync(join(profile, '.env'), 'utf8').includes('OPEN_HARNESS_MODEL_API_KEY="pilot-provider-key"')) process.exit(1);
    event('gateway.ready', {});
    for await (const line of createInterface({ input: process.stdin })) {
      const { method, id } = JSON.parse(line);
      if (method === 'session.create') emit({ id, result: { session_id: sessionId } });
      if (method === 'prompt.submit') {
        event('message.delta', { text: answer });
        // Real Hermes can send completion before the prompt RPC acknowledgment.
        event('message.complete', { text: answer, status: 'complete' });
        emit({ id, result: { status: 'streaming' } });
      }
    }
    break;
  }
  default:
    process.exit(1);
}
