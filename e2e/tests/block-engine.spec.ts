import { test, expect, type APIRequestContext } from "./fixtures";
import { blockLocator, openObject, appendEmptyParagraph } from "./api";

/**
 * The block engine under the renderers: insertion, conversion, deletion and
 * ordering. These are the primitives every note-taking flow is built on.
 */
test.describe("block engine", () => {
  test("Enter at the end of a block creates a new paragraph below", async ({ page, request, objectId, firstBlock }) => {
    const blockId = await apiCreateParagraph(request, objectId, "first line");

    await page.goto("/");
    await openObject(page, objectId);

    await blockLocator(page, blockId).locator(".b-paragraph").click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");

    await expect(page.locator(".block-list [data-block-id]")).toHaveCount(3, { timeout: 10_000 });

    const blocks = await request.get(`/api/v1/objects/${objectId}/blocks`).then((r) => r.json());
    expect(blocks.data.length).toBe(3);
    expect(blocks.data.map((b: { type: string }) => b.type)).toEqual(["paragraph", "paragraph", "paragraph"]);
    expect(blocks.data[1].id).toBe(blockId);
    expect(blocks.data[0].id).toBe(firstBlock);
  });

  test("the slash menu converts a block in place instead of inserting one", async ({ page, request, objectId }) => {
    await page.goto("/");
    await openObject(page, objectId);

    // "/" only opens the menu in a paragraph whose text is exactly "/query"
    const para = page.locator(".block-list .b-paragraph").last();
    await para.click();
    await page.keyboard.type("/todo");
    await expect(page.locator(".slash-menu .slash-item").first()).toBeVisible({ timeout: 10_000 });

    await page.locator(".slash-menu .slash-item", { hasText: "Todo" }).first().click();
    await expect(page.locator(".b-todo")).toBeVisible({ timeout: 10_000 });

    const blocks = await request.get(`/api/v1/objects/${objectId}/blocks`).then((r) => r.json());
    expect(blocks.data.length, "conversion replaces the block, it does not add one").toBe(1);
    expect(blocks.data[0].type).toBe("todo");
  });

  test("Backspace at the start of a block merges into the previous one", async ({ page, request, objectId, seededBlocks }) => {
    const headId = await apiCreateParagraph(request, objectId, "head");
    const tailId = await apiCreateParagraph(request, objectId, "tail");

    await page.goto("/");
    await openObject(page, objectId);

    const tail = blockLocator(page, tailId).locator(".b-paragraph");
    await tail.click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Backspace");

    await expect(page.locator(".block-list [data-block-id]")).toHaveCount(seededBlocks + 1, { timeout: 10_000 });

    const blocks = await request.get(`/api/v1/objects/${objectId}/blocks`).then((r) => r.json());
    expect(blocks.data.length).toBe(seededBlocks + 1);
    expect(blocks.data.map((b: { id: string }) => b.id)).not.toContain(tailId);
    expect(blocks.data.find((b: { id: string }) => b.id === headId).content.text).toContain("tail");
  });

  test("the heading badge cycles H1 -> H2 -> H3 -> H1", async ({ page, request, objectId }) => {
    const blockId = await apiCreateHeading(request, objectId, 1, "Cycling");

    await page.goto("/");
    await openObject(page, objectId);

    const badge = blockLocator(page, blockId).locator(".heading-badge");
    await expect(badge).toHaveText("H1");

    await badge.click();
    await expect(badge).toHaveText("H2");
    await badge.click();
    await expect(badge).toHaveText("H3");
    await badge.click();
    await expect(badge).toHaveText("H1");

    // the level stuck in the database, and the text survived the cycle
    const blocks = await request.get(`/api/v1/objects/${objectId}/blocks`).then((r) => r.json());
    const mine = blocks.data.find((b: { id: string }) => b.id === blockId);
    expect(mine.content.level).toBe(1);
    expect(mine.content.text).toBe("Cycling");
  });

  test("the gutter + button inserts a paragraph between blocks", async ({ page, request, objectId }) => {
    const firstId = await apiCreateParagraph(request, objectId, "top");
    const secondId = await apiCreateParagraph(request, objectId, "bottom");

    await page.goto("/");
    await openObject(page, objectId);

    await blockLocator(page, firstId).locator(".gutter-btn", { hasText: "＋" }).click();

    const blocks = await request.get(`/api/v1/objects/${objectId}/blocks`).then((r) => r.json());
    const ids = blocks.data.map((b: { id: string }) => b.id);
    expect(ids.length).toBe(4);
    // the new block sits directly below the one whose gutter was clicked
    expect(ids[ids.indexOf(firstId) + 1]).not.toBe(secondId);
    expect(ids.indexOf(firstId)).toBeLessThan(ids.indexOf(secondId));
  });

  test("deleting a block removes it; deleting the last one is refused", async ({ page, request, objectId, seededBlocks, firstBlock }) => {
    const keepId = await apiCreateParagraph(request, objectId, "keeper");
    const doomedId = await apiCreateParagraph(request, objectId, "doomed");

    await page.goto("/");
    await openObject(page, objectId);

    await blockLocator(page, doomedId).locator(".gutter-btn", { hasText: "✕" }).click();

    let blocks = await request.get(`/api/v1/objects/${objectId}/blocks`).then((r) => r.json());
    expect(blocks.data.map((b: { id: string }) => b.id)).not.toContain(doomedId);
    expect(blocks.data.map((b: { id: string }) => b.id)).toContain(keepId);

    // delete down to the last remaining block
    await blockLocator(page, keepId).locator(".gutter-btn", { hasText: "✕" }).click();
    blocks = await request.get(`/api/v1/objects/${objectId}/blocks`).then((r) => r.json());
    expect(blocks.data.length).toBe(seededBlocks);

    // now that only one block is left, the UI refuses and tells the user why
    await blockLocator(page, firstBlock).locator(".gutter-btn", { hasText: "✕" }).click();
    await expect(page.locator(".toast:visible")).toContainText(/at least one block/i, { timeout: 10_000 });
    blocks = await request.get(`/api/v1/objects/${objectId}/blocks`).then((r) => r.json());
    expect(blocks.data.length).toBe(seededBlocks);
  });
  test("an empty paragraph is the only state the slash menu opens in", async ({ page, request, objectId }) => {
    // onBlockInput matches /^\/(\S*)$/ — text appended to an existing sentence
    await apiCreateParagraph(request, objectId, "existing sentence");
    await page.goto("/");
    await openObject(page, objectId);

    const para = page.locator(".block-list .b-paragraph").last();
    await para.click();
    await page.keyboard.press("End");
    await page.keyboard.type("/todo");
    await page.waitForTimeout(400);

    expect(await page.locator(".slash-menu:visible .slash-item:visible").count()).toBe(0);

    // a genuinely empty paragraph does open it
    await appendEmptyParagraph(page, request, objectId);
    const fresh = page.locator(".block-list .b-paragraph").last();
    await fresh.click();
    await page.keyboard.type("/todo");
    await expect(page.locator(".slash-menu:visible .slash-item:visible").first()).toBeVisible({ timeout: 10_000 });
  });

  test("moving a block through the API keeps positions dense and unique", async ({ page, request, objectId, firstBlock }) => {
    // The move endpoint is the only legitimate way to reorder; the UI has no
    // drag handler yet, so this pins the contract until one is built.
    const res = await request.post(`/api/v1/objects/${objectId}/blocks/${firstBlock}/move`, {
      data: { position: 1, parentId: null },
    });
    expect(res.ok()).toBe(true);

    const blocks = await request.get(`/api/v1/objects/${objectId}/blocks`).then((r) => r.json());
    const positions = blocks.data.map((b: { position: number }) => b.position);
    expect(positions).toEqual(positions.slice().sort());
    expect(new Set(positions).size).toBe(positions.length);
  });
});

async function apiCreateParagraph(request: APIRequestContext, objectId: string, text: string): Promise<string> {
  const res = await request.post(`/api/v1/objects/${objectId}/blocks`, {
    data: { type: "paragraph", content: { text } },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()).data.id;
}

async function apiCreateHeading(
  request: APIRequestContext,
  objectId: string,
  level: number,
  text: string,
): Promise<string> {
  const res = await request.post(`/api/v1/objects/${objectId}/blocks`, {
    data: { type: "heading", content: { level, text } },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()).data.id;
}
