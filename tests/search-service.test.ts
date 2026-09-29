import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Point the DB client at a throwaway database BEFORE it is imported.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notetaker-search-"));
process.env.DB_PATH = path.join(tmpDir, "search-test.db");

type SearchServiceModule = typeof import("../src/services/search-service");
type ObjectServiceModule = typeof import("../src/services/object-service");
type StructureServiceModule = typeof import("../src/services/structure-service");
type BlockServiceModule = typeof import("../src/services/block-service");

let searchService: SearchServiceModule["searchService"];
let objectService: ObjectServiceModule["objectService"];
let structureService: StructureServiceModule["structureService"];
let blockService: BlockServiceModule["blockService"];
let closeDb: () => void;

let projectStructureId = "";
let pageStructureId = "";
let spaceId = "";

/** title → object id, filled by createFixtureObject() */
const ids: Record<string, string> = {};
const blockIds: Record<string, string> = {};

async function createFixtureObject(input: Parameters<ObjectServiceModule["objectService"]["createObject"]>[0]) {
  const created = await objectService.createObject({ spaceId, ...input });
  ids[input.title] = created.id;
  if (created.blocks[0]) blockIds[input.title] = created.blocks[0].id;
  return created;
}

const matchTypesOf = (hits: Awaited<ReturnType<SearchServiceModule["searchService"]["search"]>>) =>
  hits.map((h) => h.matchType);

const titlesOf = (hits: Awaited<ReturnType<SearchServiceModule["searchService"]["search"]>>) =>
  hits.map((h) => h.object.title);

beforeAll(async () => {
  const client = await import("../src/db/client");
  await client.migrate();
  closeDb = () => client.rawSqlite.close();

  ({ searchService } = await import("../src/services/search-service"));
  ({ objectService } = await import("../src/services/object-service"));
  ({ structureService } = await import("../src/services/structure-service"));
  ({ blockService } = await import("../src/services/block-service"));

  // One space for the whole fixture; migration creates it on an empty database.
  spaceId = (await (await import("../src/services/space-service")).spaceService.defaultSpaceId());

  const project = await structureService.createStructure({ spaceId, name: "Project", icon: "🚀" });
  const page = await structureService.createStructure({ spaceId, name: "Page", icon: "📄" });
  projectStructureId = project.id;
  pageStructureId = page.id;

  await createFixtureObject({ structureId: project.id, title: "Rust" });
  await createFixtureObject({
    structureId: project.id,
    title: "Rust Ownership",
    blocks: [{ type: "paragraph", content: { text: "Borrow checker and lifetimes in the compiler" } }],
  });
  await createFixtureObject({ structureId: project.id, title: "Learning Rust Daily" });
  await createFixtureObject({
    structureId: project.id,
    title: "Compiler Notes",
    blocks: [
      { type: "paragraph", content: { text: "The borrow checker owns rust memory" } },
      { type: "code", content: { language: "rust", code: "fn main() {}" } },
    ],
  });
  await createFixtureObject({ structureId: project.id, title: "Weekly Digest", tags: ["rust"] });
  await createFixtureObject({ structureId: page.id, title: "Deep Work", description: "Focus and deep work" });
  await createFixtureObject({
    structureId: page.id,
    title: "Bộ nhớ trong Rust",
    blocks: [{ type: "paragraph", content: { text: "Ghi chú tiếng Việt về quản lý bộ nhớ" } }],
  });
  await createFixtureObject({
    structureId: page.id,
    title: "Budget 100%",
    blocks: [{ type: "paragraph", content: { text: "spend 100% of the budget" } }],
  });
  await createFixtureObject({
    structureId: project.id,
    title: "Scratch Pad",
    blocks: [{ type: "paragraph", content: { text: "temporary placeholder text" } }],
  });
});

