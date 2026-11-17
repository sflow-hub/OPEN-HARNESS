import { networkInterfaces } from 'node:os';
import net from 'node:net';

// This process shares only the private engine's network namespace. Its bridge
// address is what Docker maps to host-gateway inside an agent container.
const gateway = networkInterfaces().docker0?.find(address => address.family === 'IPv4');
if (!gateway) throw new Error('The agent network is still starting.');

if (process.argv[2] === '--health') {
  const response = await fetch('http://' + gateway.address + ':17572/v1/models', { signal: AbortSignal.timeout(4000) });
  const catalog = response.ok && await response.json();
  if (!catalog?.data?.some(entry => entry.id === 'atlas-linux')) process.exitCode = 1;
} else net.createServer(client => {
  const model = net.connect(8080, 'atlas-model');
  const close = () => { client.destroy(); model.destroy(); };
  client.on('error', close).on('close', close);
  model.on('error', close).on('close', close);
  client.pipe(model).pipe(client);
}).listen(17572, gateway.address);
