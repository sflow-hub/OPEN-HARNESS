// How a phone, or any device that is not this computer, can reach this coordinator.
//
// Pairing hands out an address, and until now the wizard would happily mint a code against
// one that only resolves on the coordinator's own machine. The code then looked fine and
// could never work. This describes the situation instead, so the wizard can say what to do.

export type ReachabilityOption = {
  id: 'configured' | 'tailscale' | 'proxy' | 'lan';
  title: string;
  detail: string;
  // A command to run on the coordinator's machine, where one makes sense.
  command?: string;
  // An address that can be used as-is.
  url?: string;
};

export type Reachability = {
  // The address the coordinator hands out today, whether or not it is usable off-machine.
  publicUrl: string;
  // Whether that address can be reached from another device.
  reachable: boolean;
  // What the HTTP server is bound to.
  bind: string;
  loopbackOnly: boolean;
  options: ReachabilityOption[];
};

const LOOPBACK = ['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'];

// Usable from another device means a real host over HTTPS. Plain HTTP is refused off
// loopback by lib/hub.ts, so an http:// address here would only mislead.
export function addressIsReachable(value: string) {
  if (!value) return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (LOOPBACK.includes(url.hostname)) return false;
  return url.protocol === 'https:';
}
