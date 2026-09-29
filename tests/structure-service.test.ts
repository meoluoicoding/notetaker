import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { updateStructureSchema } from "../src/shared/schemas";

// Point the DB client at a throwaway database BEFORE it is imported.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notetaker-structure-"));
process.env.DB_PATH = path.join(tmpDir, "structure-test.db");

type StructureServiceModule = typeof import("../src/services/structure-service");
type SpaceServiceModule = typeof import("../src/services/space-service");

let structureService: StructureServiceModule["structureService"];
let spaceService: SpaceServiceModule["spaceService"];
let closeDb: () => void;
let spaceId = "";

beforeAll(async () => {
  const client = await import("../src/db/client");
  await client.migrate();
  closeDb = () => client.rawSqlite.close();
  ({ structureService } = await import("../src/services/structure-service"));
  ({ spaceService } = await import("../src/services/space-service"));
  spaceId = await spaceService.defaultSpaceId();
});

afterAll(() => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("structure service", () => {
  it("creates a type with a slug derived from its name", async () => {
    const created = await structureService.createStructure({ spaceId, name: "Reading List", icon: "📚" });
    expect(created.slug).toBe("reading-list");
    expect(created.icon).toBe("📚");
    expect(created.space_id).toBe(spaceId);
    expect(created.id).toBeTruthy();
  });

  it("keeps slugs unique inside a space instead of failing on a duplicate name", async () => {
    const first = await structureService.createStructure({ spaceId, name: "Idea" });
    const second = await structureService.createStructure({ spaceId, name: "Idea" });
    expect(second.slug).not.toBe(first.slug);
    expect(second.slug.startsWith("idea-")).toBe(true);
  });

  it("renames a type, following the slug, without changing its identity", async () => {
    const created = await structureService.createStructure({ spaceId, name: "Project", icon: "🚀" });
    const updated = await structureService.updateStructure(created.id, { name: "Projects", icon: "🗂️" });

    expect(updated?.id).toBe(created.id);
    expect(updated?.name).toBe("Projects");
    expect(updated?.slug).toBe("projects");
    expect(updated?.icon).toBe("🗂️");
    expect(updated?.created_at).toBe(created.created_at);
    expect(updated && updated.updated_at >= created.updated_at).toBe(true);
  });

  it("changes only the icon when the name is omitted", async () => {
    const created = await structureService.createStructure({ spaceId, name: "Topic", icon: "💡" });
    const updated = await structureService.updateStructure(created.id, { icon: "🔖" });
    expect(updated?.name).toBe("Topic");
    expect(updated?.slug).toBe("topic");
    expect(updated?.icon).toBe("🔖");
  });

  it("clears the icon when null is passed", async () => {
    const created = await structureService.createStructure({ spaceId, name: "Note", icon: "📝" });
    const updated = await structureService.updateStructure(created.id, { icon: null });
    expect(updated?.icon).toBeNull();
  });

  it("does not steal the slug of another type inside the same space when renaming", async () => {
    const taken = await structureService.createStructure({ spaceId, name: "Journey" });
    const other = await structureService.createStructure({ spaceId, name: "Misc" });
    const renamed = await structureService.updateStructure(other.id, { name: "Journey" });

    expect(taken.slug).toBe("journey");
    expect(renamed?.slug).not.toBe(taken.slug);
    expect(renamed?.slug.startsWith("journey-")).toBe(true);
    expect((await structureService.getStructure(taken.id))?.slug).toBe("journey");
  });

  it("returns null for an unknown type and leaves the table untouched", async () => {
    const before = await structureService.listStructures(spaceId);
    expect(await structureService.updateStructure("3a63d1d1-0000-4000-8000-000000000000", { name: "Nope" })).toBeNull();
    expect(await structureService.listStructures(spaceId)).toHaveLength(before.length);
  });

  it("lists types of one space by name (§64 stable ordering)", async () => {
    const names = (await structureService.listStructures(spaceId)).map((s) => s.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it("refuses to create a type in a space that does not exist", async () => {
    await expect(
      structureService.createStructure({ spaceId: "3a63d1d1-0000-4000-8000-000000000000", name: "Ghost" })
    ).rejects.toMatchObject({ code: "SPACE_NOT_FOUND" });
  });

  it("lets two spaces own a type with the same name and slug", async () => {
    const other = await spaceService.createSpace({ name: "Second brain" });
    const inFirst = await structureService.createStructure({ spaceId, name: "Alpha" });
    const inSecond = await structureService.createStructure({ spaceId: other.id, name: "Alpha" });

    expect(inFirst.slug).toBe("alpha");
    expect(inSecond.slug).toBe("alpha");
    expect(inSecond.space_id).toBe(other.id);
    expect(await structureService.listStructures(other.id)).toHaveLength(2); // seeded Page + Alpha
    // …while the first space keeps its own Alpha
    const firstSpaceAlphas = (await structureService.listStructures(spaceId)).filter((s) => s.name === "Alpha");
    expect(firstSpaceAlphas).toHaveLength(1);
    expect(firstSpaceAlphas[0].id).not.toBe(inSecond.id);
  });
});

describe("structure update payload", () => {
  it("rejects an empty rename but accepts a partial patch", () => {
    expect(updateStructureSchema.safeParse({ name: "" }).success).toBe(false);
    expect(updateStructureSchema.safeParse({ icon: "🚀" }).success).toBe(true);
    expect(updateStructureSchema.safeParse({ icon: null }).success).toBe(true);
    expect(updateStructureSchema.safeParse({ name: "x".repeat(201) }).success).toBe(false);
  });
});
