// Structured decisions from a System One decision model (TypeSafe's Jev). A decision is advisory:
// this module answers a question and records that it did, and never starts work, changes cards,
// answers approvals or touches files. eslint.config.mjs enforces that through its imports.
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { CredentialError, type Credentials } from './credentials';
import type { CredentialOAuth } from './credential-oauth';
import { credentialApi } from './credential-api';
import { credentialHttp, redactCredential, type CredentialTransport } from './credential-http';
import { CREDENTIAL_REF } from '../lib/credentials';

export class DecisionError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
export type DecisionSettings = { enabled: boolean; credentialRef: string; origin: string; model: string; dailyLimit: number };
export type DecisionCaller = { kind: 'operator' } | { kind: 'agent'; agentId: string; runId: string };
export type Question = { type: 'choice'; instructions: string; criteria: Record<string, string> } | { type: 'score'; instructions: string; criteria: string[] } | { type: 'noul'; instructions: string };
type Answer = { choice?: unknown; noul?: unknown; score?: unknown; probabilities?: unknown; confidence?: unknown };
type Ask = { state: unknown; questions: Record<string, Question> };
export type Backend = (request: { model: string } & Ask) => Promise<{ model: string; answers: Record<string, Answer>; inputTokens: number }>;
type Op = 'choose' | 'rank' | 'classify' | 'score' | 'check';
type Input = { op: Op; question: string; context: string; options: Array<{ id: string; text: string }>; k: number; labels: string[]; levels: string[]; minConfidence: number; debias: boolean };

