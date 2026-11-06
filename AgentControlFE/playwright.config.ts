import { defineConfig, devices } from '@playwright/test'

/**
 * FE-P2-8 Playwright.
 *
 *   npm run e2e
 *
 * Starts the fake runner (e2e/fake-be.mjs, no podman) and the Vite dev server.
 * Viewport is locked at 1280×800, timezone UTC, locale en-US, light color scheme,
 * reduced motion. Screenshots go to e2e/artifacts/ (gitignored) and are uploaded
 * from CI. They are not a pixel-diff gate.
 *
 * The @vm smoke (e2e/vm-smoke.spec.ts) is skipped unless AC_VM_TESTS=1.
 * That flag is not set by `npm run e2e` and not set in CI.
 */
const fakePort = 3099
const appPort = 4174
const appOrigin = `http://127.0.0.1:${appPort}`

const desktop = devices['Desktop Chrome']

export default defineConfig({
  testDir: './e2e',
  testMatch: '*.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  globalTeardown: './e2e/teardown.mjs',
  use: {
    baseURL: appOrigin,
    ...desktop,
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    timezoneId: 'UTC',
    locale: 'en-US',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    screenshot: 'on',
    video: 'off',
    trace: 'retain-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },
  webServer: [
    {
      command: 'node e2e/fake-be.mjs',
      port: fakePort,
      reuseExistingServer: false,
      timeout: 30_000,
      env: { AC_E2E_PORT: String(fakePort) },
    },
    {
      command: `npx vite --host 127.0.0.1 --port ${appPort} --strictPort`,
      port: appPort,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { AGENTCONTROL_API_TARGET: `http://127.0.0.1:${fakePort}` },
    },
  ],
})
