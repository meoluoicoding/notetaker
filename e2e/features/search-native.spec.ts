import { test, expect, type APIRequestContext } from "@playwright/test";
import { API } from "../tests/api";

/**
 * Search features: FTS5 pipeline + the optional native Tantivy layer.
 *
 * The /api/v1/search meta exposes `native: true|false` so the typo test can
 * skip cleanly on machines without `npm run build:native`.
 */

async function hitsFor(request: APIRequestContext, q: string) {
  const res = await request.fetch(`${API}/search?q=${encodeURIComponent(q)}&limit=10`);
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  return { hits: body.data as Array<{ object: { title: string } }>, meta: body.meta as { native?: boolean } };
}

test("exact/prefix search returns the seeded Notetaker project (FTS5 + native)", async ({ request }) => {
  const { hits } = await hitsFor(request, "notetaker");
  expect(hits.some((h) => h.object.title === "Notetaker MVP")).toBeTruthy();
});

test("typo-tolerant search — 'notetakr' still finds 'Notetaker MVP' (Tantivy)", async ({ request }) => {
  const { meta } = await hitsFor(request, "notetak");
  test.skip(meta.native !== true, "native search not built — run `npm run build:native`");

  // FTS5's prefix search misses the typo; only the fuzzy Tantivy query finds it.
  const { hits, meta: fuzzyMeta } = await hitsFor(request, "notetakr");
  expect(fuzzyMeta.native).toBe(true);
  expect(hits.some((h) => h.object.title === "Notetaker MVP")).toBeTruthy();
});

test("Ctrl+K palette opens and ranks results in the UI", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector(".object-card");
  await page.keyboard.press("Control+k");
  await expect(page.locator(".palette-input")).toBeVisible();
  await page.locator(".palette-input").fill("notetaker");
  await expect(page.locator(".palette-row").first()).toBeVisible({ timeout: 10_000 });
  const text = await page.locator(".palette-row").first().textContent();
  expect(text).toContain("Notetaker");
});