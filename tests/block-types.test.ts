import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point the DB client at a throwaway database BEFORE it is imported.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notetaker-blocks-"));
process.env.DB_PATH = path.join(tmpDir, "blocks-test.db");

let objectService: typeof import("../src/services/object-service").objectService;
let blockService: typeof import("../src/services/block-service").blockService;
let structureService: typeof import("../src/services/structure-service").structureService;
let blockTypeSchema: typeof import("../src/shared/schemas").blockTypeSchema;
let closeDb: () => void;

let objectId = "";
let structureId = "";
let spaceId = "";

beforeAll(async () => {
  const client = await import("../src/db/client");
  await client.migrate();
  closeDb = () => client.rawSqlite.close();

  ({ objectService } = await import("../src/services/object-service"));
  ({ blockService } = await import("../src/services/block-service"));
  ({ structureService } = await import("../src/services/structure-service"));
  ({ blockTypeSchema } = await import("../src/shared/schemas"));

  spaceId = await (await import("../src/services/space-service")).spaceService.defaultSpaceId();
  const structure = await structureService.createStructure({ spaceId, name: "Page", icon: "📄" });
  structureId = structure.id;
  const created = await objectService.createObject({
    spaceId,
    structureId: structure.id,
    title: "Renderer playground",
    blocks: [
      { type: "paragraph", content: { text: "intro" } },
      { type: "code", content: { language: "javascript", code: "const x = 1;" } },
      { type: "math", content: { tex: "E = mc^2", display: true } },
      { type: "mermaid", content: { code: "graph TD\n  A --> B" } },
      { type: "plantuml", content: { code: "@startuml\nAlice -> Bob: hello\n@enduml" } },
      { type: "d2", content: { code: "a -> b: hello" } },
      { type: "whiteboard", content: { snapshot: null } },
    ],
  });
  objectId = created.id;
});

afterAll(() => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("block types", () => {
  it("accepts the slash-menu block types (code, math, mermaid, plantuml, d2, whiteboard)", () => {
    expect(blockTypeSchema.options).toContain("mermaid");
    for (const type of ["paragraph", "heading", "todo", "quote", "code", "math", "mermaid", "plantuml", "d2", "whiteboard", "divider"]) {
      expect(blockTypeSchema.safeParse(type).success, type).toBe(true);
    }
    expect(blockTypeSchema.safeParse("slide").success).toBe(false);
  });

  it("round-trips renderer block content", async () => {
    const object = await objectService.getFullObject(objectId);
    const byType = new Map(object!.blocks.map((b) => [b.type, b]));
    expect(byType.size).toBe(7);
    expect(JSON.parse(byType.get("code")!.content_json)).toEqual({ language: "javascript", code: "const x = 1;" });
    expect(JSON.parse(byType.get("math")!.content_json)).toEqual({ tex: "E = mc^2", display: true });
    expect(JSON.parse(byType.get("mermaid")!.content_json)).toEqual({ code: "graph TD\n  A --> B" });
    expect(JSON.parse(byType.get("plantuml")!.content_json)).toEqual({ code: "@startuml\nAlice -> Bob: hello\n@enduml" });
    expect(JSON.parse(byType.get("d2")!.content_json)).toEqual({ code: "a -> b: hello" });
    expect(JSON.parse(byType.get("whiteboard")!.content_json)).toEqual({ snapshot: null });
  });

  it("converts a paragraph into a math block (what the slash menu does)", async () => {
    const added = await blockService.createBlock(objectId, { type: "paragraph", content: { text: "/latex" } });
    const converted = await blockService.updateBlock(objectId, added.id, {
      type: "math",
      content: { tex: "\\int_0^1 x^2 dx", display: true },
    });
    expect(converted?.type).toBe("math");
    expect(JSON.parse(converted!.content_json).tex).toBe("\\int_0^1 x^2 dx");

    const reloaded = await blockService.getBlock(objectId, added.id);
    expect(reloaded?.type).toBe("math");
  });

  it("indexes renderer block text for search", async () => {
    const { searchService } = await import("../src/services/search-service");
    const hits = await searchService.search("mc^2");
    expect(hits.map((h) => h.object.title)).toContain("Renderer playground");

    const updates = await blockService.updateBlock(
      objectId,
      (await blockService.listBlocks(objectId)).find((b) => b.type === "code")!.id,
      { content: { language: "rust", code: "fn owned_pointer() {}" } }
    );
    expect(updates?.type).toBe("code");
    expect((await searchService.search("owned_pointer")).map((h) => h.object.id)).toContain(objectId);
  });

  it("keeps object structural fields when a block is converted", async () => {
    const object = await objectService.getObject(objectId);
    expect(object?.structure_id).toBe(structureId);
    expect(object?.blockCount).toBe(8);
  });
});
