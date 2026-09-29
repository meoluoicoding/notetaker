import { test, expect, type APIRequestContext } from "./fixtures";
import type { Page } from "@playwright/test";
import { blockLocator, openObject, api } from "./api";

/**
 * Data entry: what a keystroke or a clipboard does to the block list. These are
 * the flows a note app lives or dies on, so every case reads the API back — a
 * DOM that looks right while the database kept the old text is a failing test.
 */
test.describe("data entry", () => {
  test("Enter splits the line at the caret and keeps both halves", async ({ page, request, objectId }) => {
    const blockId = await addBlock(request, objectId, { type: "paragraph", content: { text: "hello world" } });

    await page.goto("/");
    await openObject(page, objectId);

    const para = blockLocator(page, blockId).locator(".b-paragraph");
    await para.click();
    await page.keyboard.press("End");
    for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowLeft"); // caret right after "hello"
    await page.keyboard.press("Enter");

    await expect.poll(async () => (await blocks(request, objectId)).length).toBe(3);

    const rows = await blocks(request, objectId);
    expect(rows[1].id, "the split block stays where it was").toBe(blockId);
    expect(rows[1].content.text).toBe("hello");
    expect(rows[2].type).toBe("paragraph");
    expect(rows[2].content.text, "the text after the caret moved down").toBe(" world");
    await expect.poll(async () => (await caret(page)).blockId, { timeout: 10_000 }).toBe(rows[2].id);
  });

  test("Enter continues a todo, and an empty todo leaves the list", async ({ page, request, objectId }) => {
    const todoId = await addBlock(request, objectId, { type: "todo", content: { text: "first", checked: false } });

    await page.goto("/");
    await openObject(page, objectId);

    const todo = blockLocator(page, todoId).locator(".b-todo span[contenteditable]");
    await todo.click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");

    // the next line is another todo, not a paragraph
    await expect.poll(async () => (await blocks(request, objectId)).length).toBe(3);
    let rows = await blocks(request, objectId);
    expect(rows[2].type).toBe("todo");
    expect(rows[2].content).toMatchObject({ text: "", checked: false });
    // the caret follows the split into the new line (the editor re-renders the
    // list, so a keystroke sent too early would land on the line above)
    await expect.poll(async () => (await caret(page)).blockId).toBe(rows[2].id);

    // Enter on the empty item types its way out of the list
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await blocks(request, objectId)).map((b) => b.type).join(",")).toBe(
      "paragraph,todo,paragraph",
    );
    rows = await blocks(request, objectId);
    expect(rows[2].content.text).toBe("");
    await expect(page.locator(".b-todo")).toHaveCount(1);
  });

  test("Backspace at the start of a list item drops the marker, not the words", async ({ page, request, objectId }) => {
    const itemId = await addBlock(request, objectId, { type: "bulleted_list", content: { text: "keep me" } });

    await page.goto("/");
    await openObject(page, objectId);

    const item = blockLocator(page, itemId).locator(".b-list");
    await item.click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Backspace");

    await expect.poll(async () => (await blocks(request, objectId))[1].type).toBe("paragraph");
    const rows = await blocks(request, objectId);
    expect(rows.length, "unwrapping a marker is not a delete").toBe(2);
    expect(rows[1].content.text).toBe("keep me");
  });

  test("Delete at the end of a line pulls the next block up", async ({ page, request, objectId }) => {
    const headId = await addBlock(request, objectId, { type: "paragraph", content: { text: "head" } });
    const tailId = await addBlock(request, objectId, { type: "paragraph", content: { text: "tail" } });

    await page.goto("/");
    await openObject(page, objectId);

    const head = blockLocator(page, headId).locator(".b-paragraph");
    await head.click();
    await page.keyboard.press("End");
    await page.keyboard.press("Delete");

    await expect.poll(async () => (await blocks(request, objectId)).length).toBe(2);
    const rows = await blocks(request, objectId);
    expect(rows.map((b) => b.id)).not.toContain(tailId);
    expect(rows[1].content.text).toBe("headtail");
    expect((await caret(page)).blockId).toBe(headId);
  });

  test("the arrow keys walk from one block to the next", async ({ page, request, objectId }) => {
    const firstId = await addBlock(request, objectId, { type: "paragraph", content: { text: "alpha" } });
    const secondId = await addBlock(request, objectId, { type: "paragraph", content: { text: "bravo" } });

    await page.goto("/");
    await openObject(page, objectId);

    const first = blockLocator(page, firstId).locator(".b-paragraph");
    await first.click();
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowDown");
    await expect.poll(async () => (await caret(page)).blockId).toBe(secondId);
    expect((await caret(page)).offset, "lands at the start of the next line").toBe(0);

    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowUp");
    await expect.poll(async () => (await caret(page)).blockId).toBe(firstId);
    expect((await caret(page)).offset, "lands at the end of the line above").toBe("alpha".length);

    // inside a line the browser keeps the key: the caret moves, not the block
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowUp");
    expect((await caret(page)).blockId).toBe(firstId);
  });

  test("Enter on a line that owns children only opens a new line", async ({ page, request, objectId }) => {
    const parentId = await addBlock(request, objectId, { type: "paragraph", content: { text: "parent line" } });
    for (const text of ["child one", "child two"]) {
      const res = await request.post(`/api/v1/objects/${objectId}/blocks`, {
        data: { type: "paragraph", content: { text }, parentId },
      });
      expect(res.ok()).toBe(true);
    }
    await addBlock(request, objectId, { type: "paragraph", content: { text: "after the subtree" } });

    await page.goto("/");
    await openObject(page, objectId);

    const beforeIds = new Set((await blocks(request, objectId)).map((b) => b.id));

    // the caret lands mid-text: a split here would cut the parent's sentence
    // around its own children, so Enter only opens a line below the subtree
    const line = blockLocator(page, parentId).locator(".b-paragraph");
    await line.click();
    await page.keyboard.press("End");
    for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowLeft"); // after "parent"
    await page.keyboard.press("Enter");

    await expect.poll(async () => (await blocks(request, objectId)).length).toBe(6);
    const rows = await blocks(request, objectId);
    const parent = rows.find((b) => b.id === parentId)!;
    expect(parent.content.text, "the parent line is left whole").toBe("parent line");
    expect(parent.parentId).toBeNull();

    const added = rows.filter((b) => !beforeIds.has(b.id));
    expect(added.length, "exactly one new line").toBe(1);
    expect(added[0].parentId, "it is a sibling of the parent, not a child").toBeNull();
    expect(added[0].content.text).toBe("");
    expect(rows.filter((b) => b.parentId === parentId).length, "the children stay put").toBe(2);

    // and it is rendered after the whole subtree, not inside it
    const rendered = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".block-list [contenteditable]")).map((el) => el.textContent ?? ""),
    );
    expect(rendered.join(" | ")).toContain("parent line | child one | child two |  | after the subtree");
    await expect.poll(async () => (await caret(page)).blockId).toBe(added[0].id);
  });

  test("pasting a clipboard of blocks builds real blocks", async ({ page, request, objectId, firstBlock }) => {
    await page.goto("/");
    await openObject(page, objectId);

    await blockLocator(page, firstBlock).locator(".b-paragraph").click();
    await pasteInto(page, firstBlock, "# Title\n- [ ] a task\nsay **bold** now");

    await expect.poll(async () => (await blocks(request, objectId)).length).toBe(3);
    const rows = await blocks(request, objectId);
    expect(rows.map((b) => b.type)).toEqual(["heading", "todo", "paragraph"]);
    expect(rows[0].content).toMatchObject({ level: 1, text: "Title" });
    expect(rows[1].content).toMatchObject({ text: "a task", checked: false });
    expect(rows[2].content.text).toBe("say bold now");
    expect(rows[2].content.marks, "markdown inside a pasted line survives").toEqual([
      { type: "bold", from: 4, to: 8 },
    ]);
    // the empty line the paste landed on was taken over, not left behind
    expect(await page.locator(".block-list .b-paragraph:empty").count()).toBe(0);
  });

  test("pasting a single line stays one line", async ({ page, request, objectId, firstBlock }) => {
    await page.goto("/");
    await openObject(page, objectId);

    await blockLocator(page, firstBlock).locator(".b-paragraph").click();
    await pasteInto(page, firstBlock, "just one line");

    await expect.poll(async () => (await blocks(request, objectId))[0].content.text).toBe("just one line");
    expect((await blocks(request, objectId)).length, "one line never becomes several blocks").toBe(1);
  });

  test("a run of numbered blocks counts 1., 2., 3.", async ({ page, request, objectId }) => {
    for (const text of ["one", "two", "three"]) {
      await addBlock(request, objectId, { type: "numbered_list", content: { text } });
    }

    await page.goto("/");
    await openObject(page, objectId);

    const markers = page.locator(".block-numbered_list .b-list.numbered");
    await expect(markers).toHaveCount(3);
    expect(await markers.evaluateAll((els) => els.map((el) => el.getAttribute("data-number")))).toEqual([
      "1", "2", "3",
    ]);
  });

  test("Ctrl+Z brings back a deleted block", async ({ page, request, objectId }) => {
    const keepId = await addBlock(request, objectId, { type: "paragraph", content: { text: "keeper" } });
    const doomedId = await addBlock(request, objectId, { type: "paragraph", content: { text: "doomed" } });

    await page.goto("/");
    await openObject(page, objectId);

    await blockLocator(page, doomedId).locator(".gutter-btn", { hasText: "✕" }).click();
    await expect.poll(async () => (await blocks(request, objectId)).length).toBe(2);

    await blockLocator(page, keepId).locator(".b-paragraph").click();
    await page.keyboard.press("Control+z");

    await expect.poll(async () => (await blocks(request, objectId)).length).toBe(3);
    const rows = await blocks(request, objectId);
    expect(rows.map((b) => b.content.text)).toContain("doomed");
  });
  test("the full form turns markdown into blocks and creates on Ctrl+Enter", async ({ page, request }) => {
    await page.goto("/");

    // Shift+Enter in the object-type picker opens the full form
    await page.evaluate(() => window.Alpine.$data(document.querySelector("[x-data]")!).openTypePicker());
    await page.locator(".picker-input").press("Shift+Enter");
    await expect(page.locator(".modal")).toBeVisible();

    await page.locator(".modal input").first().fill("Entry form page");
    await page
      .locator(".modal textarea")
      .fill(["# From the form", "- a bullet", "1. numbered", "say **bold**", "```js", "const a = 1;", "```"].join("\n"));
    await page.locator(".modal").press("Control+Enter");

    type Row = { id: string; title: string };
    await expect
      .poll(async () => (await api<Row[]>(request, "/objects?limit=50")).some((o) => o.title === "Entry form page"))
      .toBe(true);

    const created = (await api<Row[]>(request, "/objects?limit=50")).find((o) => o.title === "Entry form page")!;
    const rows = await blocks(request, created.id);
    expect(rows.map((b) => b.type)).toEqual(["heading", "bulleted_list", "numbered_list", "paragraph", "code"]);
    expect(rows[0].content).toMatchObject({ level: 1, text: "From the form" });
    expect(rows[1].content.text).toBe("a bullet");
    expect(rows[2].content.text).toBe("numbered");
    expect(rows[3].content).toMatchObject({ text: "say bold", marks: [{ type: "bold", from: 4, to: 8 }] });
    expect(rows[4].content).toMatchObject({ language: "javascript", code: "const a = 1;" });

    // leave the database as the test found it
    await api(request, `/objects/${created.id}`, { method: "DELETE" });
  });
});
async function addBlock(
  request: APIRequestContext,
  objectId: string,
  input: { type: string; content: Record<string, unknown> },
): Promise<string> {
  const res = await request.post(`/api/v1/objects/${objectId}/blocks`, { data: input });
  expect(res.ok()).toBe(true);
  return (await res.json()).data.id;
}

