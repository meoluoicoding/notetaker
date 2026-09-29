import { test, expect } from "@playwright/test";
import {
  api,
  firstSpaceId,
  pageStructureId,
  openObject,
  expectEditorReady,
  type APIRequestContext,
} from "../tests/api";

/**
 * Per-snippet code colorscheme ("Aa" button) + theme switch behaviour.
 * The -nt colorscheme follows CSS vars: switching the app theme must NOT
 * recreate the CodeMirror editor (undo/scroll survive).
 */

async function codeObject(request: APIRequestContext, title: string) {
  const spaceId = await firstSpaceId(request);
  const structureId = await pageStructureId(request, spaceId);
  return api<{ id: string }>(request, "/objects", {
    method: "POST",
    data: {
      spaceId,
      structureId,
      title,
      blocks: [{ type: "code", content: { code: "fn main() {\n  println!(\"hi\");\n}", language: "rust" } }],
    },
  });
}

test("Aa cycles auto → dark → light → auto on one snippet", async ({ page, request }) => {
  const created = await codeObject(request, "snippet-theme check");
  try {
    await page.goto("/");
    await page.waitForSelector(".object-card");
    await openObject(page, created.id);
    await expect(page.locator(".b-code .CodeMirror")).toBeVisible();

    const themeOf = () => page.evaluate(() => document.querySelector(".b-code")?.getAttribute("data-snippet-theme"));
    expect(await themeOf()).toBe(""); // auto = follows the app theme

    await page.locator(".b-code .code-theme").click(); // -> dark
    await expect.poll(themeOf).toBe("dark");
    await page.locator(".b-code .code-theme").click(); // -> light
    await expect.poll(themeOf).toBe("light");
    await page.locator(".b-code .code-theme").click(); // -> auto
    await expect.poll(themeOf).toBe("");

    // the choice is persisted in block content, not just the DOM
    const blocks = await api<Array<{ id: string; content: { snippetTheme?: string } }>>(
      request,
      `/objects/${created.id}/blocks`,
    );
    expect(blocks.at(-1)?.content.snippetTheme).toBe("auto");
  } finally {
    await api(request, `/objects/${created.id}`, { method: "DELETE" }).catch(() => undefined);
  }
});

test("switching the app theme keeps the same CodeMirror editor alive", async ({ page, request }) => {
  const created = await codeObject(request, "theme-remount check");
  try {
    await page.goto("/");
    await page.waitForSelector(".object-card");
    await openObject(page, created.id);
    await expect(page.locator(".b-code .CodeMirror")).toBeVisible();

    // normalise the app into a known theme first (a prior failure could leave light)
    const toggle = page.locator('button[title*="Switch to"]').first();
    if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== "dark") {
      await toggle.click();
    }
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");

    // if remountRenderedBlocks rebuilt the editor, this marker would vanish
    await page.evaluate(() => {
      document.querySelector(".b-code .CodeMirror")!.dataset.uid = "persist-check";
    });

    await toggle.click();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");
    await expect(page.locator(".b-code .CodeMirror")).toBeVisible();
    const uidAfterFirst = await page.evaluate(() => document.querySelector(".b-code .CodeMirror")?.dataset.uid);
    expect(uidAfterFirst).toBe("persist-check");

    await toggle.click(); // back to dark
    const uidAfterSecond = await page.evaluate(() => document.querySelector(".b-code .CodeMirror")?.dataset.uid);
    expect(uidAfterSecond).toBe("persist-check");
  } finally {
    await api(request, `/objects/${created.id}`, { method: "DELETE" }).catch(() => undefined);
  }
});