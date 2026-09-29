import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point the DB client at a throwaway database BEFORE it is imported.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notetaker-space-"));
process.env.DB_PATH = path.join(tmpDir, "space-test.db");

type SpaceServiceModule = typeof import("../src/services/space-service");
type StructureServiceModule = typeof import("../src/services/structure-service");
type ObjectServiceModule = typeof import("../src/services/object-service");
type TagServiceModule = typeof import("../src/services/tag-service");
type SearchServiceModule = typeof import("../src/services/search-service");

let spaceService: SpaceServiceModule["spaceService"];
let structureService: StructureServiceModule["structureService"];
let objectService: ObjectServiceModule["objectService"];
let tagService: TagServiceModule["tagService"];
let searchService: SearchServiceModule["searchService"];
let closeDb: () => void;

let spaceA = "";
let spaceB = "";
let spaceC = "";
let objectInA = "";
let objectInB = "";

beforeAll(async () => {
  const client = await import("../src/db/client");
  await client.migrate();
  closeDb = () => client.rawSqlite.close();
  ({ spaceService } = await import("../src/services/space-service"));
  ({ structureService } = await import("../src/services/structure-service"));
  ({ objectService } = await import("../src/services/object-service"));
  ({ tagService } = await import("../src/services/tag-service"));
  ({ searchService } = await import("../src/services/search-service"));

  spaceA = await spaceService.defaultSpaceId();
  const created = await spaceService.createSpace({ name: "Work", icon: "💼" });
  spaceB = created.id;
  spaceC = (await spaceService.createSpace({ name: "Throwaway" })).id;

  const typeA = await structureService.createStructure({ spaceId: spaceA, name: "Project", icon: "🚀" });
  const typeB = await structureService.createStructure({ spaceId: spaceB, name: "Project", icon: "🚀" });

  objectInA = (
    await objectService.createObject({
      spaceId: spaceA,
      structureId: typeA.id,
      title: "Rust notes",
      tags: ["rust"],
      blocks: [{ type: "paragraph", content: { text: "Borrow checker everywhere" } }],
    })
  ).id;

  objectInB = (
    await objectService.createObject({
      spaceId: spaceB,
      structureId: typeB.id,
      title: "Rust at work",
      tags: ["rust"],
      blocks: [{ type: "paragraph", content: { text: "Borrow checker at work" } }],
    })
  ).id;
});

