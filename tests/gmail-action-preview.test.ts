import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Store } from '../runtime/db';
import { Profiles } from '../runtime/profiles';
import { Workspaces } from '../runtime/workspaces';
import { Connections } from '../runtime/connections';
import { Actions } from '../runtime/actions';
import { previewAction } from '../lib/action-preview';

type Part = { mimeType: string; filename?: string; headers?: Array<{ name: string; value: string }>; body?: { data?: string; attachmentId?: string }; parts?: Part[] };
const plain = (body: string, charset = 'UTF-8'): Part => ({ mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: `text/plain; charset="${charset}"` }], body: { data: Buffer.from(body).toString('base64url') } });
const headers = () => [{ name: 'To', value: 'Target <target@example.com>' }, { name: 'Cc', value: 'Copy <copy@example.com>' }, { name: 'Bcc', value: 'private@example.com' }, { name: 'Subject', value: 'Actual draft subject' }, { name: 'Message-ID', value: '<actual-draft@example.com>' }];

async function fixture(payload: Part) {
  const store = new Store(':memory:'); new Profiles(store.db); const workspace = new Workspaces(store.db, '/gmail-preview');
  store.db.prepare('INSERT INTO agent_profiles VALUES(?,1,?)').run('atlas', '{}');
  const saved: Record<string, string> = { APP_GOOGLE_CLIENT_SECRET: 'fixture-secret' }, secrets = { set: (key: string, value: string) => { saved[key] = value; }, delete: (key: string) => { delete saved[key]; }, environment: () => ({ ...saved }) };
  let draft = { id: 'actual-draft', message: { id: 'actual-message', payload } }, sent = 0;
  const request = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const address = String(url); let value: unknown;
    if (address === 'https://oauth2.googleapis.com/token') value = { access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600, scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/gmail.send' };
    else if (address === 'https://www.googleapis.com/oauth2/v3/userinfo') value = { sub: 'google-identity', email: 'owner@example.com', email_verified: true };
    else if (address === 'https://gmail.googleapis.com/gmail/v1/users/me/drafts/actual-draft?format=full') { assert.equal(init.method || 'GET', 'GET'); value = draft; }
    else if (address === 'https://gmail.googleapis.com/gmail/v1/users/me/drafts/send') { assert.equal(init.method, 'POST'); assert.deepEqual(JSON.parse(String(init.body)), { id: 'actual-draft' }); sent++; value = { id: 'sent-message' }; }
    else if (address.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/messages?q=')) value = { messages: [{ id: 'sent-message' }] };
    else throw new Error(`Unexpected fixture endpoint: ${address}`);
    return new Response(JSON.stringify(value), { status: 200 });
  }) as typeof fetch;
  const connections = new Connections(store.db, secrets, () => workspace.actor(), request), actions = new Actions(store.db, connections, () => workspace.actor());
  const prior = process.env.OPEN_HARNESS_GOOGLE_CLIENT_ID; process.env.OPEN_HARNESS_GOOGLE_CLIENT_ID = 'fixture-client';
  let connection;
  try { const flow = connections.oauthStart('gmail', { access: 'write', sharedAgentIds: ['atlas'] }, 'http://localhost:4317/v1/connections/callback'); connection = await connections.oauthComplete(flow.state, 'fixture-code', flow.binding); }
  catch (error) { store.db.close(); throw error; }
  finally { if (prior === undefined) delete process.env.OPEN_HARNESS_GOOGLE_CLIENT_ID; else process.env.OPEN_HARNESS_GOOGLE_CLIENT_ID = prior; }
  return { store, connections, actions, connection, sent: () => sent, message: () => structuredClone(draft.message), replace: (next: Part) => { draft = { ...draft, message: { ...draft.message, payload: next } }; } };
}

