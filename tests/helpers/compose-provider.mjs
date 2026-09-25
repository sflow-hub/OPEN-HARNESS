// Disposable OpenAI-compatible fixture for the Compose acceptance test. It drives
// real Hermes tool dispatch deterministically; it does not simulate model reasoning.
import { createServer } from 'node:http';

const requests = [];
const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(req.url === '/__fixture/requests' ? requests : { object: 'list', data: [{ id: 'compose-fixture', object: 'model', context_length: 131072 }] }));
      return;
    }
    let input = ''; for await (const part of req) { input += part; if (input.length > 4_000_000) throw new Error('Fixture request too large.'); }
    const body = JSON.parse(input); requests.push(body);
    const messages = body.messages || [];
    const lastUser = messages.findLastIndex(message => message.role === 'user');
    const prompt = String(messages[lastUser]?.content || '');
    const called = messages.slice(lastUser).flatMap(message => message.tool_calls || []).map(call => call.function?.name);
    const hasTools = body.tools?.some(tool => tool.function?.name === 'write_file');
    const main = hasTools && prompt.includes('COMPOSE_SMOKE');
    const shutdown = hasTools && prompt.includes('COMPOSE_SHUTDOWN');
    const followup = hasTools && prompt.includes('COMPOSE_FOLLOWUP');
    const context = hasTools && prompt.includes('RUNNER_CONTEXT');
    const tool = context && !called.includes('memory') ? { name: 'memory', arguments: { target: 'memory', action: 'add', content: 'The remote tool memory marker is RUNNER_TOOL_MEMORY_527.' } }
      : context && !called.includes('skill_view') ? { name: 'skill_view', arguments: { name: 'runner-verification' } }
      : shutdown ? { name: 'clarify', arguments: { question: 'Keep this run waiting until the stack shuts down.' } }
      : main && !called.includes('write_file') ? { name: 'write_file', arguments: { path: '/workspace/shared/compose-verified.txt', content: 'Written through the real Compose Hermes tool loop.\n' } }
      : main && !called.includes('clarify') ? { name: 'clarify', arguments: { question: 'Which acceptance marker should I use?' } }
      : main && !called.includes('mcp__open_harness__task') ? { name: 'mcp__open_harness__task', arguments: { action: 'list' } }
      : main && !called.includes('terminal') ? { name: 'terminal', arguments: { command: 'touch /workspace/shared/compose-forbidden.txt' } }
      : null;
    const content = context ? 'RUNNER_CONTEXT_COMPLETE' : followup ? (messages.some(message => String(message.content).includes('COMPOSE_SEED_729')) ? 'FOLLOWUP_COMPOSE_SEED_729' : 'FOLLOWUP_CONTEXT_MISSING') : main ? 'COMPOSE_SMOKE_COMPLETE' : 'Compose acceptance';
    const message = tool ? { role: 'assistant', content: null, tool_calls: [{ id: `compose-${tool.name}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] } : { role: 'assistant', content };
    const common = { id: `compose-${requests.length}`, created: Math.floor(Date.now() / 1000), model: 'compose-fixture' };
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const delta = tool ? { role: 'assistant', tool_calls: message.tool_calls.map(call => ({ index: 0, ...call })) } : { role: 'assistant', content };
      res.write(`data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...common, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }));
    }
  } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })); }
});
server.listen(Number(process.env.COMPOSE_FIXTURE_PORT || 3131), '0.0.0.0', () => console.log('Compose scripted provider ready.'));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