afterAll(() => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("spaces", () => {
  it("comes from migration with exactly one default space", async () => {
    const spaces = await spaceService.listSpaces();
    expect(spaces).toHaveLength(3); // default + Work + Throwaway
    const first = spaces[0];
    expect(first.id).toBe(spaceA);
    expect(first.name).toBe("My first brain");
    expect(first.objectCount).toBe(1);
    expect(first.typeCount).toBe(1);
  });

  it("creates a space that is usable straight away (one seeded object type)", async () => {
    const created = await spaceService.createSpace({ name: "Journal", icon: "📓" });
    const types = await structureService.listStructures(created.id);
    expect(types).toHaveLength(1);
    expect(types[0]).toMatchObject({ name: "Page", slug: "page", icon: "📄", space_id: created.id });
    expect((await spaceService.getSpace(created.id))?.objectCount).toBe(0);

    await spaceService.deleteSpace(created.id); // empty space deletes without a fight
    expect(await spaceService.spaceExists(created.id)).toBe(false);
  });

  it("renames a space and reports unknown ids as null", async () => {
    const renamed = await spaceService.updateSpace(spaceC, { name: "Renamed space", icon: "🌱" });
    expect(renamed).toMatchObject({ id: spaceC, name: "Renamed space", icon: "🌱" });
    expect(await spaceService.updateSpace("3a63d1d1-0000-4000-8000-000000000000", { name: "Nope" })).toBeNull();
  });

  it("keeps objects, types and tags strictly inside their space", async () => {
    const inA = await objectService.listObjects({ spaceId: spaceA });
    const inB = await objectService.listObjects({ spaceId: spaceB });
    expect(inA.map((o) => o.title)).toEqual(["Rust notes"]);
    expect(inB.map((o) => o.title)).toEqual(["Rust at work"]);
    expect(inA[0].space_id).toBe(spaceA);
    expect(inB[0].space_id).toBe(spaceB);

    // No filter = every space (used by migration/CLI tooling, not the app).
    expect((await objectService.listObjects()).length).toBeGreaterThanOrEqual(2);

    expect((await structureService.listStructures(spaceC)).map((s) => s.name)).toEqual(["Page"]);
  });

  it("keeps same-named tags independent per space", async () => {
    const tagsA = await tagService.listTags(spaceA);
    const tagsB = await tagService.listTags(spaceB);
    expect(tagsA).toHaveLength(1);
    expect(tagsB).toHaveLength(1);
    expect(tagsA[0]).toMatchObject({ name: "rust", count: 1 });
    expect(tagsB[0]).toMatchObject({ name: "rust", count: 1 });
    expect(tagsA[0].id).not.toBe(tagsB[0].id);
    expect(await tagService.listTags(spaceC)).toEqual([]);
  });

  it("scopes search to the active space", async () => {
    const scopedA = await searchService.search("rust", { spaceId: spaceA });
    expect(scopedA.map((h) => h.object.title)).toEqual(["Rust notes"]);

    const scopedB = await searchService.search("rust", { spaceId: spaceB });
    expect(scopedB.map((h) => h.object.title)).toEqual(["Rust at work"]);

    const everywhere = await searchService.search("rust");
    expect(everywhere.map((h) => h.object.title).sort()).toEqual(["Rust at work", "Rust notes"]);
  });

  it("refuses an object whose type lives in another space", async () => {
    const foreignStructure = (await structureService.listStructures(spaceB))[0];
    await expect(
      objectService.createObject({ spaceId: spaceA, structureId: foreignStructure.id, title: "Leak" })
    ).rejects.toMatchObject({ code: "STRUCTURE_NOT_FOUND" });
  });

  it("refuses links that would cross spaces", async () => {
    await expect(objectService.createLink(objectInA, objectInB, "mentions")).rejects.toMatchObject({
      code: "LINK_TARGET_NOT_FOUND",
    });
    const sibling = await objectService.createObject({
      spaceId: spaceA,
      structureId: (await structureService.listStructures(spaceA))[0].id,
      title: "Second note in A",
    });
    await objectService.createLink(objectInA, sibling.id, "mentions");
    expect((await objectService.getLinkedObjects(objectInA)).map((o) => o.title)).toEqual(["Second note in A"]);
  });

  it("never deletes a space that still holds objects, unless forced", async () => {
    await expect(spaceService.deleteSpace(spaceB)).rejects.toMatchObject({ code: "SPACE_NOT_EMPTY" });
    expect(await spaceService.spaceExists(spaceB)).toBe(true);

    expect(await spaceService.deleteSpace(spaceB, { force: true })).toBe(true);
    expect(await spaceService.spaceExists(spaceB)).toBe(false);
    expect(await objectService.getFullObject(objectInB)).toBeNull();
    expect(await structureService.listStructures(spaceB)).toEqual([]);
    expect(await tagService.listTags(spaceB)).toEqual([]);
    expect(await searchService.search("work", { spaceId: spaceB })).toEqual([]);

    // …and the surviving space is untouched.
    expect((await objectService.listObjects({ spaceId: spaceA })).map((o) => o.title).sort()).toEqual([
      "Rust notes",
      "Second note in A",
    ]);
  });

  it("keeps the last space alive", async () => {
    expect(await spaceService.deleteSpace(spaceC)).toBe(true); // empty space, no force needed
    await expect(spaceService.deleteSpace(spaceA)).rejects.toMatchObject({ code: "LAST_SPACE_REMAINING" });
    expect(await spaceService.listSpaces()).toHaveLength(1);
    expect(await spaceService.deleteSpace("3a63d1d1-0000-4000-8000-000000000000")).toBe(false);
  });
});
