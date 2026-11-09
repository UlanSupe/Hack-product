import { randomBytes } from "node:crypto";

import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests of the PRODUCTION build in a real browser (the system's Microsoft Edge, so no browser is downloaded).
 * `npm run e2e` builds, then starts `e2e/serve.ts`: a throwaway database in the OS temp directory, seeded with the
 * synthetic demo data, and a passcode generated for this run and never written anywhere. No PayPal credentials are set,
 * so the payment step is checked in its honest "cannot start here" state; the payment flow itself is covered by the
 * fake-PayPal tests (test/payments, test/qa), because the app talks only to the real sandbox host.
 */
const PORT = 3140;
process.env.E2E_PASSCODE ??= randomBytes(24).toString("base64url");

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1, // one shared throwaway server and database, so the tests run in order
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        channel: "msedge",
        viewport: { width: 1280, height: 800 },
      },
      grepInvert: /@mobile-only/,
    },
    {
      name: "mobile",
      use: { ...devices["Pixel 7"], channel: "msedge" },
      grep: /@mobile/,
    },
  ],
  webServer: {
    command: "node e2e/serve.ts",
    url: `http://localhost:${PORT}/api/health`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: { E2E_PORT: String(PORT), E2E_PASSCODE: process.env.E2E_PASSCODE },
  },
});
