export type ReadinessState = 'ready' | 'action' | 'missing' | 'unavailable';

export type SetupAction = 'start-container-engine' | 'prepare-runtime';
export const SETUP_ACTIONS: readonly SetupAction[] = ['start-container-engine', 'prepare-runtime'];

// One per coordinator. It outlives the request that started it, so a closed or reloaded
// dashboard picks the same job back up from the status endpoint.
export type SetupJob = {
  action: SetupAction;
  state: 'running' | 'succeeded' | 'failed';
  message?: string;
};

export type ReadinessCheck = {
  id: 'coordinator' | 'container-engine' | 'workspace-sharing' | 'agent-runtime' | 'desktop';
  label: string;
  state: ReadinessState;
  detail: string;
  action?: SetupAction;
  actionLabel?: string;
  helpUrl?: string;
};

export type OnboardingStatus = {
  platform: 'linux' | 'darwin' | 'win32' | 'unknown';
  platformLabel: string;
  executionReady: boolean;
  recommendedAccess: 'private' | 'direct';
  credentialMode: 'coordinator' | 'runner';
  credentialMachineId?: string;
  credentialNames?: string[];
  checks: ReadinessCheck[];
  setupJob?: SetupJob;
};