export const DECISION_DEFAULTS: DecisionSettings = { enabled: false, credentialRef: '', origin: 'https://api.typesafe.ai', model: 'jev-latest', dailyLimit: 2000 };
export const DECISION_DISCLOSURE = 'When decisions are on, the question, context and option text of every decision are sent to the decision service at the saved address, using the saved key. Text matching a saved secret is replaced before sending. Open Harness keeps only the operation, sizes, timing and chosen IDs, never the text.';
export const RUN_DECISION_LIMIT = 30;
const OPS: Op[] = ['choose', 'rank', 'classify', 'score', 'check'];
const FIELDS = new Set(['op', 'question', 'context', 'options', 'k', 'labels', 'levels', 'minConfidence', 'debias']);
// An all-digit ID would fall under JavaScript's integer-key ordering, which silently undoes the
// reversed second pass that offsets the model's lean toward the first option. Agent and stage IDs
// (up to 80 characters, UUIDs) otherwise fit as they are.
const ID = /^(?!\d+$)[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;
const CAP = { question: 1000, context: 8000, option: 1000, options: 255, level: 200, bytes: 1_000_000 };
const DEFAULT_LEVELS = ['Does not meet it at all', 'Barely meets it', 'Partly meets it', 'Mostly meets it', 'Fully meets it'];
// Shorter values (a username, a short label) would blank ordinary words out of every decision.
const MIN_SECRET = 8;
const CONCURRENCY = 8;
const KEY_TYPES = ['bearer', 'model-api-key'];

const unit = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
const text = (value: unknown, field: string, max: number, required = false) => {
  if (value === undefined || value === null || value === '') { if (required) throw new DecisionError(`${field} is required.`); return ''; }
  if (typeof value !== 'string') throw new DecisionError(`${field} must be text.`);
  if (value.length > max) throw new DecisionError(`${field} is limited to ${max} characters; this one has ${value.length}.`);
  return value;
};
const ids = (values: unknown, field: string, min: number, max: number) => {
  if (!Array.isArray(values) || values.length < min || values.length > max) throw new DecisionError(`Send ${min} to ${max} ${field}.`);
  const out = values.map(value => { if (typeof value !== 'string' || !ID.test(value)) throw new DecisionError(`Each of ${field} must be 1 to 80 letters, digits or _ . : -, start with a letter or digit, and not be only digits.`); return value; });
  if (new Set(out).size !== out.length) throw new DecisionError(`${field} must be unique.`);
  return out;
};
const byScore = (scores: Record<string, number>) => Object.keys(scores).sort((a, b) => scores[b] - scores[a] || (a < b ? -1 : a > b ? 1 : 0));

export function parseDecision(raw: unknown): Input {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DecisionError('Send the decision as a JSON object.');
  const value = raw as Record<string, unknown>, unknown = Object.keys(value).filter(key => !FIELDS.has(key));
  if (unknown.length) throw new DecisionError(`Unknown field${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}.`);
  const op = value.op as Op; if (!OPS.includes(op)) throw new DecisionError(`op must be one of ${OPS.join(', ')}.`);
  const question = text(value.question, 'question', CAP.question, true), context = text(value.context, 'context', CAP.context, op === 'check');
  let options: Input['options'] = [];
  if (op !== 'check') {
    if (!Array.isArray(value.options)) throw new DecisionError('options is required: a list of { id, text }.');
    const min = op === 'choose' || op === 'rank' ? 2 : 1;
    const list = ids(value.options.map(option => option && typeof option === 'object' ? (option as Record<string, unknown>).id : undefined), 'option IDs', min, CAP.options);
    options = list.map((id, index) => ({ id, text: text((value.options as Array<Record<string, unknown>>)[index].text, `Option ${id} text`, CAP.option, true) }));
  } else if (value.options !== undefined) throw new DecisionError('check takes no options; put what is being checked in context.');
  const k = value.k === undefined ? 1 : Number(value.k);
  if (!Number.isInteger(k) || k < 1 || (op === 'choose' && k > options.length)) throw new DecisionError('k must be a whole number from 1 to the number of options.');
  const labels = op === 'classify' ? ids(value.labels, 'labels', 2, CAP.options) : [];
  if (op !== 'classify' && value.labels !== undefined) throw new DecisionError('labels is only used by classify.');
  const levels = op === 'score' && value.levels !== undefined ? (() => {
    if (!Array.isArray(value.levels) || value.levels.length < 2 || value.levels.length > 10) throw new DecisionError('levels needs 2 to 10 entries, lowest first.');
    return value.levels.map((level, index) => text(level, `Level ${index + 1}`, CAP.level, true));
  })() : DEFAULT_LEVELS;
  if (op !== 'score' && value.levels !== undefined) throw new DecisionError('levels is only used by score.');
  const minConfidence = value.minConfidence === undefined ? 0.6 : value.minConfidence;
  if (!unit(minConfidence)) throw new DecisionError('minConfidence must be a number from 0 to 1.');
  if (value.debias !== undefined && typeof value.debias !== 'boolean') throw new DecisionError('debias must be true or false.');
  if (value.debias && op !== 'choose') throw new DecisionError('debias is only used by choose.');
  return { op, question, context, options, k, labels, levels, minConfidence, debias: value.debias === true };
}

// Fixed shapes: the caller's question is only ever an instruction, and option text only ever data
// (criteria or state), so text planted in an option is never presented as the question.
export function planDecision(input: Input): Ask[] {
  const item = (option: { text: string }) => input.context ? { context: input.context, item: option.text } : option.text;
  switch (input.op) {
    case 'choose': {
      const criteria = Object.fromEntries(input.options.map(option => [option.id, option.text]));
      const ask = (order: Record<string, string>): Ask => ({ state: input.context || input.question, questions: { pick: { type: 'choice', instructions: input.question, criteria: order } } });
      return input.debias ? [ask(criteria), ask(Object.fromEntries(Object.entries(criteria).reverse()))] : [ask(criteria)];
    }
    case 'rank': return input.options.map(option => ({ state: item(option), questions: { fits: { type: 'noul', instructions: input.question } } }));
    case 'classify': return input.options.map(option => ({ state: item(option), questions: { label: { type: 'choice', instructions: input.question, criteria: Object.fromEntries(input.labels.map(label => [label, label])) } } }));
    case 'score': return input.options.map(option => ({ state: item(option), questions: { level: { type: 'score', instructions: input.question, criteria: input.levels } } }));
    case 'check': return [{ state: input.context, questions: { yes: { type: 'noul', instructions: input.question } } }];
  }
}

const malformed = () => new DecisionError('The decision service returned an answer outside the question it was asked, so nothing was decided.', 424);
function checkAnswer(question: Question, answer: Answer | undefined) {
  if (!answer || typeof answer !== 'object') throw malformed();
  if (question.type === 'noul') { if (!unit(answer.noul)) throw malformed(); return answer; }
  if (!unit(answer.confidence)) throw malformed();
  if (question.type === 'score') { if (typeof answer.score !== 'number' || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > 10) throw malformed(); return answer; }
  const probabilities = answer.probabilities as Record<string, unknown> | undefined;
  if (typeof answer.choice !== 'string' || !Object.hasOwn(question.criteria, answer.choice) || !probabilities || typeof probabilities !== 'object' || !Object.entries(probabilities).every(([key, value]) => Object.hasOwn(question.criteria, key) && unit(value))) throw malformed();
  return answer;
}

export function combineDecision(input: Input, asks: Ask[], answers: Array<Record<string, Answer>>) {
  const each = <T>(key: string, read: (answer: Answer) => T) => Object.fromEntries(input.options.map((option, index) => [option.id, read(checkAnswer(asks[index].questions[key], answers[index][key]))]));
  switch (input.op) {
    case 'choose': {
      const checked = answers.map((answer, index) => checkAnswer(asks[index].questions.pick, answer.pick));
      const probabilities = Object.fromEntries(input.options.map(option => [option.id, checked.reduce((sum, answer) => sum + Number((answer.probabilities as Record<string, number>)[option.id] || 0), 0) / checked.length]));
      const confidence = checked.reduce((sum, answer) => sum + (answer.confidence as number), 0) / checked.length;
      return { decided: confidence >= input.minConfidence, result: byScore(probabilities).slice(0, input.k), probabilities, confidence };
    }
    case 'rank': { const probabilities = each('fits', answer => answer.noul as number); return { decided: true, result: byScore(probabilities), probabilities, confidence: null }; }
    case 'classify': case 'score': {
      const key = input.op === 'classify' ? 'label' : 'level';
      const result = each(key, answer => input.op === 'classify' ? answer.choice as string : answer.score as number), confidence = each(key, answer => answer.confidence as number);
      const undecided = input.options.map(option => option.id).filter(id => confidence[id] < input.minConfidence);
      return { decided: !undecided.length, result, ...(input.op === 'classify' ? { probabilities: each(key, answer => answer.probabilities as Record<string, number>) } : {}), confidence, undecided };
    }
    case 'check': {
      const yes = checkAnswer(asks[0].questions.yes, answers[0].yes).noul as number, confidence = Math.max(yes, 1 - yes);
      return { decided: confidence >= input.minConfidence, result: yes >= 0.5, probabilities: { yes }, confidence };
    }
  }
}

// Mock mode contacts nothing. Word overlap stands in for judgment, so tests can tell which option
// should win, and every answer has the documented shape.
const words = (value: unknown) => new Set((typeof value === 'string' ? value : JSON.stringify(value)).toLowerCase().match(/[a-z0-9]{3,}/g) || []);
const overlap = (a: Set<string>, b: Set<string>) => { let n = 0; for (const word of b) if (a.has(word)) n++; return n / (b.size + 1); };
export const mockBackend: Backend = async ({ model, state, questions }) => {
  const answers: Record<string, Answer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const asked = new Set([...words(state), ...words(question.instructions)]);
    if (question.type === 'choice') {
      const raw = Object.fromEntries(Object.entries(question.criteria).map(([key, value]) => [key, overlap(asked, words(`${key} ${value}`)) + 0.01]));
      const total = Object.values(raw).reduce((a, b) => a + b, 0), probabilities = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, value / total]));
      const choice = byScore(probabilities)[0];
      answers[id] = { choice, probabilities, confidence: probabilities[choice] };
    } else if (question.type === 'noul') answers[id] = { noul: Math.min(1, overlap(words(state), words(question.instructions)) * 2) };
    else { const level = Math.round(Math.min(1, overlap(words(state), words(question.instructions)) * 2) * (question.criteria.length - 1)); answers[id] = { score: level / (question.criteria.length - 1) * 10, confidence: 0.8 }; }
  }
  return { model: `${model} (mock)`, answers, inputTokens: 0 };
};

