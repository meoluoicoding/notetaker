import { test, expect, type APIRequestContext } from "@playwright/test";
import { api, firstSpaceId } from "../tests/api";

/**
 * Click-driven feature tests for Projects — everything driven by real UI
 * clicks (no state setup through the API except verifying persistence and
 * cleaning up created objects).
 *
 * The features DB is seeded with 5 projects (Notetaker MVP, Personal Website,
 * Reading Tracker, Learn Rust, Home Automation) that own `status`/`due`.
 */

const SEEDED_PROJECT = "Notetaker MVP";

async function projectStructureId(request: APIRequestContext): Promise<string> {
  const structures = await api<Array<{ id: string; slug: string }>>(request, "/structures");
  const project = structures.find((s) => s.slug === "project");
  if (!project) throw new Error("no Project type seeded");
  return project.id;
}

test("sidebar Project filter shows only project cards", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector(".object-card");

  await page.locator(".sb-scroll .sb-item", { hasText: "Project" }).click();
  await expect(page.locator(".object-card").first()).toBeVisible();

  const typeOf = await page.locator(".object-card .card-type").allTextContents();
  expect(typeOf.length).toBeGreaterThan(0);
  expect(typeOf.every((t) => t.trim() === "Project")).toBeTruthy();

  // the filter highlights the active row
  await expect(page.locator(".sb-scroll .sb-item", { hasText: "Project" })).toHaveClass(/active/);
});

test("clicking a Project card opens it with editable status/due", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector(".object-card");

  await page.locator(".object-card", { hasText: SEEDED_PROJECT }).first().click();
  await expect(page.locator(".page-title")).toHaveText(SEEDED_PROJECT);
  await expect(page.locator(".rp-props")).toBeVisible();

  // seeded project owns status (text input) + due (date input)
  const status = page.locator(".rp-prop", { hasText: "status" }).locator('input[type="text"]');
  const due = page.locator(".rp-prop", { hasText: "due" }).locator('input[type="date"]');
  await expect(status).toHaveValue(/active|paused|done/);
  await expect(due).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
});

test("editing status through the right panel persists to the API", async ({ page, request }) => {
  await page.goto("/");
  await page.waitForSelector(".object-card");
  await page.locator(".object-card", { hasText: SEEDED_PROJECT }).first().click();
  await expect(page.locator(".rp-props")).toBeVisible();

  const status = page.locator(".rp-prop", { hasText: "status" }).locator('input[type="text"]');
  const before = (await status.inputValue()) as "active" | "paused" | "done";
  const next = before === "done" ? "active" : "done";
  try {
    await status.fill(next);
    await status.blur(); // @change -> PATCH /objects/:id/properties

    await expect
      .poll(() =>
        api<{ title: string; properties: Record<string, unknown> }>(request, "/objects").then(
          (objs) => objs.find((o) => o.title === SEEDED_PROJECT)?.properties?.status,
        ),
      )
      .toBe(next);
  } finally {
    // leave the seeded data as it was
    const objects = await api<Array<{ id: string; title: string }>>(request, "/objects");
    const proj = objects.find((o) => o.title === SEEDED_PROJECT);
    if (proj) await api(request, `/objects/${proj.id}/properties`, { method: "PATCH", data: { properties: { status: before } } });
  }
});

test("project cards show status chips at a glance", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector(".object-card");
  await page.locator(".sb-scroll .sb-item", { hasText: "Project" }).click();
  await expect(page.locator(".object-card").first()).toBeVisible();

  // seeded projects render `status: …` / `due: …` property chips on the card
  const chips = await page.locator(".object-card .chip-prop").allTextContents();
  expect(chips.some((c) => /^status: /.test(c))).toBeTruthy();
});

test("creating a Project via the picker + renaming by click", async ({ page, request }) => {
  const title = `Click-created ${Date.now()}`;
  let createdId = "";
  try {
    await page.goto("/");
    await page.waitForSelector(".object-card");

    // Ctrl+N -> click the Project type row -> object is created right away
    await page.keyboard.press("Control+n");
    await expect(page.locator(".picker-overlay")).toBeVisible();
    await page.locator(".picker-row", { hasText: "Project" }).first().click();
    await expect(page.locator(".page-title")).toHaveText("Untitled", { timeout: 10_000 });

    // rename: click the title, select all, type, Enter
    const titleEl = page.locator(".page-title");
    await titleEl.click();
    await page.keyboard.press("Control+a");
    await page.keyboard.type(title);
    await page.keyboard.press("Enter");
    await expect(page.locator(".page-title")).toHaveText(title);

    // verify through the API: exists, is a Project, and the rename stuck
    const objects = await api<Array<{ id: string; title: string; structure_id: string }>>(request, "/objects");
    const mine = objects.find((o) => o.title === title);
    expect(mine).toBeTruthy();
    createdId = mine!.id;
    expect(mine!.structure_id).toBe(await projectStructureId(request));
  } finally {
    if (createdId) await api(request, `/objects/${createdId}`, { method: "DELETE" }).catch(() => undefined);
  }
});