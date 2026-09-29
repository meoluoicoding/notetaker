import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Sqlite from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Databases written before spaces existed must keep working: the migration adds
 * `space_id`, rebuilds the two tables that carried global UNIQUE constraints,
 * and hands every existing row to one default space.
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notetaker-migrate-"));
const dbPath = path.join(tmpDir, "legacy.db");
process.env.DB_PATH = dbPath;

const LEGACY_SCHEMA = `
  CREATE TABLE structures (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    icon TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE objects (
    id TEXT PRIMARY KEY,
    structure_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    icon TEXT,
    cover_url TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE tags (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    slug TEXT NOT NULL UNIQUE
  );
  CREATE TABLE object_tags (
    object_id TEXT NOT NULL,
    tag_id TEXT NOT NULL,
    PRIMARY KEY (object_id, tag_id)
  );
  CREATE TABLE blocks (
    id TEXT PRIMARY KEY,
    object_id TEXT NOT NULL,
    parent_id TEXT,
    position INTEGER NOT NULL,
    type TEXT NOT NULL,
    content_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE VIRTUAL TABLE search_index USING fts5(
    object_id UNINDEXED, title, body, tags, tokenize = "unicode61 remove_diacritics 2"
  );
`;

const TS = "2026-09-01T10:00:00.000Z";
const STRUCTURE_ID = "11111111-1111-4111-8111-111111111111";
const OBJECT_IDS = ["22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
const TAG_IDS = ["44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555"];
const BLOCK_ID = "66666666-6666-4666-8666-666666666666";

let closeDb: () => void;

beforeAll(() => {
  const legacy = new Sqlite(dbPath);
  legacy.exec(LEGACY_SCHEMA);
  legacy
    .prepare("INSERT INTO structures (id, name, slug, icon, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(STRUCTURE_ID, "Page", "page", "📄", TS, TS);
  for (const [i, id] of OBJECT_IDS.entries()) {
    legacy
      .prepare(
        "INSERT INTO objects (id, structure_id, title, description, icon, cover_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(id, STRUCTURE_ID, `Legacy note ${i + 1}`, null, "📄", null, TS, TS);
  }
  for (const [i, id] of TAG_IDS.entries()) {
    legacy
      .prepare("INSERT INTO tags (id, name, slug) VALUES (?, ?, ?)")
      .run(id, i === 0 ? "rust" : "reading", i === 0 ? "rust" : "reading");
  }
  legacy
    .prepare("INSERT INTO object_tags (object_id, tag_id) VALUES (?, ?)")
    .run(OBJECT_IDS[0], TAG_IDS[0]);
  legacy
    .prepare(
      "INSERT INTO blocks (id, object_id, parent_id, position, type, content_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(BLOCK_ID, OBJECT_IDS[0], null, 0, "paragraph", JSON.stringify({ text: "legacy block text" }), TS, TS);
  legacy
    .prepare("INSERT INTO search_index (object_id, title, body, tags) VALUES (?, ?, ?, ?)")
    .run(OBJECT_IDS[0], "Legacy note 1", "legacy block text", "rust");
  legacy.close();
});

afterAll(() => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("pre-spaces database", () => {
  it("is upgraded in place: one default space owns every legacy row", async () => {
    const client = await import("../src/db/client");
    await client.migrate();
    closeDb = () => client.rawSqlite.close();
    const sqlite = client.rawSqlite;

    const spaces = sqlite.prepare("SELECT * FROM spaces").all() as Array<{ id: string; name: string; icon: string }>;
    expect(spaces).toHaveLength(1);
    expect(spaces[0].name).toBe(client.DEFAULT_SPACE.name);
    const spaceId = spaces[0].id;

    const rows = sqlite
      .prepare(
        `SELECT
           (SELECT count(*) FROM structures WHERE space_id = ?) AS structures,
           (SELECT count(*) FROM objects WHERE space_id = ?) AS objects,
           (SELECT count(*) FROM tags WHERE space_id = ?) AS tags,
           (SELECT count(*) FROM objects WHERE space_id IS NULL) AS orphans,
           (SELECT count(*) FROM structures WHERE space_id IS NULL) AS orphanStructures`
      )
      .get(spaceId, spaceId, spaceId) as Record<string, number>;
    expect(rows).toMatchObject({ structures: 1, objects: 2, tags: 2, orphans: 0, orphanStructures: 0 });

    // Identity and payloads survive the rebuild.
    expect(
      (sqlite.prepare("SELECT id, slug FROM structures").get() as { id: string; slug: string }).id
    ).toBe(STRUCTURE_ID);
    expect(sqlite.prepare("SELECT count(*) AS n FROM object_tags").get()).toEqual({ n: 1 });
    expect(sqlite.prepare("SELECT count(*) AS n FROM blocks").get()).toEqual({ n: 1 });
    expect(sqlite.prepare("SELECT count(*) AS n FROM search_index").get()).toEqual({ n: 1 });
  });

  it("accepts a second space that reuses the same type slug and tag names", async () => {
    const { spaceService } = await import("../src/services/space-service");
    const { structureService } = await import("../src/services/structure-service");
    const sqlite = (await import("../src/db/client")).rawSqlite;

    const second = await spaceService.createSpace({ name: "Second", icon: "🌱" });
    // Two rows share the slug "page" in different spaces — impossible under the old global UNIQUE.
    expect((await structureService.listStructures(second.id)).map((s) => s.slug)).toEqual(["page"]);
    const legacy = (await spaceService.listSpaces()).find((s) => s.name === "My first brain")!;
    expect((await structureService.listStructures(legacy.id)).map((s) => s.slug)).toEqual(["page"]);
    expect(sqlite.prepare("SELECT count(*) AS n FROM structures WHERE slug = 'page'").get()).toEqual({ n: 2 });

    // The global UNIQUE constraints are gone: the same tag name fits in another space.
    expect(() =>
      sqlite
        .prepare("INSERT INTO tags (id, space_id, name, slug) VALUES (?, ?, ?, ?)")
        .run("77777777-7777-4777-8777-777777777777", second.id, "rust", "rust")
    ).not.toThrow();
    expect(() =>
      sqlite
        .prepare("INSERT INTO tags (id, space_id, name, slug) VALUES (?, ?, ?, ?)")
        .run("88888888-8888-4888-8888-888888888888", second.id, "rust", "rust-2")
    ).toThrow(/UNIQUE/);
  });

  it("is idempotent: running the migration again changes nothing", async () => {
    const client = await import("../src/db/client");
    const before = {
      spaces: client.rawSqlite.prepare("SELECT count(*) AS n FROM spaces").get(),
      structures: client.rawSqlite.prepare("SELECT count(*) AS n FROM structures").get(),
      objects: client.rawSqlite.prepare("SELECT count(*) AS n FROM objects").get(),
      tags: client.rawSqlite.prepare("SELECT count(*) AS n FROM tags").get(),
    };

    await client.migrate();
    await client.migrate();

    expect(client.rawSqlite.prepare("SELECT count(*) AS n FROM spaces").get()).toEqual(before.spaces);
    expect(client.rawSqlite.prepare("SELECT count(*) AS n FROM structures").get()).toEqual(before.structures);
    expect(client.rawSqlite.prepare("SELECT count(*) AS n FROM objects").get()).toEqual(before.objects);
    expect(client.rawSqlite.prepare("SELECT count(*) AS n FROM tags").get()).toEqual(before.tags);
    // …and no leftover migration tables.
    const leftovers = client.rawSqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%_migrated'")
      .all();
    expect(leftovers).toEqual([]);
  });

  it("keeps the legacy content searchable inside its space", async () => {
    const { searchService } = await import("../src/services/search-service");
    const { spaceService } = await import("../src/services/space-service");
    const legacySpace = (await spaceService.listSpaces()).find((s) => s.name === "My first brain")!;
    const hits = await searchService.search("legacy block", { spaceId: legacySpace.id });
    expect(hits.map((h) => h.object.title)).toEqual(["Legacy note 1"]);
  });
});
