import type { ActionIntent } from './product';

export type ActionPreview = { title: string; fields: Array<{ label: string; value: string }>; body?: string; consequence: string };
type PreviewAction = Pick<ActionIntent, 'operation' | 'resource' | 'summary' | 'request'>;
const display = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '';

export function previewAction(action: PreviewAction): ActionPreview {
  const a = action.request, fields: ActionPreview['fields'] = [];
  const field = (label: string, key: string) => { if (a[key] !== undefined) fields.push({ label, value: display(a[key]) }); };
  const result = (title: string, consequence: string, body?: unknown): ActionPreview => ({ title, fields, ...(typeof body === 'string' ? { body } : {}), consequence });
  switch (action.operation) {
    case 'gmail.list': field('Search', 'query'); field('Maximum messages', 'limit'); return result('Find Gmail messages', 'Reads matching messages. No email is sent or changed.');
    case 'gmail.get': field('Message', 'messageId'); return result('Read a Gmail message', 'Reads this message. No email is sent or changed.');
    case 'gmail.drafts': field('Maximum drafts', 'limit'); return result('List Gmail drafts', 'Reads saved drafts. No email is sent or changed.');
    case 'gmail.draft': field('Draft', 'draftId'); return result('Read a Gmail draft', 'Reads this draft. No email is sent or changed.');
    case 'gmail.create_draft': field('To', 'to'); field('Subject', 'subject'); return result('Create an email draft', 'Saves this email as a Gmail draft. It will not be sent.', a.body);
    case 'gmail.send': field('To', 'to'); field('Cc', 'cc'); field('Bcc', 'bcc'); field('Subject', 'subject'); field('Draft', 'draftId'); field('Attachments', 'attachments'); return result('Send an email', typeof a.body === 'string' ? 'Sends the reviewed Gmail draft to its recipients. This plain-text preview may omit rich content; inspect the full draft and attachments before approving.' : 'Sends the reviewed Gmail draft. The full message is not available in this preview; inspect the draft before approving.', a.body);
    case 'calendar.list': field('Calendar', 'calendarId'); field('Starting from', 'timeMin'); field('Maximum events', 'limit'); return result('Read calendar events', 'Reads events from this calendar. No events are changed.');
    case 'calendar.create': field('Calendar', 'calendarId'); field('Event', 'title'); field('Starts', 'start'); field('Ends', 'end'); return result('Create a calendar event', 'Adds this event to the selected calendar.', a.description);
    case 'drive.list': field('Search', 'query'); field('Maximum files', 'limit'); return result('Find Drive files', 'Reads matching file information. No files are changed.');
    case 'drive.read': field('File', 'fileId'); return result('Read a Drive file', 'Reads this file. No files are changed.');
    case 'drive.create_document': field('Document', 'title'); fields.push({ label: 'Folder', value: a.folderId === undefined ? 'My Drive' : display(a.folderId) }); return result('Create a Drive document', 'Creates a new document containing the reviewed text.', a.content);
    case 'sheets.read': field('Spreadsheet', 'spreadsheetId'); field('Cells', 'range'); return result('Read spreadsheet cells', 'Reads the selected cells. No values are changed.');
    case 'sheets.update': field('Spreadsheet', 'spreadsheetId'); field('Cells', 'range'); field('New values', 'values'); return result('Update spreadsheet cells', 'Writes these values into the selected cells after checking that their previous values have not changed.');
    case 'github.issues': field('Repository', 'repo'); return result('Read GitHub issues', 'Reads issue information. No repository content is changed.');
    case 'github.issue': field('Repository', 'repo'); field('Issue', 'issueNumber'); return result('Read a GitHub issue', 'Reads this issue. No repository content is changed.');
    case 'github.pull_requests': field('Repository', 'repo'); field('State', 'state'); return result('Read GitHub pull requests', 'Reads pull request information. No repository content is changed.');
    case 'github.comment': field('Repository', 'repo'); field('Issue', 'issueNumber'); return result('Post a GitHub comment', 'Posts this comment to the selected issue.', a.body);
    case 'github.create_pull_request': field('Repository', 'repo'); field('Title', 'title'); field('Base branch', 'baseBranch'); field('Base commit', 'baseSha'); field('Changed files', 'files'); field('Recorded test evidence', 'testEvidence'); return result('Create a draft pull request', 'Creates a branch with these file contents and a draft pull request. It does not merge the changes.', a.body);
    default: fields.push({ label: 'Operation', value: action.operation }, { label: 'Destination', value: action.resource }); return result('Review connected action', 'This operation has no supported preview. Review its complete request and effects before approving.', display(a));
  }
}
