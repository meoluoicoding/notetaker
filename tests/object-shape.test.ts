import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The object list the API hands the client carries the DB's column names
 * (structure_id, space_id, parent_id …), never a camelCase remap — skill.md
 * makes that an invariant. The daily-note lookup once read `structureId`, which
 * is undefined on every row, so the filter was empty and "Today's note" created
 * a duplicate daily object on every click. This pins the row shape the client
 * relies on.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notetaker-object-shape-"));
process.env.DB_PATH = path.join(tmpDir, "object-shape-test.db");

let objectService: typeof import("../src/services/object-service").objectService;
let structureService: typeof import("../src/services/structure-service").structureService;
let spaceService: typeof import("../src/services/space-service").spaceService;
let closeDb: () => void;

let spaceId = "";
let structureId = "";
let objectId = "";

beforeAll(async () => {
  const client = await import("../src/db/client");
  await client.migrate();
  closeDb = () => client.rawSqlite.close();

  ({ objectService } = await import("../src/services/object-service"));
  ({ structureService } = await import("../src/services/structure-service"));
  ({ spaceService } = await import("../src/services/space-service"));

  spaceId = await spaceService.defaultSpaceId();
  const structure = await structureService.createStructure({ spaceId, name: "Daily Note", icon: "📅" });
  structureId = structure.id;
  const created = await objectService.createObject({
    spaceId,
    structureId,
    title: "2026-09-18",
    blocks: [{ type: "paragraph", content: { text: "" } }],
  });
  objectId = created.id;
});

afterAll(() => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("object row shape for the client", () => {
  it("lists objects with the DB column names, not a camelCase remap", async () => {
    const rows = await objectService.listObjects({ spaceId });
    const mine = rows.find((o) => o.id === objectId);
    expect(mine).toBeTruthy();

    // the daily-note lookup filters on this exact field
    expect(mine!.structure_id).toBe(structureId);
    expect(mine!.space_id).toBe(spaceId);
  });

  it("lets the daily-note lookup find an existing note instead of duplicating it", async () => {
    const rows = await objectService.listObjects({ spaceId });
    // this is the filter openToday() runs; it used to be `.structureId`
    const daily = rows.filter((o) => o.structure_id === structureId);
    expect(daily.map((o) => o.title)).toContain("2026-09-18");
    expect(daily.filter((o) => o.title === "2026-09-18")).toHaveLength(1);
  });

  it("serializes blocks with the same DB column names", async () => {
    const full = await objectService.getFullObject(objectId);
    expect(full).toBeTruthy();
    const block = full!.blocks[0];
    expect(block.object_id).toBe(objectId);
    expect(block.parent_id).toBeNull();
  });
});
