import type { ToolInfo } from '../lib/agent-profile';
import type { HarnessChoice, HarnessFeatures, HarnessKind } from '../lib/harness';
import { ProfileError } from './profiles';

export const RUNTIME_PROTOCOL = 'open-harness-runtime/v1';
export type HarnessManifest = {
  schemaVersion: 1; id: string; name: string; version: string; license: string;
  architecture: string[]; image: string; imageArchive?: string;
  command: string[]; protocol: typeof RUNTIME_PROTOCOL;
  features: HarnessFeatures; providers: string[]; files: Record<string, string>;
  configuration?: string[]; tools?: ToolInfo[];
};
export function managedRelativePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\\\x00-\x1f:\x7f]/.test(value) || value.startsWith('/') || value.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p))) throw new ProfileError('Choose a safe relative file path.');
  return value;
}
export function validateHarnessChoice(value: unknown): HarnessChoice {
  if (value === undefined) return { kind: 'hermes' };
  const c = value as HarnessChoice;
  if (!c || typeof c !== 'object' || !/^(hermes|opencode|custom:[a-z0-9][a-z0-9_-]{0,63})$/.test(c.kind) || Object.keys(c).some(k => !['kind','version','configRevision'].includes(k))) throw new ProfileError('Choose a supported agent harness.');
  if (c.version !== undefined && (typeof c.version !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,79}$/.test(c.version))) throw new ProfileError('Invalid harness version.');
  if (c.configRevision !== undefined && (typeof c.configRevision !== 'string' || !/^[a-f0-9-]{36}$/.test(c.configRevision))) throw new ProfileError('Invalid harness configuration revision.');
  return { kind: c.kind as HarnessKind, ...(c.version ? { version: c.version } : {}), ...(c.configRevision ? { configRevision: c.configRevision } : {}) };
}
export function validateManifest(value: unknown): HarnessManifest {
  const m = value as HarnessManifest;
  if (!m || m.schemaVersion !== 1 || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(m.id) || ['hermes','opencode'].includes(m.id) || typeof m.name !== 'string' || !m.name.trim() || m.name.length > 80 || typeof m.license !== 'string' || m.license.length > 100) throw new ProfileError('Invalid harness package identity.');
  validateHarnessChoice({ kind: `custom:${m.id}`, version: m.version });
  if (!m.version || !Array.isArray(m.architecture) || !m.architecture.length || m.architecture.some(a => !['x64','arm64'].includes(a))) throw new ProfileError('Package must declare its version and supported architectures.');
  if (typeof m.image !== 'string' || !/^(?:[a-z0-9][a-z0-9./:_-]*@)?sha256:[a-f0-9]{64}$/.test(m.image)) throw new ProfileError('Harness images must be pinned by sha256 digest.');
  if(m.image.startsWith('sha256:')&&!m.imageArchive)throw new ProfileError('A local image digest requires an image archive.');
  if (!Array.isArray(m.command) || !m.command.length || m.command.length > 100 || m.command.some(a => typeof a !== 'string' || a.length > 4000 || a.includes('\0')) || m.command[0].startsWith('-')) throw new ProfileError('Package must declare executable arguments.');
  if (m.protocol!==RUNTIME_PROTOCOL) throw new ProfileError('Unsupported harness adapter protocol.');
  const keys = ['memory','skills','sessionRecall','scheduling','desktop','mcp','approvals','steer','clarify'] as const;
  if (!m.features || keys.some(k => typeof m.features[k] !== 'boolean') || !m.features.approvals || m.features.desktop) throw new ProfileError('Custom harnesses must support approvals; private desktop support is reserved for Hermes.');
  if (!Array.isArray(m.providers) || m.providers.length > 100 || m.providers.some(p => typeof p !== 'string' || p.length > 100 || p === 'openai-codex')) throw new ProfileError('Invalid harness providers. ChatGPT sign-in stays on the coordinator.');
  if (!m.files || typeof m.files !== 'object' || Array.isArray(m.files) || Object.keys(m.files).length > 10000) throw new ProfileError('Package must include a checksum manifest.');
  for (const [path, hash] of Object.entries(m.files)) { managedRelativePath(path); if (['harness.json','installation.json'].includes(path) || !/^[a-f0-9]{64}$/.test(hash)) throw new ProfileError('Invalid package file checksum.'); }
  if (m.imageArchive && !m.image.startsWith('sha256:'))throw new ProfileError('Image archives must pin the Docker image ID, without a repository tag.');
  if (m.imageArchive) { managedRelativePath(m.imageArchive); if (!m.files[m.imageArchive]) throw new ProfileError('Image archive is missing its checksum.'); }
  if (m.configuration && (!Array.isArray(m.configuration) || m.configuration.length > 100)) throw new ProfileError('Invalid configuration inputs.');
  for (const path of m.configuration || []) managedRelativePath(path);
  if(m.tools&&(!Array.isArray(m.tools)||m.tools.length>3000||m.tools.some(t=>!t||typeof t.id!=='string'||!/^[a-zA-Z0-9_.:-]{1,200}$/.test(t.id)||typeof t.name!=='string'||typeof t.group!=='string'||typeof t.description!=='string'||typeof t.available!=='boolean')))throw new ProfileError('Invalid custom tool catalog.');
  return m;
}
