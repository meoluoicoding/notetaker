import { test as base, expect, type APIRequestContext } from "@playwright/test";
import { api, firstSpaceId, pageStructureId, type BlockInput } from "./api";

/**
 * Fixture: a fresh "Page" object belonging to the seeded space, deleted
 * automatically when the test ends. Tests build their block tree through the
 * API and then exercise the UI.
 */
type E2EFixtures = {
  spaceId: string;
  structureId: string;
  objectId: string;
  /** id of the first (empty paragraph) block on the fixture object */
  firstBlock: string;
  /** number of blocks the fixture object starts with (always 1) */
  seededBlocks: number;
  /** create a block on the fixture object */
  addBlock: (input: BlockInput) => Promise<string>;
};

export const test = base.extend<E2EFixtures>({
  spaceId: async ({ request }, use) => {
    await use(await firstSpaceId(request));
  },
  structureId: async ({ request }, use) => {
    await use(await pageStructureId(request, ""));
  },
  objectId: async ({ request, spaceId, structureId }, use) => {
    const created = await api<{ id: string }>(request, "/objects", {
      method: "POST",
      data: {
        spaceId,
        structureId,
        title: "E2E scratch page",
        blocks: [{ type: "paragraph", content: { text: "" } }],
      },
    });
    await use(created.id);
    // leave the database clean: tests must never depend on each other's data
    await api(request, `/objects/${created.id}`, { method: "DELETE" }).catch(() => undefined);
  },

  firstBlock: async ({ request, objectId }, use) => {
    const blocks = await api<Array<{ id: string }>>(request, `/objects/${objectId}/blocks`);
    if (!blocks.length) throw new Error("fixture object has no blocks");
    await use(blocks[0].id);
  },
  seededBlocks: async ({}, use) => {
    await use(1);
  },
});

export { expect };

export { type APIRequestContext };
