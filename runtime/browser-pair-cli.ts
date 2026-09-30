import { issueBrowserPairing } from './browser-pairing';

try {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--ttl-seconds' || !/^\d+$/.test(args[1]))) throw new Error('Usage: browser-pair [--ttl-seconds 1..600]');
  const issued = issueBrowserPairing(process.env.OPEN_HARNESS_STATE_DIR || '.open-harness', args.length ? Number(args[1]) : undefined);
  process.stdout.write(`${JSON.stringify(issued)}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Could not create a browser connection link.');
  process.exitCode = 1;
}
