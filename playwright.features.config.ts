import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

/**
 * Feature/functions suite (e2e/features) — the "what does the app do" checks an
 * agent can run in seconds, separate from the full e2e suite.
 *
 * Fully isolated from the main e2e suite: own port (3457), own throwaway SQLite
 * (data/features.db), own Tantivy index (the native dir is scoped by DB path).
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3457;

export default defineConfig({
  testDir: path.resolve(here, "e2e/features"),
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
    reducedMotion: "reduce",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `node node_modules/tsx/dist/cli.mjs src/server/server.ts`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 90_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PORT: String(PORT),
      // Isolated database: features.db auto-seeds the demo on first run.
      DB_PATH: "./data/features.db",
    },
  },
});