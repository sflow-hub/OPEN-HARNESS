import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/native-browser',
  outputDir: './test-results/native',
  workers: 1,
  timeout: 60_000,
  use: {
    javaScriptEnabled: false,
    screenshot: 'only-on-failure',
    launchOptions: process.env.OPEN_HARNESS_TEST_CHROMIUM
      ? { executablePath: process.env.OPEN_HARNESS_TEST_CHROMIUM } : {},
  },
});
