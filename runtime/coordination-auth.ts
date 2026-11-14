import { createHmac } from 'node:crypto';

// Each capability belongs to one agent on one computer, so a runner moved off a computer or
// revoked cannot reuse it. The coordinator also requires each request to name a live run of
// that agent on that computer. The run is not in the token: a runtime prepared ahead of its
// run (prewarming) learns its run only from the lease written when the run starts.
export function coordinationToken(controlToken: string, agentId: string, machineId: string) {
  return createHmac('sha256', controlToken).update(JSON.stringify(['coordination-v2', agentId, machineId])).digest('hex');
}