type BlockRow = { id: string; type: string; content: { text?: string; marks?: unknown[] }; position: number };

/** The block list as the API sees it — the only source of truth in these tests. */
async function blocks(request: APIRequestContext, objectId: string): Promise<BlockRow[]> {
  const res = await request.get(`/api/v1/objects/${objectId}/blocks`);
  expect(res.ok()).toBe(true);
  return (await res.json()).data;
}

/** Paste without an OS clipboard: a real paste event carrying a DataTransfer. */
async function pasteInto(page: Page, blockId: string, text: string): Promise<void> {
  await page.evaluate(
    ({ id, value }) => {
      const el = document.querySelector(`[data-block-id="${id}"] [contenteditable]`);
      if (!el) throw new Error(`no editable in block ${id}`);
      (el as HTMLElement).focus();
      const dt = new DataTransfer();
      dt.setData("text/plain", value);
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    { id: blockId, value: text },
  );
}

/** Which block owns the caret, and how far into it the caret sits. */
async function caret(page: Page): Promise<{ blockId: string | null; offset: number }> {
  return page.evaluate(() => {
    const sel = window.getSelection();
    const node = sel?.anchorNode ?? null;
    const el = node ? (node.nodeType === 1 ? (node as Element) : node.parentElement) : null;
    // the editable, not the whole `.block`: gutters and the hidden slash menu are
    // inside the block wrapper and would be counted as text
    const editable = (el?.closest?.("[contenteditable]") ?? null) as HTMLElement | null;
    const block = (el?.closest?.("[data-block-id]") ?? null) as HTMLElement | null;
    let offset = 0;
    if (sel && sel.rangeCount && editable) {
      const live = sel.getRangeAt(0);
      const range = document.createRange();
      range.selectNodeContents(editable);
      range.setEnd(live.endContainer, live.endOffset);
      offset = range.toString().length;
    }
    return { blockId: block?.dataset?.blockId ?? null, offset };
  });
}
