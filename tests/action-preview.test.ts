import test from 'node:test';
import assert from 'node:assert/strict';
import { previewAction } from '../lib/action-preview';

const preview = (operation: string, request: Record<string, unknown>) => previewAction({ operation, request, resource: 'destination', summary: 'Untrusted generated summary: costs $100' });
test('prepared previews retain exact content and derive meaning from the operation', () => {
  const body = '  Dear colleague,\n\nPlease review <this> & that.\n', draft = preview('gmail.create_draft', { to: ['a@example.com', 'b@example.com'], subject: 'Literal <subject>', body });
  assert.equal(draft.body, body); assert.equal(draft.fields.find(field => field.label === 'Subject')?.value, 'Literal <subject>'); assert.match(draft.fields[0].value, /b@example.com/); assert.match(draft.consequence, /not be sent/); assert.doesNotMatch(JSON.stringify(draft), /\$100/);
  const calendar = preview('calendar.create', { calendarId: 'work', title: 'Meet', description: body, start: '2026-11-10T08:00:00-07:00', end: '2026-11-10T09:00:00-07:00' }); assert.equal(calendar.body, body); assert.equal(calendar.fields.find(field => field.label === 'Starts')?.value, '2026-11-10T08:00:00-07:00');
  assert.equal(preview('drive.create_document', { title: 'Plan', content: body }).body, body);
  assert.equal(preview('github.comment', { repo: 'org/repo', issueNumber: 5, body }).body, body);
});
test('sheet and draft PR previews retain exact changes and source evidence without invented costs', () => {
  const values = [['001', false, null, 12.4]], sheet = preview('sheets.update', { spreadsheetId: 'sheet', range: "'My sheet'!A1:D1", values, beforeHash: 'private-check' });
  assert.deepEqual(JSON.parse(sheet.fields.find(field => field.label === 'New values')!.value), values); assert.equal(sheet.fields.find(field => field.label === 'Cells')!.value, "'My sheet'!A1:D1"); assert.doesNotMatch(JSON.stringify(sheet), /private-check/);
  const files = [{ path: 'src/file.ts', content: '  export const n = 1;\n' }], pr = preview('github.create_pull_request', { repo: 'org/repo', title: 'Fix', body: 'Description\n', files, baseBranch: 'main', baseSha: 'a'.repeat(40), testEvidence: 'npm test\nexit 0' });
  assert.deepEqual(JSON.parse(pr.fields.find(field => field.label === 'Changed files')!.value), files); assert.equal(pr.fields.find(field => field.label === 'Recorded test evidence')!.value, 'npm test\nexit 0'); assert.match(pr.consequence, /does not merge/);
});
test('Gmail send previews only show stored draft text and acknowledge missing content', () => {
  const request = { to: 'a@example.com', subject: 'Ready', draftId: 'draft-id', draftHash: 'snapshot' }, absent = preview('gmail.send', request);
  assert.equal(absent.body, undefined); assert.match(absent.consequence, /inspect the draft/); assert.equal(preview('gmail.send', { ...request, body: 'Exact saved text\n' }).body, 'Exact saved text\n');
  assert.equal(absent.fields.some(field => ['Cc', 'Bcc', 'Attachments'].includes(field.label)), false);
  const complete = preview('gmail.send', { ...request, cc: 'Copy <copy@example.com>', bcc: 'private@example.com', attachments: ['actual-report.pdf'], body: 'Exact saved text\n' });
  assert.equal(complete.fields.find(field => field.label === 'Cc')!.value, 'Copy <copy@example.com>'); assert.equal(complete.fields.find(field => field.label === 'Bcc')!.value, 'private@example.com'); assert.deepEqual(JSON.parse(complete.fields.find(field => field.label === 'Attachments')!.value), ['actual-report.pdf']); assert.match(complete.consequence, /may omit rich content/);
});
test('every supported read operation has a read-only preview, and unknown operations retain full details', () => {
  for (const operation of ['gmail.list', 'gmail.get', 'gmail.drafts', 'gmail.draft', 'calendar.list', 'drive.list', 'drive.read', 'sheets.read', 'github.issues', 'github.issue', 'github.pull_requests']) assert.match(preview(operation, {}).consequence, /Reads/);
  const unknown = preview('future.transfer', { amount: 123, nested: { content: 'exact\n' } }); assert.equal(unknown.title, 'Review connected action'); assert.deepEqual(JSON.parse(unknown.body!), { amount: 123, nested: { content: 'exact\n' } }); assert.match(unknown.consequence, /no supported preview/);
});
