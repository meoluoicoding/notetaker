import { test, expect, type APIRequestContext } from "@playwright/test";
import { api } from "../tests/api";

/**
 * Settings: appearance (light/dark/system), space settings (rename + counts)
 * and object types (create a custom type, then create objects of its kind).
 */

test("appearance: theme mode switches and persists across reload", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector(".object-card");
  await page.locator(".tb-icon[title*='Settings']").click();
  await page.locator(".theme-card", { hasText: "Light" }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("nt-theme-mode"))).toBe("light");

  await page.reload();
  await page.waitForSelector(".object-card");
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");

  // restore dark so later agents don't inherit a light UI
  await page.locator(".tb-icon[title*='Settings']").click();
  await page.locator(".theme-card", { hasText: "Dark" }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
});

test("space settings: renaming the active space persists via the API", async ({ page, request }) => {
  const spaces = await api<Array<{ id: string; name: string }>>(request, "/spaces");
  const active = spaces[0];
  const renamed = `${active.name}-feature-check`;
  try {
    await page.goto("/");
    await page.waitForSelector(".object-card");
    await page.locator(".tb-icon[title*='Settings']").click();
    await page.locator(".st-item", { hasText: "Space settings" }).click();
    const nameInput = page.locator('input[x-model="spaceForm.name"]');
    await nameInput.fill(renamed);
    await nameInput.blur();
    await expect
      .poll(() => api<Array<{ id: string; name: string }>>(request, "/spaces").then((s) => s[0]?.name))
      .toBe(renamed);
  } finally {
    await api(request, `/spaces/${active.id}`, { method: "PATCH", data: { name: active.name } });
  }
});

test("object types: a custom type is created and objects can be made with it", async ({ page, request }) => {
  const typeName = `Feature Type ${Date.now()}`;
  try {
    await page.goto("/");
    await page.waitForSelector(".object-card");
    await page.locator(".tb-icon[title*='Settings']").click();
    await page.locator(".st-item", { hasText: "Object types" }).click();
    await page.locator(".type-card.create").click();
    await page.locator('input[x-model="typeEditor.name"]').fill(typeName);
    await page.locator('input[x-model="typeEditor.icon"]').fill("🧪");
    await page.locator(".type-editor .btn-primary").click();

    const structures = await api<Array<{ id: string; name: string }>>(request, "/structures");
    const created = structures.find((s) => s.name === typeName);
    expect(created).toBeTruthy();

    // an object of the new type is creatable and searchable list-wise
    const spaces = await api<Array<{ id: string }>>(request, "/spaces");
    const object = await api<{ id: string }>(request, "/objects", {
      method: "POST",
      data: { spaceId: spaces[0].id, structureId: created!.id, title: "first of the type" },
    });
    const byType = await api<Array<{ id: string }>>(request, `/objects?structureId=${created!.id}`);
    expect(byType.some((o) => o.id === object.id)).toBeTruthy();

    // the type editor card shows the new type with its count (scope to the
    // settings pane — the hidden new-object modal holds another .type-grid)
    await expect(page.locator(".settings .type-card", { hasText: typeName })).toBeVisible();
  } finally {
    // best-effort: the type keeps any objects it created, so delete objects first
    const structures = await api<Array<{ id: string; name: string }>>(request, "/structures");
    const created = structures.find((s) => s.name === typeName);
    if (created) {
      const byType = await api<Array<{ id: string }>>(request, `/objects?structureId=${created.id}`);
      for (const o of byType) await api(request, `/objects/${o.id}`, { method: "DELETE" }).catch(() => undefined);
    }
  }
});