import { spawnSync } from 'node:child_process';
import { addressIsReachable, type Reachability, type ReachabilityOption } from '../lib/reachability';

// Detecting Tailscale shells out, so it is cached and bounded the way the Docker and Python
// probes are: a wedged binary must not hold up a pairing screen.
let cached: { at: number; dnsName: string } | null = null;
const CACHE_MS = 30_000;

function tailscaleDnsName(): string {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.dnsName;
  let dnsName = '';
  try {
    const result = spawnSync('tailscale', ['status', '--json'], { encoding: 'utf8', timeout: 4_000 });
    if (result.status === 0 && result.stdout) {
      const status = JSON.parse(result.stdout) as { Self?: { DNSName?: string }; BackendState?: string };
      // Only useful once the node is actually up; a logged-out tailscaled reports a name it
      // cannot serve on.
      if (status.BackendState === 'Running') dnsName = String(status.Self?.DNSName || '').replace(/\.$/, '');
    }
  } catch { dnsName = ''; }
  cached = { at: Date.now(), dnsName };
  return dnsName;
}

export function reachability(input: { publicUrl: string; bind: string; port: number }): Reachability {
  const publicUrl = input.publicUrl.replace(/\/$/, '');
  const reachable = addressIsReachable(publicUrl);
  const loopbackOnly = ['127.0.0.1', 'localhost', '::1'].includes(input.bind);
  const options: ReachabilityOption[] = [];

  if (reachable) {
    options.push({
      id: 'configured',
      title: 'Ready to pair',
      detail: 'Your phone will reach this coordinator at the address below.',
      url: publicUrl,
    });
    return { publicUrl, reachable, bind: input.bind, loopbackOnly, options };
  }

  const dnsName = tailscaleDnsName();
  if (dnsName) {
    options.push({
      id: 'tailscale',
      title: 'Use Tailscale',
      detail: `This computer is on a tailnet as ${dnsName}. Serve the coordinator on it, then install Tailscale on the phone and sign in to the same tailnet. This needs no open ports and no certificate of your own.`,
      command: `tailscale serve --bg ${input.port}`,
      url: `https://${dnsName}`,
    });
  } else {
    options.push({
      id: 'tailscale',
      title: 'Use Tailscale',
      detail: 'A tailnet gives this computer an HTTPS address your phone can reach without opening a port or obtaining a certificate. Install Tailscale on both, sign in to the same tailnet, then serve the coordinator.',
      command: `tailscale serve --bg ${input.port}`,
    });
  }

  options.push({
    id: 'proxy',
    title: 'Put it behind your own HTTPS address',
    detail: 'On a VPS with a domain, terminate HTTPS in a reverse proxy in front of the coordinator and start it with the address it should hand out. Authenticate the proxy: anything that reaches the dashboard can create runs.',
    command: `OPEN_HARNESS_BIND=0.0.0.0 OPEN_HARNESS_PUBLIC_URL=https://agents.example.com npm run harness:serve`,
  });

  return { publicUrl, reachable, bind: input.bind, loopbackOnly, options };
}
