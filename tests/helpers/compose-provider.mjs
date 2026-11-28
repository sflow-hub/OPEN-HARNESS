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
    const body = JSON.parse(input);
    const fixtureCredential = req.headers.authorization === 'Bearer local-scripted-provider-only' ? 'original' : req.headers.authorization === 'Bearer local-scripted-provider-rotated' ? 'rotated' : 'invalid';
    requests.push({ ...body, fixtureCredential });
    if (process.env.COMPOSE_REQUIRE_CREDENTIAL === '1' && fixtureCredential === 'invalid') { res.writeHead(401); res.end(JSON.stringify({ error: 'Fixture credential missing.' })); return; }
    const messages = body.messages || [];
    const lastUser = messages.findLastIndex(message => message.role === 'user');
    const prompt = String(messages[lastUser]?.content || '');
    const called = messages.slice(lastUser).flatMap(message => message.tool_calls || []).map(call => call.function?.name);
    const hasTools = body.tools?.some(tool => tool.function?.name === 'write_file');
    const main = hasTools && prompt.includes('COMPOSE_SMOKE');
    const soak = main && /(?:^|\s)COMPOSE_SOAK:([a-z0-9-]{1,80})(?:\s|$)/.exec(prompt)?.[1];
    const shutdown = hasTools && prompt.includes('COMPOSE_SHUTDOWN');
    const followup = hasTools && prompt.includes('COMPOSE_FOLLOWUP');
    const approval = body.tools?.some(tool => tool.function?.name === 'terminal') && prompt.includes('COMPOSE_APPROVAL');
    const apiTool = 'mcp__open_harness__api_request';
    const apiCalls = called.filter(name => name === apiTool).length;
    const apiChecks = main && !soak && body.tools?.some(tool => tool.function?.name === apiTool);
    const context = hasTools && prompt.includes('RUNNER_CONTEXT');
    // Writes one file at the path named in the prompt, to prove which host folders a run can reach.
    const folderWrite = hasTools && /(?:^|\s)COMPOSE_FOLDERS:(\/workspace\/\S+)/.exec(prompt)?.[1];
    const dashboardLabel = body.tools?.some(tool => tool.function?.name === 'patch') && prompt.includes('COMPOSE_LOCAL_DASHBOARD:') && /\b(LOCAL-DASHBOARD-[a-f0-9-]{36})\b/.exec(prompt)?.[1];
    const candidate = dashboardLabel && /\/workspace\/private\/improvement-[a-f0-9-]{36}-[a-f0-9-]{36}\b/.exec(prompt)?.[0];
    const headingFile = candidate && `${candidate}/components/assistant-workspace.tsx`;
    const oldHeading = '<h1>What would you like done?</h1>';
    const readHeading = messages.slice(lastUser + 1).some(message => message.role === 'tool' && JSON.stringify(message.content ?? '').includes(oldHeading));
    const tool = approval ? (called.includes('terminal') ? null : { name: 'terminal', arguments: { command: 'chmod 666 /workspace/shared/compose-verified.txt' } })
      : folderWrite ? (called.includes('write_file') ? null : { name: 'write_file', arguments: { path: folderWrite, content: 'COMPOSE_FOLDERS_729\n' } })
      : headingFile && !called.includes('read_file') ? { name: 'read_file', arguments: { path: headingFile, offset: 44, limit: 24 } }
      : headingFile && readHeading && !called.includes('patch') ? { name: 'patch', arguments: { path: headingFile, old_string: oldHeading, new_string: `<h1>${dashboardLabel}</h1>` } }
      : context && !called.includes('memory') ? { name: 'memory', arguments: { target: 'memory', action: 'add', content: 'The remote tool memory marker is RUNNER_TOOL_MEMORY_527.' } }
      : context && !called.includes('skill_view') ? { name: 'skill_view', arguments: { name: 'runner-verification' } }
      : shutdown ? { name: 'clarify', arguments: { question: 'Keep this run waiting until the stack shuts down.' } }
      : main && !called.includes('write_file') ? { name: 'write_file', arguments: { path: `/workspace/shared/${soak ? 'compose-soak.txt' : 'compose-verified.txt'}`, content: soak ? `COMPOSE_SOAK:${soak}\n` : 'Written through the real Compose Hermes tool loop.\n' } }
      : main && !called.includes('clarify') ? { name: 'clarify', arguments: { question: 'Which acceptance marker should I use?' } }
      : main && !called.includes('mcp__open_harness__task') ? { name: 'mcp__open_harness__task', arguments: { action: 'list' } }
      : apiChecks && apiCalls < 3 ? { name: apiTool, arguments: { credentialRef: apiCalls === 2 ? 'NOT_GRANTED' : 'COMPOSE_API_KEY', url: apiCalls === 0 ? 'https://other.example.test/account' : 'https://api.example.test/account', method: apiCalls === 1 ? 'DELETE' : 'GET' } }
      : main && !called.includes('terminal') ? { name: 'terminal', arguments: { command: 'touch /workspace/shared/compose-forbidden.txt' } }
      : null;
    const content = approval ? 'COMPOSE_APPROVAL_COMPLETE' : folderWrite ? 'COMPOSE_FOLDERS_COMPLETE' : context ? 'RUNNER_CONTEXT_COMPLETE' : followup ? (messages.some(message => String(message.content).includes('COMPOSE_SEED_729')) ? 'FOLLOWUP_COMPOSE_SEED_729' : 'FOLLOWUP_CONTEXT_MISSING') : main ? (soak ? `COMPOSE_SOAK_COMPLETE:${soak}` : 'COMPOSE_SMOKE_COMPLETE') : 'Compose acceptance';
    const message = tool ? { role: 'assistant', content: null, tool_calls: [{ id: `compose-${tool.name}${tool.name === apiTool ? '-' + apiCalls : ''}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] } : { role: 'assistant', content };
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
// The Compose fixture needs every interface of its private network; a local unit test binds loopback.
server.listen(Number(process.env.COMPOSE_FIXTURE_PORT || 3131), process.env.COMPOSE_FIXTURE_HOST || '0.0.0.0', () => console.log('Compose scripted provider ready.'));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
