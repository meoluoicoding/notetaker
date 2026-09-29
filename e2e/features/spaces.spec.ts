import { test, expect, type APIRequestContext } from "@playwright/test";
import { api } from "../tests/api";

/**
 * Spaces: every index/object lives in exactly one space; switching spaces must
 * reload type lists, counts and objects. The switcher UI is driven here.
 */

test("creating a space seeds a Page type; the switcher finds it; deleting it cleans up", async ({ page, request }) => {
  const before = await api<Array<{ id: string; name: string }>>(request, "/spaces");
  const space = await api<{ id: string }>(request, "/spaces", {
    method: "POST",
    data: { name: "Feature space", icon: "🚀" },
  });
  try {
    // a brand-new space is immediately usable: it owns one "Page" type
    const spaces = await api<Array<{ id: string; typeCount: number; objectCount: number }>>(request, "/spaces");
    const mine = spaces.find((s) => s.id === space.id);
    expect(mine?.typeCount).toBe(1);
    expect(mine?.objectCount).toBe(0);

    // the switcher lists both spaces and filtering narrows them
    await page.goto("/");
    await page.waitForSelector(".object-card");
    await page.locator(".space-btn").click();
    await expect(page.locator(".space-row", { hasText: "Feature space" })).toBeVisible();
    await page.locator(".space-search").fill("Feature");
    await expect(page.locator(".space-row")).toHaveCount(1);
    await page.keyboard.press("Escape");

    // switching into the new space keeps it as the active space (X-Space-Id)
    await page.locator(".space-btn").click();
    await page.locator(".space-row", { hasText: "Feature space" }).click();
    await expect(page.locator(".space-name")).toHaveText("Feature space");
    await expect.poll(() => page.evaluate(() => localStorage.getItem("nt-space-id"))).toBeTruthy();
  } finally {
    // the last space is protected; ours is a fresh one so force-delete works
    await api(request, `/spaces/${space.id}?force=1`, { method: "DELETE" });
    const after = await api<Array<{ id: string }>>(request, "/spaces");
    expect(after.map((s) => s.id)).not.toContain(space.id);
    void before;
  }
});