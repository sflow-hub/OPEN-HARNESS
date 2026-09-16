export type ReadinessState = 'ready' | 'action' | 'missing' | 'unavailable';

export type ReadinessCheck = {
  id: 'coordinator' | 'container-engine' | 'agent-runtime' | 'desktop';
  label: string;
  state: ReadinessState;
  detail: string;
  action?: 'start-container-engine' | 'prepare-runtime';
  actionLabel?: string;
  helpUrl?: string;
};

export type OnboardingStatus = {
  platform: 'linux' | 'darwin' | 'win32' | 'unknown';
  platformLabel: string;
  executionReady: boolean;
  recommendedAccess: 'private' | 'direct';
  credentialMode: 'coordinator' | 'runner';
  checks: ReadinessCheck[];
};
