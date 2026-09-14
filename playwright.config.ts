import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const state = mkdtempSync(join(tmpdir(), 'harness-browser-'));
const controlPort = Number(process.env.OPEN_HARNESS_TEST_PORT || 4317);
const appPort = Number(process.env.OPEN_HARNESS_APP_PORT || 3107);
export default defineConfig({
  testDir: './tests/browser', fullyParallel: false, workers: 1, timeout: 30000,
  use: { baseURL: `http://127.0.0.1:${appPort}`, trace: 'retain-on-failure', screenshot: 'only-on-failure', launchOptions: { ...(process.env.OPEN_HARNESS_TEST_CHROMIUM ? { executablePath: process.env.OPEN_HARNESS_TEST_CHROMIUM } : {}) } },
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } }, { name: 'mobile', use: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } }],
  webServer: [
    { command: `"${process.execPath}" --import tsx runtime/service.ts`, url: `http://127.0.0.1:${controlPort}/v1/bootstrap`, reuseExistingServer: false, env: { OPEN_HARNESS_MOCK: '1', OPEN_HARNESS_STATE_DIR: state, OPEN_HARNESS_PORT: String(controlPort) } },
    { command: `"${process.execPath}" node_modules/vinext/dist/cli.js start -p ${appPort} -H 127.0.0.1`, url: `http://127.0.0.1:${appPort}`, reuseExistingServer: false, timeout: 60000 },
  ],
});
