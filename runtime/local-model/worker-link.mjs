import { execFileSync } from 'node:child_process';
import net from 'node:net';

// This process shares only the private engine's network namespace. Its bridge
// address is what Docker maps to host-gateway inside an agent container.
// docker0 already has its address before the first agent attaches, even while
// it has no carrier. Node's os.networkInterfaces() omits it in that state.
const [bridge] = JSON.parse(execFileSync('ip', ['-j', '-4', 'address', 'show', 'dev', 'docker0'], { encoding: 'utf8' }));
const gateway = bridge?.addr_info.find(address => address.family === 'inet')?.local;
if (!net.isIPv4(gateway)) throw new Error('The agent network is still starting.');

if (process.argv[2] === '--health') {
  const response = await fetch('http://' + gateway + ':17572/v1/models', { signal: AbortSignal.timeout(4000) });
  const catalog = response.ok && await response.json();
  if (!catalog?.data?.some(entry => entry.id === 'atlas-linux')) process.exitCode = 1;
} else net.createServer(client => {
  const model = net.connect(8080, 'atlas-model');
  const close = () => { client.destroy(); model.destroy(); };
  client.on('error', close).once('close', () => model.destroy());
  model.on('error', close);
  client.pipe(model).pipe(client);
}).listen(17572, gateway);
