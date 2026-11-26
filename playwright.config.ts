import { defineConfig, devices } from "@playwright/test";

/**
 * E2E tests run against a production build on port 3100 with their own database and storage,
 * reset before every run. Set PW_DEV=1 to run against an already running `npm run dev` on port
 * 3000 instead (this resets the development database).
 */
const dev = process.env.PW_DEV === "1";
const port = dev ? 3000 : 3100;
const e2eEnv = {
  DATABASE_URL: "file:./data/e2e.db",
  STORAGE_DIR: "./data/e2e-storage",
  NEXT_TELEMETRY_DISABLED: "1",
  CHECKPOINT_DISABLE: "1",
  // The browser tests check fixed figures; the background case upkeep (reminders coming due) would change them.
  T_CYBER_UPKEEP: "0",
};

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  globalSetup: "./tests/e2e/global-setup.ts",
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: dev
    ? undefined
    : {
        // Playwright starts the server before global setup runs, and the readiness check (/login) reads the
        // database, so the E2E database is migrated first. Global setup then resets it to the demonstration.
        command: "npx prisma migrate deploy && npx next build && npx next start --port 3100",
        url: "http://localhost:3100/login",
        timeout: 300_000,
        reuseExistingServer: false,
        env: e2eEnv,
      },
});
