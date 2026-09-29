import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end suite (see e2e/README.md).
 *
 * One server started by Playwright's webServer hook against a throwaway SQLite
 * database, so the whole suite shares one running app and never touches
 * data/notetaker.db.
 *
 * `npm run e2e`     headless run
 * `npm run e2e:ui`  interactive inspector
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.E2E_PORT || 3456);

export default defineConfig({
  testDir: path.resolve(here, "e2e/tests"),
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["list"]],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    // Alpine's x-transition waits for a CSS transitionend event. Where the
    // compositor is unavailable (headless CI, remote sessions) that event may
    // never fire and every transitioned element stays stuck at opacity 0.
    // Reduced motion makes the transition instant and unblocks this.
    reducedMotion: "reduce",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // tsx ships a POSIX shim, so Windows invokes the CLI through node.
    command: `node node_modules/tsx/dist/cli.mjs src/server/server.ts`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 90_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PORT: String(PORT),
      // Isolated database per run: never touch data/notetaker.db from e2e.
      DB_PATH: process.env.E2E_DB || "./data/e2e.db",
    },
  },
});
