import { test, expect, type APIRequestContext } from "./fixtures";
import { blockLocator, openObject, createBlock, api } from "./api";

/**
 * Reordering: drag & drop, plus Tab / Shift+Tab nesting (AppFlowy/Notion style).
 * Blocks are a tree (`parentId` + per-sibling `position`), so the API — not the
 * DOM — decides whether a move stuck.
 */
test.describe("block reordering", () => {
  test("Tab nests a block under the one above it", async ({ page, request, objectId }) => {
    const first = await seed(request, objectId, "parent line");
    const second = await seed(request, objectId, "child line");

    await page.goto("/");
    await openObject(page, objectId);

    const para = blockLocator(page, second).locator(".b-paragraph");
    await para.click();
    await page.keyboard.press("Tab");

    // the tree is the source of truth: the block now has a parent
    await expect
      .poll(async () => (await blockById(request, objectId, second)).parentId, {
        timeout: 10_000,
        message: "Tab should nest the block under its previous sibling",
      })
      .toBe(first);

    // and it is drawn indented under it
    await expect
      .poll(
        async () =>
          blockLocator(page, second).evaluate((el: HTMLElement) => Number.parseInt(getComputedStyle(el).marginLeft, 10) || 0),
        { timeout: 10_000, message: "the nested block should be indented" },
      )
      .toBeGreaterThan(0);
  });

  test("Shift+Tab promotes a nested block back", async ({ page, request, objectId }) => {
    const first = await seed(request, objectId, "parent line");
    const child = await createBlock(request, objectId, {
      type: "paragraph",
      content: { text: "child line" },
      parentId: first,
    });

    await page.goto("/");
    await openObject(page, objectId);

    await blockLocator(page, child).locator(".b-paragraph").click();
    await page.keyboard.press("Shift+Tab");

    await expect
      .poll(async () => (await blockById(request, objectId, child)).parentId, {
        timeout: 10_000,
        message: "Shift+Tab should promote the block to the top level",
      })
      .toBeNull();
  });

  test("dragging a block onto another reorders it", async ({ page, request, objectId, firstBlock }) => {
    const second = await seed(request, objectId, "second");
    const third = await seed(request, objectId, "third");

    await page.goto("/");
    await openObject(page, objectId);

    const order = async () =>
      (await api<Array<{ id: string }>>(request, `/objects/${objectId}/blocks`)).map((b) => b.id);
    expect(await order()).toEqual([firstBlock, second, third]);

    // drop "third" on the upper half of the first block: it lands above it
    await blockLocator(page, third).locator(".gutter-drag").dragTo(blockLocator(page, firstBlock), {
      targetPosition: { x: 40, y: 2 },
    });

    await expect
      .poll(async () => (await order()).indexOf(third), {
        timeout: 10_000,
        message: "the dragged block should move to the top",
      })
      .toBe(0);
  });

  test("a new line inherits the nesting of the block it follows", async ({ page, request, objectId }) => {
    const first = await seed(request, objectId, "parent line");
    const child = await createBlock(request, objectId, {
      type: "paragraph",
      content: { text: "child line" },
      parentId: first,
    });

    await page.goto("/");
    await openObject(page, objectId);

    // Enter at the end of the nested line: the new line must be its sibling,
    // not a top-level block
    await blockLocator(page, child).locator(".b-paragraph").click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");

    await expect
      .poll(
        async () => {
          const blocks = await api<Array<{ id: string; parentId: string | null; content: { text?: string } }>>(
            request,
            `/objects/${objectId}/blocks`,
          );
          return blocks.filter((b) => b.parentId === first).length;
        },
        { timeout: 10_000, message: "the new line should join the nested sibling list" },
      )
      .toBe(2);
  });
});

async function seed(request: APIRequestContext, objectId: string, text: string): Promise<string> {
  return createBlock(request, objectId, { type: "paragraph", content: { text } });
}

async function blockById(
  request: APIRequestContext,
  objectId: string,
  blockId: string,
): Promise<{ id: string; parentId: string | null }> {
  const blocks = await api<Array<{ id: string; parentId: string | null }>>(request, `/objects/${objectId}/blocks`);
  const hit = blocks.find((b) => b.id === blockId);
  if (!hit) throw new Error(`block ${blockId} is gone`);
  return hit;
}