afterAll(() => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("search ranking", () => {
  it("orders title exact > prefix > substring > body > tag (architect §35)", async () => {
    const hits = await searchService.search("rust");
    const types = matchTypesOf(hits);

    expect(types[0]).toBe("title_exact");
    expect(hits[0].object.title).toBe("Rust");
    expect(types[1]).toBe("title_prefix");
    expect(hits[1].object.title).toBe("Rust Ownership");

    const rank = { title_exact: 0, title_prefix: 1, title_substring: 2, body: 3, tag: 4 };
    const ranks = types.map((t) => rank[t]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));

    const bodyHit = hits.find((h) => h.matchType === "body");
    expect(bodyHit?.object.title).toBe("Compiler Notes");
    const tagHit = hits.find((h) => h.matchType === "tag");
    expect(tagHit?.object.title).toBe("Weekly Digest");
    expect(titlesOf(hits)).toContain("Bộ nhớ trong Rust");
  });

  it("finds body text across multiple terms and returns a marked snippet", async () => {
    const hits = await searchService.search("borrow checker");
    expect(titlesOf(hits)).toContain("Compiler Notes");
    expect(titlesOf(hits)).toContain("Rust Ownership");

    const hit = hits.find((h) => h.object.title === "Compiler Notes")!;
    expect(hit.matchType).toBe("body");
    expect(hit.snippet).toContain("[borrow]");
  });

  it("matches substrings inside a word that FTS5 token prefixing cannot reach", async () => {
    const hits = await searchService.search("heck");
    expect(titlesOf(hits).sort()).toEqual(["Compiler Notes", "Rust Ownership"]);
    expect(matchTypesOf(hits)).toEqual(["body", "body"]);
    expect(hits[0].snippet).toContain("[heck]");
  });

  it("matches the object description as body text", async () => {
    const hits = await searchService.search("focus");
    expect(titlesOf(hits)).toEqual(["Deep Work"]);
    expect(hits[0].matchType).toBe("body");
    expect(hits[0].snippet).toContain("[Focus]");
  });

  it("ignores diacritics when matching Vietnamese text", async () => {
    const hits = await searchService.search("bo nho");
    expect(titlesOf(hits)).toContain("Bộ nhớ trong Rust");
    expect(hits[0].snippet).toBeTruthy();
  });

  it("handles empty and unmatched queries without errors", async () => {
    expect(await searchService.search("   ")).toEqual([]);
    expect(await searchService.search("zzzzqqqq")).toEqual([]);
  });

  it("treats operators and wildcards in a query as plain text", async () => {
    // `%` is escaped in LIKE patterns, so it only matches a literal percent sign.
    expect(titlesOf(await searchService.search("%"))).toEqual(["Budget 100%"]);
    expect(await searchService.search("_")).toEqual([]);
    // Quotes and FTS operators are stripped: they cannot broaden the query.
    expect(await searchService.search('" OR "')).toEqual([]);
    expect(titlesOf(await searchService.search('rust"'))).toContain("Rust");
  });
});

describe("search filters", () => {
  it("restricts hits to a structure", async () => {
    expect(await searchService.search("rust", { structureId: pageStructureId })).toHaveLength(1);
    expect(titlesOf(await searchService.search("rust", { structureId: pageStructureId }))).toEqual([
      "Bộ nhớ trong Rust",
    ]);
    expect(await searchService.search("deep", { structureId: projectStructureId })).toEqual([]);
  });

  it("restricts hits to a tag slug", async () => {
    expect(titlesOf(await searchService.search("rust", { tag: "rust" }))).toEqual(["Weekly Digest"]);
  });

  it("respects the limit", async () => {
    expect(await searchService.search("rust", { limit: 2 })).toHaveLength(2);
  });
});

describe("search index maintenance", () => {
  it("re-indexes when a block changes", async () => {
    const objectId = ids["Compiler Notes"];
    await blockService.updateBlock(objectId, blockIds["Compiler Notes"], {
      content: { text: "The borrow checker owns heap memory" },
    });

    expect(titlesOf(await searchService.search("rust"))).not.toContain("Compiler Notes");
    expect(titlesOf(await searchService.search("borrow"))).toContain("Compiler Notes");
  });

  it("re-indexes when a title changes", async () => {
    await objectService.updateObject(ids["Scratch Pad"], { title: "Renamed Scratch Pad" });
    expect(titlesOf(await searchService.search("scratch"))).toEqual(["Renamed Scratch Pad"]);
    expect(await searchService.search("Renamed Scratch Pad")).toHaveLength(1);
    expect((await searchService.search("Renamed Scratch Pad"))[0].matchType).toBe("title_exact");
  });

  it("re-indexes new blocks added to an object", async () => {
    await blockService.createBlock(ids["Weekly Digest"], {
      type: "paragraph",
      content: { text: "quarterly newsletter checklist" },
    });
    const hits = await searchService.search("newsletter checklist");
    expect(titlesOf(hits)).toEqual(["Weekly Digest"]);
    expect(hits[0].matchType).toBe("body");
  });

  it("drops deleted objects from the index", async () => {
    await objectService.deleteObject(ids["Scratch Pad"]);
    expect(await searchService.search("scratch")).toEqual([]);
    expect(await searchService.search("Renamed Scratch Pad")).toEqual([]);
  });
});
