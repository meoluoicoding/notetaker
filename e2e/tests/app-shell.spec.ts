import { test, expect } from "./fixtures";

/**
 * App shell: the things every other spec relies on. If these break, nothing
 * else in the suite can be trusted.
 */
test.describe("app shell", () => {
  test("loads the workspace without console errors", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });

    await page.goto("/");
    await expect(page.locator(".workspace")).toBeVisible();
    await expect(page.locator(".sb-nav")).toBeVisible();
    await expect(page).toHaveTitle(/Notetaker/i);

    expect(errors, "unexpected console/page errors on load").toEqual([]);
  });

  test("the seeded dataset is visible in the object grid", async ({ page, request, spaceId, objectId }) => {
    await page.goto("/");
    await page.waitForSelector(".object-card");

    const cards = page.locator(".object-card");
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);
    expect(spaceId).toBeTruthy();
    expect(objectId).toBeTruthy();

    // the API agrees with the UI about what exists in this space
    const objects = await request.get(`/api/v1/objects?limit=200`).then((r) => r.json());
    expect(objects.data.length).toBeGreaterThanOrEqual(count);

    // the fixture object is reachable from the same space
    const found = objects.data.some((o: { id: string }) => o.id === objectId);
    expect(found, "fixture object must be visible in the grid").toBe(true);
  });

  test("clicking a card opens the object editor", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".object-card");

    await page.locator(".object-card").first().click();
    await expect(page.locator(".block-list [data-block-id]")).not.toHaveCount(0);
  });

  test("Ctrl+K opens the search palette and Esc closes it", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".object-card");

    await page.keyboard.press("Control+k");
    await expect(page.locator(".palette-overlay")).toBeVisible();
    await expect(page.locator(".palette-input")).toBeFocused();

    // a seeded weekly note must be findable
    await page.locator(".palette-input").fill("Weekly");
    await expect(page.locator(".palette-row").first()).toBeVisible({ timeout: 15_000 });

    await page.keyboard.press("Escape");
    await expect(page.locator(".palette-overlay")).not.toBeVisible();
  });

  test("Ctrl+N opens the object-type picker", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".object-card");

    await page.keyboard.press("Control+n");
    await expect(page.locator(".picker-overlay")).toBeVisible();
    expect(await page.locator(".picker-row").count()).toBeGreaterThan(0);

    await page.keyboard.press("Escape");
    await expect(page.locator(".picker-overlay")).not.toBeVisible();
  });

  test("the new-object modal converts markdown fences into renderer blocks", async ({ page, request }) => {
    await page.goto("/");
    await page.waitForSelector(".object-card");

    // Ctrl+N opens the type picker; Shift+Enter on a type opens the full form
    await page.keyboard.press("Control+n");
    await expect(page.locator(".picker-overlay")).toBeVisible();
    await page.locator(".picker-row", { hasText: "Page" }).first().click();
    await page.waitForTimeout(300);
    // the picker created the object; open the full form via the keyboard path
    await page.keyboard.press("Control+n");
    await expect(page.locator(".picker-overlay")).toBeVisible();
    await page.keyboard.press("Shift+Enter");
    await expect(page.locator(".modal")).toBeVisible({ timeout: 10_000 });

    await page.locator('input[x-model="newObject.title"]').fill("Fence import e2e");
    await page.locator('textarea[x-model="newObject.content"]').fill(
      [
        "Intro line",
        "```rust",
        'fn main() { println!("e2e"); }',
        "```",
        "```math",
        "\\int_0^1 x^2 \\, dx",
        "```",
        "```mermaid",
        "graph LR",
        "  A --> B",
        "```",
      ].join("\n"),
    );
    await page.locator(".modal-actions >> text=Create").click();
    await expect(page.locator(".page-title")).toContainText("Fence import e2e", { timeout: 15_000 });

    // the renderer blocks the user just "wrote" must really be in the database
    const created = await request.get(`/api/v1/objects?limit=200`).then((r) => r.json());
    const mine = created.data.find((o: { title: string }) => o.title === "Fence import e2e");
    expect(mine, "created object missing from the list").toBeTruthy();

    const blocks = await request.get(`/api/v1/objects/${mine.id}/blocks`).then((r) => r.json());
    expect(blocks.data.map((b: { type: string }) => b.type)).toEqual(["paragraph", "code", "math", "mermaid"]);

    await request.delete(`/api/v1/objects/${mine.id}`);
  });

  test("the theme toggle switches between light and dark", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector(".titlebar");

    const before = await page.locator("html").getAttribute("data-theme");
    const toggle = page.locator(".titlebar button[title*='Switch to']");

    await toggle.click();
    await expect.poll(async () => page.locator("html").getAttribute("data-theme")).not.toBe(before);
    // the choice survives a reload: the theme is stored, not re-derived per load
    await page.reload();
    await expect.poll(async () => page.locator("html").getAttribute("data-theme")).not.toBe(before);

    // restore it so the run leaves the profile the way it found it
    await toggle.click();
    await expect.poll(async () => page.locator("html").getAttribute("data-theme")).toBe(before);
  });
});