async function pool<T, R>(items: T[], work: (item: T) => Promise<R>) {
  const out: R[] = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => { while (next < items.length) { const index = next++; out[index] = await work(items[index]); } }));
  return out;
}

export class Decisions {
  constructor(readonly db: DatabaseSync, private credentials: Credentials, private oauth: CredentialOAuth, private options: { secretValues: () => string[]; mock?: boolean; transport?: CredentialTransport; retryDelayMs?: number; now?: () => Date }) {
    db.exec(`CREATE TABLE IF NOT EXISTS decision_settings(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS decisions(id TEXT PRIMARY KEY, created_at TEXT NOT NULL, caller TEXT NOT NULL, agent_id TEXT, run_id TEXT, op TEXT NOT NULL, options INTEGER NOT NULL, requests INTEGER NOT NULL, bytes INTEGER NOT NULL, redacted INTEGER NOT NULL, model TEXT, ms INTEGER, input_tokens INTEGER, outcome TEXT NOT NULL, result_json TEXT);
      CREATE INDEX IF NOT EXISTS decisions_created ON decisions(created_at);
      CREATE INDEX IF NOT EXISTS decisions_run ON decisions(run_id);`);
  }
  private now() { return this.options.now?.() || new Date(); }
  settings(): { settings: DecisionSettings; revision: number } {
    const row = this.db.prepare('SELECT revision,json FROM decision_settings WHERE id=1').get() as { revision: number; json: string } | undefined;
    return row ? { settings: { ...DECISION_DEFAULTS, ...JSON.parse(row.json) }, revision: row.revision } : { settings: DECISION_DEFAULTS, revision: 0 };
  }
  usedToday() { return Number((this.db.prepare('SELECT COALESCE(SUM(requests),0) AS n FROM decisions WHERE created_at>=?').get(this.now().toISOString().slice(0, 10)) as { n: number }).n); }
  status() { const { settings, revision } = this.settings(); return { settings, revision, usedToday: this.usedToday(), sends: DECISION_DISCLOSURE }; }
  saveSettings(raw: unknown, revision: number) {
    const current = this.settings().revision;
    if (revision !== current) throw new DecisionError(`Decision settings changed elsewhere (now revision ${current}). Reload them before saving; your changes are still here.`, 409);
    const value = { ...this.settings().settings, ...(raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}) };
    if (typeof value.enabled !== 'boolean') throw new DecisionError('enabled must be true or false.');
    const credentialRef = String(value.credentialRef || '');
    if (credentialRef && !CREDENTIAL_REF.test(credentialRef)) throw new DecisionError('Choose a saved credential.');
    let origin: URL; try { origin = new URL(String(value.origin)); } catch { throw new DecisionError('Enter the decision service address, such as https://api.typesafe.ai.'); }
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new DecisionError('The decision service address must be an https:// origin with no path, query or credentials.');
    const model = String(value.model || '');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(model)) throw new DecisionError('Enter a model name, such as jev-latest.');
    const dailyLimit = Number(value.dailyLimit);
    if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 100_000) throw new DecisionError('The daily limit must be a whole number from 1 to 100000.');
    if (value.enabled) this.usableCredential(credentialRef);
    const settings: DecisionSettings = { enabled: value.enabled, credentialRef, origin: origin.origin, model, dailyLimit };
    this.db.prepare('INSERT INTO decision_settings VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,json=excluded.json').run(revision + 1, JSON.stringify(settings));
    return this.status();
  }
  private usableCredential(ref: string) {
    if (!ref) throw new DecisionError('Choose the saved credential that holds the decision service key.');
    if (!this.credentials.has(ref)) throw new DecisionError('The decision service credential no longer exists. Choose another in decision settings.', 409);
    if (!KEY_TYPES.includes(this.credentials.row(ref).type)) throw new DecisionError('The decision service key must be saved as a Bearer token or Model API key credential.');
    if (!this.credentials.present(ref)) throw new DecisionError('The decision service credential has no saved key. Add it under Credentials.', 409);
  }
  list(limit = 50) {
    return (this.db.prepare('SELECT * FROM decisions ORDER BY created_at DESC LIMIT ?').all(Math.max(1, Math.min(200, limit))) as Array<Record<string, unknown>>)
      .map(row => ({ id: row.id, createdAt: row.created_at, caller: row.caller, agentId: row.agent_id, runId: row.run_id, op: row.op, options: row.options, requests: row.requests, bytes: row.bytes, redacted: Boolean(row.redacted), model: row.model, ms: row.ms, inputTokens: row.input_tokens, outcome: row.outcome, result: row.result_json ? JSON.parse(String(row.result_json)) : null }));
  }

  async decide(caller: DecisionCaller, raw: unknown) {
    const { settings } = this.settings();
    if (!settings.enabled) throw new DecisionError('Decisions are not turned on for this workspace. A person can turn them on in decision settings.', 403);
    this.usableCredential(settings.credentialRef);
    const input = parseDecision(raw), asks = planDecision(input);
    const secrets = Object.fromEntries(this.options.secretValues().filter(value => value && value.length >= MIN_SECRET).map((value, index) => [`s${index}`, value]));
    const bodies = asks.map(ask => { const plain = JSON.stringify({ model: settings.model, ...ask }); return { plain, sent: redactCredential(plain, secrets) }; });
    const bytes = bodies.reduce((sum, body) => sum + Buffer.byteLength(body.sent), 0), redacted = bodies.some(body => body.sent !== body.plain);
    if (bytes > CAP.bytes) throw new DecisionError('This decision would send more than 1 MB. Shorten the context or send fewer options.');
    if (caller.kind === 'agent' && Number((this.db.prepare('SELECT COUNT(*) AS n FROM decisions WHERE run_id=?').get(caller.runId) as { n: number }).n) >= RUN_DECISION_LIMIT) throw new DecisionError(`This run has used its ${RUN_DECISION_LIMIT} decisions.`, 429);
    if (this.usedToday() + asks.length > settings.dailyLimit) throw new DecisionError(`This would pass the workspace's daily limit of ${settings.dailyLimit} decision requests. A person can raise it in decision settings.`, 429);
    // Recorded before sending so concurrent decisions count against the same limits.
    const id = `dec_${randomUUID()}`, started = Date.now();
    this.db.prepare("INSERT INTO decisions(id,created_at,caller,agent_id,run_id,op,options,requests,bytes,redacted,outcome) VALUES(?,?,?,?,?,?,?,?,?,?,'pending')")
      .run(id, this.now().toISOString(), caller.kind, caller.kind === 'agent' ? caller.agentId : null, caller.kind === 'agent' ? caller.runId : null, input.op, input.options.length, asks.length, bytes, redacted ? 1 : 0);
    const finish = (outcome: string, model: string | null, tokens: number | null, result: unknown) => this.db.prepare('UPDATE decisions SET outcome=?,model=?,ms=?,input_tokens=?,result_json=? WHERE id=?').run(outcome, model, Date.now() - started, tokens, result === undefined ? null : JSON.stringify(result), id);
    try {
      const replies = await pool(bodies, body => this.send(settings, body.sent));
      const combined = combineDecision(input, asks, replies.map(reply => reply.answers));
      const model = replies[0].model, tokens = replies.reduce((sum, reply) => sum + reply.inputTokens, 0);
      finish(combined.decided ? 'decided' : 'undecided', model, tokens, combined.result);
      return { decisionId: id, op: input.op, ...combined, model, ms: Date.now() - started, redacted };
    } catch (error) { finish('failed', null, null, undefined); throw error; }
  }

  private async send(settings: DecisionSettings, body: string): Promise<Awaited<ReturnType<Backend>>> {
    if (this.options.mock) return mockBackend(JSON.parse(body));
    // One origin, POST only, never a private address: the same grant shape and transport as the
    // agent API tool, so the destination check, DNS pinning, size caps and key redaction are shared.
    const grant = { credentialRef: settings.credentialRef, allowedOrigins: [settings.origin], allowedMethods: ['POST'] };
    for (let attempt = 0; ; attempt++) {
      let response: { status: number; body: string };
      try { response = await credentialApi(this.credentials, this.oauth, grant, { credentialRef: settings.credentialRef, url: `${settings.origin}/v1/systemone`, method: 'POST', body }, this.options.transport || credentialHttp); }
      catch (error) { throw new DecisionError(error instanceof Error ? error.message : 'Could not reach the decision service.', error instanceof CredentialError && error.status < 500 ? error.status : 424); }
      if ([429, 529].includes(response.status) && attempt < 2) { await new Promise(resolve => setTimeout(resolve, (this.options.retryDelayMs ?? 250) * 4 ** attempt)); continue; }
      let value: Record<string, unknown> = {}; try { value = JSON.parse(response.body); } catch { /* Errors need not be JSON. */ }
      const detail = String((value.error as { message?: string })?.message || value.error || value.detail || value.message || '').slice(0, 300);
      if (response.status === 401 || response.status === 403) throw new DecisionError('The decision service rejected the saved key. Update it under Credentials.', 424);
      if (response.status === 422) throw new DecisionError(`The decision service refused the request${detail ? `: ${detail}` : '.'}`, 422);
      if ([429, 529].includes(response.status)) throw new DecisionError('The decision service is busy. Try again shortly.', 429);
      if (response.status < 200 || response.status >= 300) throw new DecisionError(`The decision service returned HTTP ${response.status}${detail ? `: ${detail}` : '.'}`, 424);
      if (!value.answers || typeof value.answers !== 'object') throw malformed();
      return { model: String(value.model || settings.model), answers: value.answers as Record<string, Answer>, inputTokens: Number((value.usage as { input_tokens?: number })?.input_tokens || 0) };
    }
  }
}