test('Gmail send snapshot uses fetched MIME text, recipients and attachment names and ignores caller spoofing', async t => {
  const body = '  Exact draft text — café.\r\n\r\nSecond paragraph.\n', payload: Part = { mimeType: 'multipart/mixed', headers: headers(), parts: [{ mimeType: 'multipart/alternative', parts: [plain(body), { mimeType: 'text/html', body: { data: Buffer.from('<p>Different rich presentation</p>').toString('base64url') } }] }, { mimeType: 'application/pdf', filename: 'actual report.pdf', body: { attachmentId: 'attachment-id' } }, { ...plain('Attachment contents are not the message.'), filename: 'notes.txt' }] };
  const f = await fixture(payload); t.after(() => f.store.db.close());
  const action = await f.actions.prepare({ requestId: 'snapshot', connectionId: f.connection.id, operation: 'gmail.send', input: { draftId: 'actual-draft', to: 'spoof@example.com', cc: 'spoof-copy@example.com', bcc: 'spoof-private@example.com', subject: 'Spoofed subject', body: 'Spoofed text', attachments: ['spoofed.pdf'], draftHash: 'spoofed-hash', messageId: '<spoofed@example.com>' } });
  assert.equal(action.state, 'awaiting_approval'); assert.equal(action.request.body, body); assert.equal(action.request.to, 'Target <target@example.com>'); assert.equal(action.request.cc, 'Copy <copy@example.com>'); assert.equal(action.request.bcc, 'private@example.com'); assert.equal(action.request.subject, 'Actual draft subject'); assert.equal(action.request.messageId, '<actual-draft@example.com>'); assert.deepEqual(action.request.attachments, ['actual report.pdf', 'notes.txt']);
  assert.equal(action.request.draftHash, createHash('sha256').update(JSON.stringify(f.message())).digest('hex')); assert.doesNotMatch(JSON.stringify(action.request), /spoof|Attachment contents/); assert.equal(f.sent(), 0);
  const view = previewAction(action); assert.equal(view.body, body); assert.equal(view.fields.find(field => field.label === 'Bcc')!.value, 'private@example.com'); assert.match(view.consequence, /may omit rich content/);
});

test('unreadable MIME payloads omit body instead of inventing, partially decoding or replacing characters', async t => {
  const f = await fixture(plain('Initial')); t.after(() => f.store.db.close());
  const cases: Array<[string, Part]> = [
    ['HTML-only', { mimeType: 'text/html', body: { data: Buffer.from('<p>HTML only</p>').toString('base64url') } }],
    ['invalid characters', { ...plain('Unused'), body: { data: '!not-base64!' } }],
    ['invalid length', { ...plain('Unused'), body: { data: 'a' } }],
    ['embedded padding', { ...plain('Unused'), body: { data: 'YQ=Yg' } }],
    ['invalid UTF-8', { ...plain('Unused'), body: { data: Buffer.from([0xff, 0xfe, 0x41]).toString('base64url') } }],
    ['unsupported charset', plain('Text is available but its declared encoding is unsupported.', 'ISO-8859-1')],
    ['remote attachment body', { mimeType: 'text/plain', body: { attachmentId: 'body-attachment' } }],
  ];
  for (const [name, part] of cases) {
    f.replace({ ...part, headers: [...headers(), ...(part.headers || [])] }); const prepared = await f.connections.prepare(f.connection.id, 'gmail.send', { draftId: 'actual-draft', body: 'Do not use caller fallback' });
    assert.equal(Object.hasOwn(prepared.request, 'body'), false, name); assert.match(previewAction(prepared).consequence, /inspect the draft/, name);
  }
  assert.equal(f.sent(), 0);
});

test('Gmail send rejects changed draft text, copied recipients and attachments after approval without sending', async t => {
  const original: Part = { mimeType: 'multipart/mixed', headers: headers(), parts: [plain('Approved text'), { mimeType: 'application/pdf', filename: 'approved.pdf', body: { attachmentId: 'approved-attachment' } }] };
  const f = await fixture(original); t.after(() => f.store.db.close());
  for (const change of ['body', 'cc', 'bcc', 'attachment']) {
    f.replace(structuredClone(original)); const action = await f.actions.prepare({ requestId: `changed-${change}`, connectionId: f.connection.id, operation: 'gmail.send', input: { draftId: 'actual-draft' } }); f.actions.decide(action.id, { approved: true, confirmation: f.actions.review(action.id).confirmation });
    const changed = structuredClone(original);
    if (change === 'body') changed.parts![0] = plain('Changed after review');
    else if (change === 'attachment') changed.parts![1].body!.attachmentId = 'replaced-attachment';
    else changed.headers!.find(header => header.name.toLowerCase() === change)!.value = 'changed@example.com';
    f.replace(changed); const result = await f.actions.execute(action.id); assert.equal(result.state, 'uncertain', change); assert.match(result.evidence, /draft changed after approval/, change); assert.equal(f.sent(), 0, change);
  }
});

test('an unchanged approved Gmail snapshot sends once and readback confirms it', async t => {
  const f = await fixture({ ...plain('Approved content'), headers: headers() }); t.after(() => f.store.db.close());
  const action = await f.actions.prepare({ requestId: 'send-once', connectionId: f.connection.id, operation: 'gmail.send', input: { draftId: 'actual-draft' } }); await assert.rejects(f.actions.execute(action.id), /approval/); assert.equal(f.sent(), 0);
  f.actions.decide(action.id, { approved: true, confirmation: f.actions.review(action.id).confirmation }); assert.equal((await f.actions.execute(action.id)).state, 'completed'); assert.equal(f.sent(), 1); assert.equal((await f.actions.execute(action.id)).state, 'completed'); assert.equal(f.sent(), 1);
});
