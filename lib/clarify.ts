// Pinned Hermes's clarify tool advertises only a batch: `{questions:[{qid,question,choices,multi_select}]}`
// with no top-level question. Older calls still arrive as one `{question,choices,multi_select}`, which
// keeps the qid "" so the reply stays a bare answer instead of a JSON batch.
export type ClarifyQuestion = { qid: string; question: string; choices: string[]; multiSelect: boolean };
export type ClarifyAnswers = Record<string, string | string[]>;
type Payload = Record<string, unknown> | null | undefined;

const text = (value: unknown) => typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
function choices(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(choice => typeof choice === 'string' ? choice : text((choice as Record<string, unknown>)?.label ?? (choice as Record<string, unknown>)?.value)).filter(Boolean);
}
export const isClarifyBatch = (payload: Payload) => Array.isArray(payload?.questions) && payload.questions.length > 0;
export function clarifyQuestions(payload: Payload): ClarifyQuestion[] {
  if (isClarifyBatch(payload)) return (payload!.questions as Record<string, unknown>[]).map((entry, index) => ({
    qid: text(entry?.qid) || `q${index}`, question: text(entry?.question ?? entry?.prompt), choices: choices(entry?.choices ?? entry?.options), multiSelect: Boolean(entry?.multi_select),
  }));
  return [{ qid: '', question: text(payload?.question ?? payload?.prompt ?? payload?.message), choices: choices(payload?.options ?? payload?.choices), multiSelect: Boolean(payload?.multiple ?? payload?.allow_multiple ?? payload?.multi_select) }];
}
const isAnswer = (value: unknown): value is string | string[] => typeof value === 'string' || (Array.isArray(value) && value.every(item => typeof item === 'string'));
// What clarify.respond should carry, or null when the reply does not fit the request. A batch must go
// back as one JSON string `{"answers":{qid:...}}`: Hermes's gateway only carries strings, and a plain
// string on a batch is taken as cancel-all, so the model would receive blank answers.
export function clarifyReply(payload: Payload, value: unknown): string | string[] | null {
  if (!isClarifyBatch(payload)) return isAnswer(value) ? value : null;
  const qids = clarifyQuestions(payload).map(question => question.qid);
  // A single-question batch still accepts a bare answer from older tabs and API callers.
  const answers = isAnswer(value) && qids.length === 1 ? { [qids[0]]: value } : (value as { answers?: unknown } | null)?.answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return null;
  const entries = Object.entries(answers);
  if (!entries.length || entries.some(([qid, answer]) => !qids.includes(qid) || !isAnswer(answer))) return null;
  return JSON.stringify({ answers: Object.fromEntries(entries) });
}
