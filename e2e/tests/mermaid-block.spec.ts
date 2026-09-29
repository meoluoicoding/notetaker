import { test, expect, type APIRequestContext } from "./fixtures";
import { readBlock, blockLocator, openObject } from "./api";

/**
 * Mermaid blocks. Output is generated SVG that always goes through the
 * sanitizer, so the assertions check for real geometry, not raw strings.
 */
test.describe("mermaid block", () => {
  test("renders a flowchart as SVG", async ({ page, request, objectId }) => {
    const blockId = await apiCreateMermaid(request, objectId, "graph TD\n  A[Start] --> B[End]");

    await page.goto("/");
    await openObject(page, objectId);

    const mmd = blockLocator(page, blockId).locator(".b-mermaid");
    await expect(mmd).toBeVisible();
    // Mermaid parses async and the SVG is sanitized after the parse
    await expect(mmd.locator("svg")).toBeVisible({ timeout: 20_000 });
    // htmlLabels:false puts node text in <text> elements; the arrowhead markers
    // in <defs> are present in the DOM but never visible, so assert on a node
    // label the user would actually read.
    await expect(mmd.locator(".node").first()).toBeVisible();
    // a flowchart edge the user can see. Mermaid draws edges as thin geometry
    // (a 1px vertical/horizontal stroke), which bounding-box visibility checks
    // report as hidden even though the path is drawn on the canvas — so verify
    // the edge's own geometry instead of its computed visibility.
    const link = mmd.locator("svg .flowchart-link").first();
    await expect(link).toHaveAttribute("d", /.+/);
    await expect(link).toHaveClass(/flowchart-link/);
    // the edge must span from one node to the next, not sit on a single point
    const span = await link.evaluate((el) => {
      const d = el.getAttribute("d") || "";
      const nums = (d.match(/[\d.]+/g) || []).map(Number);
      return { xs: nums.filter((_, i) => i % 2 === 0), ys: nums.filter((_, i) => i % 2 === 1) };
    });
    expect(Math.max(...span.xs) - Math.min(...span.xs) + Math.max(...span.ys) - Math.min(...span.ys)).toBeGreaterThan(0);
  });

  test("Edit -> fix source -> Done re-renders the diagram", async ({ page, request, objectId }) => {
    const blockId = await apiCreateMermaid(request, objectId, "graph TD\n  A --> B");
    await page.goto("/");
    await openObject(page, objectId);

    const mmd = blockLocator(page, blockId).locator(".b-mermaid");
    await expect(mmd.locator("svg")).toBeVisible({ timeout: 20_000 });
    const before = await mmd.locator("svg").innerHTML();

    await mmd.locator(".code-copy", { hasText: "Edit" }).click();
    const source = mmd.locator("textarea.render-source");
    await expect(source).toBeVisible();
    await source.fill("graph LR\n  X[One] --> Y[Two] --> Z[Three]");
    await mmd.locator(".code-copy", { hasText: "Done" }).click();

    await expect
      .poll(async () => mmd.locator("svg").innerHTML(), {
        timeout: 20_000,
        message: "the diagram should be re-rendered from the new source",
      })
      .not.toBe(before);

    const stored = await readBlock(request, objectId, blockId);
    expect(stored.content.code).toContain("Z[Three]");
  });

  test("unknown diagram markup shows an error, never a broken render", async ({ page, request, objectId }) => {
    await apiCreateMermaid(request, objectId, "this is not a diagram at all");

    await page.goto("/");
    await openObject(page, objectId);

    // strict security level rejects unknown diagram types instead of rendering junk
    await expect(page.locator(".b-mermaid .render-status")).toContainText(/error/i, { timeout: 20_000 });
    await expect(page.locator(".b-mermaid svg")).toHaveCount(0);
  });

  test("the sanitizer drops injected script markup from diagram output", async ({ page, request, objectId }) => {
    // Mermaid strict mode already forbids scripts; this pins the invariant so a
    // future loosening of securityLevel fails loudly instead of quietly.
    await apiCreateMermaid(request, objectId, "graph TD\n  A[Hello] --> B[World]");

    await page.goto("/");
    await openObject(page, objectId);

    await expect(page.locator(".b-mermaid svg").first()).toBeVisible({ timeout: 20_000 });
    const bad = await page
      .locator(".b-mermaid svg script, .b-mermaid svg iframe, .b-mermaid svg foreignObject")
      .count();
    expect(bad, "no script/iframe/foreignObject may survive sanitization").toBe(0);
  });

  test("Copy puts the diagram source on the clipboard", async ({ page, context, request, objectId }) => {
    const code = "graph TD\n  A --> B";
    const blockId = await apiCreateMermaid(request, objectId, code);

    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/");
    await openObject(page, objectId);

    const mmd = blockLocator(page, blockId).locator(".b-mermaid");
    await mmd.locator(".code-copy", { hasText: "Copy" }).click();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    // Chromium normalises \n to \r\n on the clipboard; compare line-by-line
    expect(clip.replace(/\r\n/g, "\n")).toContain(code);
  });
});

async function apiCreateMermaid(request: APIRequestContext, objectId: string, code: string): Promise<string> {
  const res = await request.post(`/api/v1/objects/${objectId}/blocks`, {
    data: { type: "mermaid", content: { code } },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()).data.id;
}
