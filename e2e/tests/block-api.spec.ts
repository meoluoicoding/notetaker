import { test, expect, type APIRequestContext } from "@playwright/test";

/**
 * Contract tests for the block API the editor talks to. The UI is a thin
 * client: if these invariants break, no amount of frontend code can hide it.
 *
 * Every test creates its own object and deletes it, so tests never depend on
 * each other's data.
 */
test.describe("block API contract", () => {
  test("blocks round-trip their content without loss", async ({ request }) => {
    const { objectId } = await setup(request, "Round trip", [
      { type: "code", content: { language: "rust", code: "fn main() {}" } },
      { type: "math", content: { tex: "\\frac{a}{b}", display: true } },
      { type: "mermaid", content: { code: "graph TD\n  A --> B" } },
      { type: "todo", content: { text: "task", checked: true } },
    ]);

    const blocks = await request.get(`/api/v1/objects/${objectId}/blocks`).then((r) => r.json());
    const byType = new Map(blocks.data.map((b: { type: string; content: unknown }) => [b.type, b.content]));

    expect(byType.get("code")).toEqual({ language: "rust", code: "fn main() {}" });
    expect(byType.get("math")).toEqual({ tex: "\\frac{a}{b}", display: true });
    expect(byType.get("mermaid")).toEqual({ code: "graph TD\n  A --> B" });
    expect(byType.get("todo")).toEqual({ text: "task", checked: true });

    await request.delete(`/api/v1/objects/${objectId}`);
  });

  test("PATCH converts a block type and keeps sibling ordering", async ({ request }) => {
    const { objectId } = await setup(request, "Convert", [
      { type: "paragraph", content: { text: "one" } },
      { type: "paragraph", content: { text: "two" } },
    ]);

    const blocks = await request.get(`/api/v1/objects/${objectId}/blocks`).then((r) => r.json());
    const target = blocks.data[1];
    const res = await request.patch(`/api/v1/objects/${objectId}/blocks/${target.id}`, {
      data: { type: "math", content: { tex: "x^2", display: true } },
    });
    expect(res.ok()).toBe(true);

    const after = await request.get(`/api/v1/objects/${objectId}/blocks`).then((r) => r.json());
    expect(after.data.map((b: { type: string }) => b.type)).toEqual(["paragraph", "math"]);
    expect(after.data[1].id).toBe(target.id);

    await request.delete(`/api/v1/objects/${objectId}`);
  });

  test("moving a block never orphans or duplicates it", async ({ request }) => {
    const { objectId } = await setup(request, "Move", [
      { type: "paragraph", content: { text: "a" } },
      { type: "paragraph", content: { text: "b" } },
      { type: "paragraph", content: { text: "c" } },
    ]);

    const blocks = await request.get(`/api/v1/objects/${objectId}/blocks`).then((r) => r.json());
    expect(blocks.data.length).toBe(3);

    const res = await request.post(`/api/v1/objects/${objectId}/blocks/${blocks.data[0].id}/move`, {
      data: { position: 2, parentId: null },
    });
    expect(res.ok()).toBe(true);

    const after = await request.get(`/api/v1/objects/${objectId}/blocks`).then((r) => r.json());
    const positions = after.data.map((b: { position: number }) => b.position);
    expect(positions).toEqual([0, 1, 2]);
    expect(new Set(after.data.map((b: { id: string }) => b.id)).size).toBe(3);

    await request.delete(`/api/v1/objects/${objectId}`);
  });

  test("renderer block text is searchable", async ({ request }) => {
    const needle = `uniqueToken${Date.now()}`;
    const { objectId } = await setup(request, `Search ${needle}`, [
      { type: "code", content: { language: "plaintext", code: needle } },
    ]);

    const hits = await request.get(`/api/v1/search?q=${encodeURIComponent(needle)}`).then((r) => r.json());
    const found = hits.data.some((h: { object: { id: string } }) => h.object.id === objectId);
    expect(found, "code block content must be indexed for search").toBe(true);

    await request.delete(`/api/v1/objects/${objectId}`);
  });

  test("an unknown block type is rejected at the boundary", async ({ request }) => {
    const { objectId } = await setup(request, "Reject", []);

    const res = await request.post(`/api/v1/objects/${objectId}/blocks`, {
      data: { type: "slide", content: {} },
    });
    expect(res.ok()).toBe(false);
    const body = await res.json();
    expect(body.error?.code).toBeTruthy();

    await request.delete(`/api/v1/objects/${objectId}`);
  });

  test("deleting a block closes the position gap it leaves behind", async ({ request }) => {
    const { objectId } = await setup(request, "Delete gap", [
      { type: "paragraph", content: { text: "one" } },
      { type: "paragraph", content: { text: "two" } },
      { type: "paragraph", content: { text: "three" } },
    ]);

    const blocks = await request.get(`/api/v1/objects/${objectId}/blocks`).then((r) => r.json());
    const middle = blocks.data[1];

    const res = await request.delete(`/api/v1/objects/${objectId}/blocks/${middle.id}`);
    expect(res.ok()).toBe(true);

    const after = await request.get(`/api/v1/objects/${objectId}/blocks`).then((r) => r.json());
    expect(after.data.map((b: { id: string }) => b.id)).not.toContain(middle.id);
    // positions stay dense: no hole where the deleted block used to be
    expect(after.data.map((b: { position: number }) => b.position)).toEqual([0, 1]);

    await request.delete(`/api/v1/objects/${objectId}`);
  });
});

/** Create a throwaway object with the given blocks. Caller deletes it. */
async function setup(
  request: APIRequestContext,
  title: string,
  blocks: Array<{ type: string; content: Record<string, unknown> }>,
): Promise<{ objectId: string }> {
  const spaceId = await firstSpace(request);
  const structureId = await pageStructure(request);
  const res = await request.post("/api/v1/objects", {
    data: { spaceId, structureId, title, blocks },
  });
  expect(res.ok()).toBe(true);
  return { objectId: (await res.json()).data.id };
}

async function firstSpace(request: APIRequestContext): Promise<string> {
  const body = await request.get("/api/v1/spaces").then((r) => r.json());
  if (!body.data?.length) throw new Error("no spaces seeded");
  return body.data[0].id;
}

async function pageStructure(request: APIRequestContext): Promise<string> {
  const body = await request.get("/api/v1/structures").then((r) => r.json());
  return (body.data.find((s: { slug: string }) => s.slug === "page") ?? body.data[0]).id;
}
