import { test, expect, type APIRequestContext } from "./fixtures";
import { readBlock, blockLocator, openObject } from "./api";

/**
 * LaTeX / math blocks. Every edit asserts against the API as well as the DOM:
 * a render that only lives in the browser is worthless if the edit never
 * reached the database.
 */
test.describe("latex block", () => {
  test("renders an existing formula with KaTeX", async ({ page, request, objectId }) => {
    const tex = "E = mc^2";
    const blockId = await apiCreateMath(request, objectId, { tex, display: true });

    await page.goto("/");
    await openObject(page, objectId);

    const math = blockLocator(page, blockId).locator(".b-math");
    await expect(math).toBeVisible();
    // KaTeX must have produced real markup, not the raw TeX source
    await expect(math.locator(".katex")).toBeVisible();
  });

  test("an empty block teaches the user what to do next", async ({ page, request, objectId }) => {
    const blockId = await apiCreateMath(request, objectId, { tex: "", display: true });

    await page.goto("/");
    await openObject(page, objectId);

    const math = blockLocator(page, blockId).locator(".b-math");
    await expect(math.locator(".render-status")).toContainText(/Empty LaTeX block/);
    await expect(math.locator(".katex")).toHaveCount(0);
  });

  test("the slash menu converts an empty paragraph into a LaTeX block", async ({ page, request, objectId }) => {
    await page.goto("/");
    await openObject(page, objectId);

    // a "/" in a paragraph that already holds text never opens the menu, so the
    // fixture's empty paragraph is exactly the starting state this needs
    const para = page.locator(".block-list .b-paragraph").last();
    await para.click();
    await page.keyboard.type("/");
    await expect(page.locator(".slash-menu:visible .slash-item:visible").first()).toBeVisible({ timeout: 10_000 });
    await page.locator(".slash-menu .slash-item", { hasText: "LaTeX formula" }).first().click();
    await expect(page.locator(".b-math")).toBeVisible({ timeout: 15_000 });

    // the block was converted in place: no new block, and the API agrees
    const blocks = await request.get(`/api/v1/objects/${objectId}/blocks`).then((r) => r.json());
    expect(blocks.data.map((b: { type: string }) => b.type)).toContain("math");
    expect(blocks.data.length).toBe(1);
  });

  test("Edit -> type -> Done renders and persists the formula", async ({ page, request, objectId }) => {
    const blockId = await apiCreateMath(request, objectId, { tex: "", display: true });
    const tex = "\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}";

    await page.goto("/");
    await openObject(page, objectId);

    const math = blockLocator(page, blockId).locator(".b-math");
    await math.locator(".code-copy", { hasText: "Edit" }).click();

    const source = math.locator("textarea.render-source");
    await expect(source).toBeVisible();
    await source.fill(tex);

    await math.locator(".code-copy", { hasText: "Done" }).click();
    await expect(math.locator(".katex")).toBeVisible();
    await expect(math.locator(".render-status")).toHaveCount(0);

    const stored = await readBlock(request, objectId, blockId);
    expect(stored.content.tex).toBe(tex);
    expect(stored.content.display).toBe(true);
  });

  test("the Inline/Display button round-trips and never gets stuck", async ({ page, request, objectId }) => {
    // Regression: the toolbar used to close over the mounted block object, so
    // saveBlockContent swapped this.blocks[i] out from under it and every click
    // toggled the same stale value. The button label names the *current* mode,
    // so a stuck toggle reads the same label twice in a row.
    const blockId = await apiCreateMath(request, objectId, { tex: "x^2 + y^2 = r^2", display: true });

    await page.goto("/");
    await openObject(page, objectId);

    const math = blockLocator(page, blockId).locator(".b-math");
    const modeBtn = math.locator(".math-mode");

    await expect(modeBtn).toHaveText("Display");
    await expect(math).not.toHaveClass(/inline-math/);
    await expect(math.locator(".katex-display")).toBeVisible();

    // click 1: display -> inline
    await modeBtn.click();
    await expect(modeBtn).toHaveText("Inline");
    await expect(math).toHaveClass(/inline-math/);
    await expect(math.locator(".katex-display")).toHaveCount(0);
    let stored = await readBlock(request, objectId, blockId);
    expect(stored.content.display).toBe(false);

    // click 2: inline -> display — this used to be a no-op
    await modeBtn.click();
    await expect(modeBtn).toHaveText("Display");
    await expect(math).not.toHaveClass(/inline-math/);
    await expect(math.locator(".katex-display")).toBeVisible();
    stored = await readBlock(request, objectId, blockId);
    expect(stored.content.display).toBe(true);

    // clicks 3 and 4 keep cycling, never freezing on one mode
    await modeBtn.click();
    await expect(modeBtn).toHaveText("Inline");
    await modeBtn.click();
    await expect(modeBtn).toHaveText("Display");
    stored = await readBlock(request, objectId, blockId);
    expect(stored.content.display).toBe(true);
  });

  test("unknown LaTeX commands degrade to an inline error, not a broken page", async ({ page, request, objectId }) => {
    const blockId = await apiCreateMath(request, objectId, { tex: "\\unknown{command}", display: true });

    await page.goto("/");
    await openObject(page, objectId);

    const math = blockLocator(page, blockId).locator(".b-math");
    // throwOnError: false -> KaTeX renders its own error markup in place
    await expect(math.locator(".katex")).toBeVisible();
    await expect(blockLocator(page, blockId)).toBeVisible();
    expect(blockId).toBeTruthy();
  });

  test("Copy puts the TeX source on the clipboard", async ({ page, context, request, objectId }) => {
    const tex = "a^2 + b^2 = c^2";
    const blockId = await apiCreateMath(request, objectId, { tex, display: true });

    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/");
    await openObject(page, objectId);

    const math = blockLocator(page, blockId).locator(".b-math");
    await math.locator(".code-copy", { hasText: "Copy" }).click();

    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toContain(tex);
  });
});

async function apiCreateMath(
  request: APIRequestContext,
  objectId: string,
  content: { tex: string; display: boolean },
): Promise<string> {
  const res = await request.post(`/api/v1/objects/${objectId}/blocks`, {
    data: { type: "math", content },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()).data.id;
}
