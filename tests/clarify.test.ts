import test from 'node:test';
import assert from 'node:assert/strict';
import { clarifyQuestions, clarifyReply } from '../lib/clarify';

test('clarify questions read the batch Hermes emits and the older single question', () => {
  assert.deepEqual(clarifyQuestions({ request_id: 'r', questions: [{ qid: 'q0', question: 'Which?', choices: ['A', { label: 'B' }], multi_select: true }, { question: 'Why?' }] }), [
    { qid: 'q0', question: 'Which?', choices: ['A', 'B'], multiSelect: true },
    { qid: 'q1', question: 'Why?', choices: [], multiSelect: false },
  ]);
  assert.deepEqual(clarifyQuestions({ question: 'Which?', choices: ['A'] }), [{ qid: '', question: 'Which?', choices: ['A'], multiSelect: false }]);
  assert.equal(clarifyQuestions({ questions: [] })[0].qid, '');
});

test('clarify replies keep single answers bare and send batches as keyed JSON', () => {
  assert.equal(clarifyReply({ question: 'Which?' }, 'A'), 'A');
  assert.deepEqual(clarifyReply({ question: 'Which?' }, ['A', 'B']), ['A', 'B']);
  assert.equal(clarifyReply({ question: 'Which?' }, { answers: { q0: 'A' } }), null);
  const batch = { questions: [{ qid: 'q0', question: 'Which?' }, { qid: 'q1', question: 'Why?' }] };
  assert.equal(clarifyReply(batch, { answers: { q1: ['x'] } }), JSON.stringify({ answers: { q1: ['x'] } }));
  for (const value of ['A', { answers: {} }, { answers: { q2: 'A' } }, { answers: ['A'] }, null]) assert.equal(clarifyReply(batch, value), null);
  assert.equal(clarifyReply({ questions: [{ qid: 'q0', question: 'Which?' }] }, 'A'), JSON.stringify({ answers: { q0: 'A' } }));
});
