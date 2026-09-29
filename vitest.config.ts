import { defineConfig } from "vitest/config";

/**
 * Unit/integration suite. The e2e folder is a separate @playwright/test suite
 * (e2e/playwright.config.ts, `npm run e2e`) — vitest must not pick those
 * *.spec.ts files up.
 */
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "e2e/**"],
  },
});
