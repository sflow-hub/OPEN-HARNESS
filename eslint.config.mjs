import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores(['dist */**', 'apps/mobile/dist/**', 'apps/mobile/.expo/**', '.next/**', '.vinext/**', '.wrangler/**', '.open-harness*/**', 'Claude outputs/**', 'work/**', '**/* [0-9].{ts,tsx,mts,js,mjs}', 'out/**', 'build/**', 'dist/**', 'src-tauri/target/**', 'src-tauri/resources/**', 'runtime/runner.mjs', 'next-env.d.ts']),
]);

export default eslintConfig;
