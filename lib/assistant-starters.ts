import type { AppId } from './product';

export type StarterId = 'prepare-day' | 'material-brief' | 'research-draft';
export type StarterDefinition = { id: StarterId; title: string; description: string; apps: AppId[]; fields: Array<{ id: string; label: string; placeholder: string; required: boolean }>; checks: string[] };
export type StarterInput = { starterId: StarterId; connectionIds: string[]; inputs: Record<string, string>; requestId: string };

export const assistantStarters: StarterDefinition[] = [
  { id: 'prepare-day', title: 'Prepare my day', description: 'Bring meetings and important email into a short brief, with follow-up drafts ready to review. Select Gmail and Calendar accounts.', apps: ['gmail', 'calendar'], fields: [
    { id: 'window', label: 'Day or time window', placeholder: 'Tomorrow, in America/Denver', required: true },
    { id: 'inboxQuery', label: 'Email to include', placeholder: 'in:inbox newer_than:7d', required: true },
  ], checks: ['Meetings and selected email are accounted for with source links', 'Conflicts, next steps, and decisions are separated from background information', 'Reply drafts preserve recipients and facts; no messages are sent'] },
  { id: 'material-brief', title: 'Turn saved material into a brief', description: 'Make a useful draft from links, notes, or files you already collected. A Drive account is optional.', apps: ['drive'], fields: [
    { id: 'material', label: 'Links, notes, or file references', placeholder: 'Paste your material or identify the files to read', required: true },
    { id: 'deliverable', label: 'What should be created?', placeholder: 'A one-page creative brief with themes and source links', required: true },
  ], checks: ['The brief uses the supplied material and identifies inaccessible sources', 'Claims and creative choices can be traced to their sources', 'The finished draft is saved and read back before reporting completion'] },
  { id: 'research-draft', title: 'Research and draft with my team', description: 'Gather sourced research and turn it into a draft. Optionally select teammates for research and writing.', apps: [], fields: [
    { id: 'topic', label: 'Research topic', placeholder: 'What should we investigate, and for whom?', required: true },
    { id: 'deliverable', label: 'Draft to create', placeholder: 'A short proposal with evidence and open questions', required: true },
    { id: 'researcherId', label: 'Research teammate', placeholder: 'Optional teammate', required: false },
    { id: 'writerId', label: 'Writing teammate', placeholder: 'Optional teammate', required: false },
  ], checks: ['Research claims link to inspected sources and distinguish inference', 'Selected teammates return bounded results to the primary assistant', 'The primary assistant checks the draft and its sources; nothing is sent or published'] },
];
