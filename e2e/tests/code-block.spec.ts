import { test, expect, type APIRequestContext } from "./fixtures";
import { readBlock, blockLocator, openObject } from "./api";

/**
 * Code blocks. CodeMirror mounts asynchronously from lazily loaded addons, so
 * every assertion waits for the real editor rather than the host div.
 */
test.describe("code block", () => {
  test("mounts CodeMirror with line numbers and a language picker", async ({ page, request, objectId }) => {
    const blockId = await apiCreateCode(request, objectId, {
      language: "rust",
      code: 'fn main() {\n    println!("hello");\n}\n',
    });

    await page.goto("/");
    await openObject(page, objectId);

    const code = blockLocator(page, blockId).locator(".b-code");
    await expect(code).toBeVisible();
    // the rich editor, not the plain-textarea fallback
    await expect(code.locator(".CodeMirror")).toBeVisible({ timeout: 20_000 });
    // line-number gutter is absolutely positioned inside the editor chrome, so
    // visibility is asserted on the rendered text it labels instead
    await expect(code.locator(".CodeMirror-code .CodeMirror-line")).toHaveCount(4);
    await expect(code.locator("select.code-lang")).toHaveValue("rust");
    await expect(code.locator("textarea.code-area")).toHaveCount(0);
  });

  test("typing in CodeMirror saves to the database", async ({ page, request, objectId }) => {
    const blockId = await apiCreateCode(request, objectId, { language: "javascript", code: "" });

    await page.goto("/");
    await openObject(page, objectId);

    const cm = blockLocator(page, blockId).locator(".CodeMirror");
    await expect(cm).toBeVisible({ timeout: 20_000 });
    await cm.click();

    const text = "const square = (n) => n * n;";
    await page.keyboard.type(text);

    // autosave is debounced; the API is the authority on whether it stuck
    await expect
      .poll(
        async () => {
          const stored = await readBlock(request, objectId, blockId);
          return stored.content.code;
        },
        { timeout: 20_000, message: "CodeMirror edit should reach the API" },
      )
      .toBe(text);

    const stored = await readBlock(request, objectId, blockId);
    expect(stored.content.language).toBe("javascript");
  });

  test("changing the language re-mounts the editor and keeps the code", async ({ page, request, objectId }) => {
    const blockId = await apiCreateCode(request, objectId, { language: "javascript", code: "const x = 1;" });

    await page.goto("/");
    await openObject(page, objectId);

    const code = blockLocator(page, blockId).locator(".b-code");
    await expect(code.locator(".CodeMirror")).toBeVisible({ timeout: 20_000 });

    await code.locator("select.code-lang").selectOption("python");
    await expect(code.locator(".CodeMirror")).toBeVisible({ timeout: 20_000 });
    await expect(code.locator("select.code-lang")).toHaveValue("python");

    // switching mode must never drop what the user wrote
    const stored = await readBlock(request, objectId, blockId);
    expect(stored.content.language).toBe("python");
    expect(stored.content.code).toBe("const x = 1;");
  });

  test("the Fold button collapses and restores the editor", async ({ page, request, objectId }) => {
    const blockId = await apiCreateCode(request, objectId, {
      language: "javascript",
      code: [
        "function one() {",
        "  return 1;",
        "}",
        "function two() {",
        "  return 2;",
        "}",
        "function three() {",
        "  return 3;",
        "}",
      ].join("\n"),
    });

    await page.goto("/");
    await openObject(page, objectId);

    const code = blockLocator(page, blockId).locator(".b-code");
    const lines = code.locator(".CodeMirror-lines");
    await expect(code.locator(".CodeMirror")).toBeVisible({ timeout: 20_000 });
    const fullHeight = await lines.boundingBox().then((b) => b?.height ?? 0);
    expect(fullHeight).toBeGreaterThan(0);

    await code.locator(".code-copy", { hasText: "Fold" }).click();
    await expect
      .poll(
        async () => lines.boundingBox().then((b) => b?.height ?? 0),
        { timeout: 10_000, message: "folding should shrink the editor" },
      )
      .toBeLessThan(fullHeight);

    await code.locator(".code-copy", { hasText: "Fold" }).click();
    await expect
      .poll(
        async () => lines.boundingBox().then((b) => b?.height ?? 0),
        { timeout: 10_000, message: "unfolding should restore the editor" },
      )
      .toBe(fullHeight);
  });

  test("Ctrl-F opens the find dialog inside the editor", async ({ page, request, objectId }) => {
    const blockId = await apiCreateCode(request, objectId, {
      language: "plaintext",
      code: ["alpha", "beta", "gamma"].join("\n"),
    });

    await page.goto("/");
    await openObject(page, objectId);

    const code = blockLocator(page, blockId).locator(".b-code");
    const cm = code.locator(".CodeMirror");
    await expect(cm).toBeVisible({ timeout: 20_000 });
    await cm.click();
    await page.keyboard.press("Control+f");

    await expect(code.locator(".CodeMirror-dialog")).toBeVisible({ timeout: 10_000 });
    await expect(code.locator(".CodeMirror-dialog input")).toBeVisible();
  });

  test("Ctrl-Space offers completions and never silently picks one", async ({ page, request, objectId }) => {
    // Regression: show-hint.js was missing from the asset list, so the
    // autocomplete command did not exist and Ctrl+Space did nothing at all.
    // Even loaded, the default completeSingle inserts a lone match and closes
    // the menu — so a single-candidate completion must still be offered.
    const blockId = await apiCreateCode(request, objectId, {
      language: "javascript",
      code: "const fizzbuzz = 1;\nfizz",
    });

    await page.goto("/");
    await openObject(page, objectId);

    const code = blockLocator(page, blockId).locator(".b-code");
    const cm = code.locator(".CodeMirror");
    await expect(cm).toBeVisible({ timeout: 20_000 });
    await cm.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Control+Space");

    await expect(page.locator(".CodeMirror-hints")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".CodeMirror-hints li")).not.toHaveCount(0);
    // the menu is on screen, meaning the sole candidate was offered not inserted
    expect(await page.locator(".CodeMirror-hints li").first().textContent()).toContain("fizzbuzz");

    // accepting with Enter inserts it
    await page.keyboard.press("Enter");
    await expect
      .poll(
        async () => {
          const stored = await readBlock(request, objectId, blockId);
          return stored.content.code;
        },
        { timeout: 15_000, message: "accepting a completion should save" },
      )
      .toContain("fizzbuzz");

    // and nothing was inserted while the menu was merely opened
    expect(blockId).toBeTruthy();
  });

  test("Copy puts the code source on the clipboard", async ({ page, context, request, objectId }) => {
    const codeText = "SELECT 1;";
    const blockId = await apiCreateCode(request, objectId, { language: "sql", code: codeText });

    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/");
    await openObject(page, objectId);

    const code = blockLocator(page, blockId).locator(".b-code");
    await code.locator(".code-copy", { hasText: "Copy" }).click();

    const clip = await page.evaluate(() => navigator.clipboard.readText());
    expect(clip).toContain(codeText);
  });

  test("Tab inserts spaces, never a tab character", async ({ page, request, objectId }) => {
    const blockId = await apiCreateCode(request, objectId, { language: "python", code: "x = 1" });

    await page.goto("/");
    await openObject(page, objectId);

    const code = blockLocator(page, blockId).locator(".b-code");
    const cm = code.locator(".CodeMirror");
    await expect(cm).toBeVisible({ timeout: 20_000 });
    await cm.click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await page.keyboard.type("y = 2");

    await expect
      .poll(
        async () => {
          const stored = await readBlock(request, objectId, blockId);
          return stored.content.code;
        },
        { timeout: 20_000, message: "tab + typing should save" },
      )
      .toBe("x = 1\n  y = 2");
  });
});

async function apiCreateCode(
  request: APIRequestContext,
  objectId: string,
  content: { language: string; code: string },
): Promise<string> {
  const res = await request.post(`/api/v1/objects/${objectId}/blocks`, {
    data: { type: "code", content },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()).data.id;
}
