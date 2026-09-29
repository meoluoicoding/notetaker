import { test, expect, type APIRequestContext } from "@playwright/test";
import { api, firstSpaceId } from "../tests/api";

/**
 * Properties are the Project's core function: status/due set once at seed are
 * dead data unless the right panel can edit them and the edit persists to the
 * API. This spec drives the right-panel property editors directly.
 */

async function projectStructureId(request: APIRequestContext): Promise<string> {
  const structures = await api<Array<{ id: string; slug: string }>>(request, "/structures");
  const project = structures.find((s) => s.slug === "project");
  if (!project) throw new Error("no Project type in the seed");
  return project.id;
}

test("editing status on a Project persists through the API", async ({ page, request }) => {
  const spaceId = await firstSpaceId(request);
  const structureId = await projectStructureId(request);
  const created = await api<{ id: string }>(request, "/objects", {
    method: "POST",
    data: {
      spaceId,
      structureId,
      title: "status-edit check",
      properties: { status: "active", due: "2026-10-15" },
    },
  });
  try {
    await page.goto("/");
    await page.waitForSelector(".object-card");
    await page.evaluate((id) => window.Alpine.$data(document.querySelector("[x-data]")!).openObject(id), created.id);
    await expect(page.locator(".rp-props")).toBeVisible();

    // the seeded definitions render as controls (status -> text input, due -> date)
    const statusInput = page.locator(".rp-prop", { hasText: "status" }).locator('input[type="text"]');
    const dueInput = page.locator(".rp-prop", { hasText: "due" }).locator('input[type="date"]');
    await expect(statusInput).toHaveValue("active");
    await expect(dueInput).toHaveValue("2026-10-15");

    // edit status; blur fires the change -> PATCH /objects/:id/properties
    await statusInput.fill("done");
    await statusInput.blur();

    await expect
      .poll(() =>
        api<{ properties: Record<string, unknown> }>(request, `/objects/${created.id}`).then((o) => o.properties?.status),
      )
      .toBe("done");

    // re-open to confirm the date survived; scope the card locator to the
    // settings pane (the hidden new-object modal holds another .type-grid)
    await page.evaluate((id) => window.Alpine.$data(document.querySelector("[x-data]")!).openObject(id), created.id);
    await expect(page.locator('.rp-prop', { hasText: "due" }).locator('input[type="date"]')).toHaveValue("2026-10-15");
  } finally {
    await api(request, `/objects/${created.id}`, { method: "DELETE" }).catch(() => undefined);
  }
});