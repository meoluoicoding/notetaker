import { test, expect, type APIRequestContext } from "./fixtures";
import { blockLocator, openObject, readBlock } from "./api";

/**
 * Inline formatting + markdown shortcuts (AppFlowy/Notion style).
 *
 * The stored model is `{ text, marks }` — never HTML — so every assertion
 * reads the API as well as the DOM.
 */
test.describe("inline format", () => {
  test("'## ' turns the line into a heading 2", async ({ page, request, objectId, firstBlock }) => {
    await page.goto("/");
    await openObject(page, objectId);

    const para = blockLocator(page, firstBlock).locator(".b-paragraph");
    await para.click();
    await page.keyboard.type("## Roadmap");

    await expect(blockLocator(page, firstBlock).locator(".b-heading")).toBeVisible({ timeout: 10_000 });
    await expectBlockText(request, objectId, firstBlock, "Roadmap");

    const stored = await readBlock(request, objectId, firstBlock);
    expect(stored.type).toBe("heading");
    expect(stored.content).toMatchObject({ level: 2, text: "Roadmap" });
  });

  test("'- ' turns the line into a bulleted list item", async ({ page, request, objectId, firstBlock }) => {
    await page.goto("/");
    await openObject(page, objectId);

    await blockLocator(page, firstBlock).locator(".b-paragraph").click();
    await page.keyboard.type("- first item");

    await expect(blockLocator(page, firstBlock).locator(".b-list.bulleted")).toBeVisible({ timeout: 10_000 });
    await expectBlockText(request, objectId, firstBlock, "first item");

    const stored = await readBlock(request, objectId, firstBlock);
    expect(stored.type).toBe("bulleted_list");
    expect(stored.content.text).toBe("first item");
  });

  test("'```' turns the line into a code block with the language", async ({ page, request, objectId, firstBlock }) => {
    await page.goto("/");
    await openObject(page, objectId);

    await blockLocator(page, firstBlock).locator(".b-paragraph").click();
    await page.keyboard.type("```python ");

    await expect(blockLocator(page, firstBlock).locator(".CodeMirror")).toBeVisible({ timeout: 20_000 });
    const stored = await readBlock(request, objectId, firstBlock);
    expect(stored.type).toBe("code");
    expect(stored.content.language).toBe("python");
  });

  test("'**bold**' is converted to a mark and saved as text + marks", async ({ page, request, objectId, firstBlock }) => {
    await page.goto("/");
    await openObject(page, objectId);

    const para = blockLocator(page, firstBlock).locator(".b-paragraph");
    await para.click();
    await page.keyboard.type("hello **world**");

    await expect(para.locator("span.m-bold")).toHaveText("world", { timeout: 10_000 });

    // the inline edit autosaves on a debounce, so poll the API for it
    await expect
      .poll(async () => (await readBlock(request, objectId, firstBlock)).content.text, {
        timeout: 10_000,
        message: "the converted inline mark should reach the API",
      })
      .toBe("hello world");
    const stored = await readBlock(request, objectId, firstBlock);
    expect(stored.content.marks).toEqual([{ type: "bold", from: 6, to: 11 }]);
  });

  test("the selection toolbar bolds the selected words", async ({ page, request, objectId, firstBlock }) => {
    const blockId = await seedParagraph(request, objectId, "make me bold");
    await page.goto("/");
    await openObject(page, objectId);

    const para = blockLocator(page, blockId).locator(".b-paragraph");
    await expect(para).toHaveText("make me bold");
    // select the last word through the keyboard, then use the floating toolbar
    await para.click();
    await page.keyboard.press("End");
    for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+ArrowLeft");

    const toolbar = page.locator(".fmt-toolbar");
    await expect(toolbar).toBeVisible({ timeout: 10_000 });
    await toolbar.locator(".fmt-btn", { hasText: "B" }).first().click();

    await expect
      .poll(
        async () => (await readBlock(request, objectId, blockId)).content.marks,
        { timeout: 10_000, message: "bold should reach the API" },
      )
      .toEqual([{ type: "bold", from: 8, to: 12 }]);

    // and it survives a reload: the block is rendered from the stored model
    await page.reload();
    await openObject(page, objectId);
    await expect(blockLocator(page, blockId).locator("span.m-bold")).toHaveText("bold");
  });

  test("Ctrl+B bolds the selection", async ({ page, request, objectId }) => {
    const blockId = await seedParagraph(request, objectId, "shortcut");
    await page.goto("/");
    await openObject(page, objectId);

    const para = blockLocator(page, blockId).locator(".b-paragraph");
    await para.click();
    await page.keyboard.press("End");
    for (let i = 0; i < 8; i++) await page.keyboard.press("Shift+ArrowLeft");
    await page.keyboard.press("Control+b");

    await expect
      .poll(
        async () => (await readBlock(request, objectId, blockId)).content.marks,
        { timeout: 10_000, message: "Ctrl+B should reach the API" },
      )
      .toEqual([{ type: "bold", from: 0, to: 8 }]);
  });
});

/** Inline edits autosave on a debounce: poll the API instead of racing it. */
async function expectBlockText(
  request: APIRequestContext,
  objectId: string,
  blockId: string,
  text: string,
): Promise<void> {
  await expect
    .poll(async () => (await readBlock(request, objectId, blockId)).content.text, {
      timeout: 10_000,
      message: `block text should become "${text}"`,
    })
    .toBe(text);
}

async function seedParagraph(request: APIRequestContext, objectId: string, text: string): Promise<string> {
  const res = await request.post(`/api/v1/objects/${objectId}/blocks`, {
    data: { type: "paragraph", content: { text } },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()).data.id;
}
