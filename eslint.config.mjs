import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores(['dist */**', 'apps/mobile/dist/**', 'apps/mobile/.expo/**', '.next/**', '.vinext/**', '.wrangler/**', '.open-harness*/**', 'Claude outputs/**', 'work/**', '**/* [0-9].{ts,tsx,mts,js,mjs}', 'out/**', 'build/**', 'dist/**', 'src-tauri/target/**', 'src-tauri/resources/**', 'runtime/runner.mjs', 'runtime/hermes/vendor/**', 'next-env.d.ts']),
  {
    // Decisions are advisory. The engine reaches the network only through the credential
    // transport, and never imports what starts work, changes cards, answers approvals or touches files.
    files: ['runtime/decisions.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: [{
      group: ['./db', './service', './runner', './hermes', './machines', './profiles', './profile-runtime', './tasks', './teams', './secrets', './workspace-folders', './folder-*', './host-folders', './transfer-files', './agent-context', './profile-memory', './path-safety', './coordination-*', 'node:fs', 'node:fs/*', 'fs', 'fs/*', 'node:child_process', 'child_process', 'node:http', 'http', 'node:https', 'https', 'node:net', 'net', 'node:dns', 'node:dns/*', 'dns'],
      message: 'Decisions are advisory: decisions.ts may not act, touch files or open its own connections. Call credentialApi for the network.',
    }] }] },
  },
  {
    // Approvals stay with a person: a model deciding them approved `chmod 777` on a host mount (81a41a8).
    files: ['runtime/hermes.ts', 'runtime/runner.ts', 'runtime/profile-runtime.ts', 'runtime/hermes/**'],
    rules: { 'no-restricted-imports': ['error', { patterns: [{ group: ['**/decisions', './decisions', '../decisions'], message: 'Approvals stay with the operator; decision-model output is advisory.' }] }] },
  },
]);

export default eslintConfig;
