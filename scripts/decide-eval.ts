// Live check of the decision engine against the real decision service, through the same code
// path the coordinator uses (credential transport, redaction, answer checks). Never part of
// `npm test`: it needs a key and sends real requests. Record results in runtime/VERIFICATION.md.
//   OPEN_HARNESS_LIVE_EVAL=1 TYPESAFE_API_KEY=... npm run decide:eval
// Optional: TYPESAFE_ORIGIN (default https://api.typesafe.ai), TYPESAFE_MODEL (default jev-latest).
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretStore } from '../runtime/secrets';
import { Credentials } from '../runtime/credentials';
import { CredentialOAuth } from '../runtime/credential-oauth';
import { Decisions } from '../runtime/decisions';

const key = process.env.TYPESAFE_API_KEY || '';
if (process.env.OPEN_HARNESS_LIVE_EVAL !== '1' || !key) {
  console.error('This sends real requests to the decision service. Set OPEN_HARNESS_LIVE_EVAL=1 and TYPESAFE_API_KEY to run it.');
  process.exit(2);
}
type Result = { result: unknown; decided: boolean; confidence: unknown; ms: number; model: string };
type Case = { name: string; input: Record<string, unknown>; expect: (decision: Result) => boolean; want: string };
const teams = [{ id: 'billing', text: 'Payments, invoices, refunds and subscription charges' }, { id: 'technical', text: 'Bugs, outages, errors and integration problems' }, { id: 'sales', text: 'Pricing questions, plans and new accounts' }];
const first = (id: string) => (decision: Result) => Array.isArray(decision.result) && decision.result[0] === id;
const cases: Case[] = [
  { name: 'route a billing message', want: 'billing', expect: first('billing'), input: { op: 'choose', question: 'Which team should handle this customer message?', context: 'I was charged twice for my subscription this month and want the extra charge back.', options: teams } },
  { name: 'route an outage report', want: 'technical', expect: first('technical'), input: { op: 'choose', question: 'Which team should handle this customer message?', context: "Since this morning's deploy every call to /v1/orders returns HTTP 500.", options: teams } },
  { name: 'route a task to a teammate', want: 'scout', expect: first('scout'), input: { op: 'choose', question: 'Which teammate should take this task?', context: 'Summarise three recent papers on protein folding and list their methods.', options: [{ id: 'atlas', text: 'Atlas: Generalist. Coordinates work and writes plans.' }, { id: 'scout', text: 'Scout: Research librarian. Finds and summarises papers and sources.' }, { id: 'quill', text: 'Quill: Release writer. Writes changelogs and announcements.' }] } },
  { name: 'rank passages', want: 'rotate first', expect: first('rotate'), input: { op: 'rank', question: 'Does this passage explain how to rotate an API key?', options: [{ id: 'holidays', text: 'Our office is closed on public holidays.' }, { id: 'storage', text: 'API keys are shown once when created; store them in a password manager.' }, { id: 'rotate', text: 'To rotate a key, create a new key, update your clients, then revoke the old key.' }] } },
  { name: 'classify search results', want: 'r1 relevant, r2 irrelevant', expect: decision => JSON.stringify(decision.result) === JSON.stringify({ r1: 'relevant', r2: 'irrelevant' }), input: { op: 'classify', question: 'Is this search result relevant to restoring a database from a backup?', labels: ['relevant', 'irrelevant'], options: [{ id: 'r1', text: 'Restore a PostgreSQL database from a pg_dump file with pg_restore.' }, { id: 'r2', text: 'How to bake sourdough bread at home.' }] } },
  { name: 'score bug reports', want: 'detailed above vague', expect: decision => { const scores = decision.result as Record<string, number>; return scores.detailed > scores.vague; }, input: { op: 'score', question: 'How complete is this bug report?', options: [{ id: 'detailed', text: 'Steps: open Settings, click Save with an empty name. Expected: an error message. Actual: the page crashes with a TypeError in profile.ts line 40. Version 0.4.0 on Linux.' }, { id: 'vague', text: "It doesn't work." }] } },
  { name: 'check a refund request', want: 'true', expect: decision => decision.result === true, input: { op: 'check', question: 'Does this message ask for a refund?', context: 'Please refund my last payment; I cancelled before the renewal date.' } },
  { name: 'check a thank-you note', want: 'false', expect: decision => decision.result === false, input: { op: 'check', question: 'Does this message ask for a refund?', context: 'Thanks, the new dashboard looks great.' } },
];

process.env.OPEN_HARNESS_DISABLE_OS_VAULT = '1';
const directory = mkdtempSync(join(tmpdir(), 'decide-eval-'));
let failures = 0;
try {
  const db = new DatabaseSync(':memory:'), secrets = new SecretStore(join(directory, 'secrets.json')), credentials = new Credentials(db, secrets);
  credentials.create({ label: 'Decision service', ref: 'TYPESAFE_API_KEY', type: 'bearer', fields: { token: key } });
  const decisions = new Decisions(db, credentials, new CredentialOAuth(credentials), { secretValues: () => [key] });
  decisions.saveSettings({ enabled: true, credentialRef: 'TYPESAFE_API_KEY', origin: process.env.TYPESAFE_ORIGIN || 'https://api.typesafe.ai', model: process.env.TYPESAFE_MODEL || 'jev-latest', dailyLimit: 1000 }, 0);
  const run = async (input: Record<string, unknown>) => await decisions.decide({ kind: 'operator' }, input) as unknown as Result;
  let passed = 0, flips = 0, ordered = 0;
  const models = new Set<string>();
  for (const item of cases) {
    try {
      const decision = await run(item.input), ok = item.expect(decision); models.add(decision.model);
      if (ok) passed++;
      let bias = '';
      // Reversed order: a different first pick means the answer leaned on option position.
      if (item.input.op === 'choose') {
        ordered++;
        const reversed = await run({ ...item.input, options: [...(item.input.options as unknown[])].reverse() });
        if (JSON.stringify(reversed.result) !== JSON.stringify(decision.result)) { flips++; bias = ` reversed order picked ${JSON.stringify(reversed.result)}`; }
      }
      console.log(`${ok ? 'PASS' : 'MISS'}  ${item.name}: wanted ${item.want}, got ${JSON.stringify(decision.result)} (decided ${decision.decided}, confidence ${JSON.stringify(decision.confidence)}, ${decision.ms} ms)${bias}`);
    } catch (error) { failures++; console.log(`FAIL  ${item.name}: ${error instanceof Error ? error.message : error}`); }
  }
  console.log(`\n${passed}/${cases.length} as expected; ${failures} errors; position flips ${flips}/${ordered}; model ${[...models].join(', ') || 'none'}; ${decisions.usedToday()} requests sent.`);
} finally { rmSync(directory, { recursive: true, force: true }); }
process.exit(failures ? 1 : 0);
