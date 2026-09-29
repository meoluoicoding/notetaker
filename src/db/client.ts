import Sqlite from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import fs from "node:fs";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import type { DB } from "./schema";

const DB_PATH = process.env.DB_PATH ?? path.resolve(process.cwd(), "data", "notetaker.db");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const sqlite = new Sqlite(DB_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = new Kysely<DB>({
  dialect: new SqliteDialect({ database: sqlite }),
});

export const rawSqlite = sqlite;

/** Name/icon of the space created for a database that predates spaces. */
export const DEFAULT_SPACE = { name: "My first brain", icon: "🧠" } as const;

function tableExists(table: string): boolean {
  const row = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name: string } | undefined;
  return Boolean(row);
}

function columnsOf(table: string): string[] {
  if (!tableExists(table)) return [];
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.map((c) => c.name);
}

/** Oldest space wins as "the" space for data written before spaces existed. */
function ensureDefaultSpace(): string {
  const existing = sqlite
    .prepare("SELECT id FROM spaces ORDER BY created_at ASC, id ASC LIMIT 1")
    .get() as { id: string } | undefined;
  if (existing) return existing.id;
  const id = uuidv4();
  const ts = new Date().toISOString();
  sqlite
    .prepare("INSERT INTO spaces (id, name, icon, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, DEFAULT_SPACE.name, DEFAULT_SPACE.icon, ts, ts);
  return id;
}

/**
 * `tags` used to be global (`name`/`slug` UNIQUE across the table). Spaces need
 * per-space uniqueness, and SQLite cannot drop a table constraint in place, so
 * the table is rebuilt and existing rows are handed to the default space.
 */
function rebuildLegacyTags(defaultSpaceId: string): void {
  withoutForeignKeys(() => {
    sqlite.exec("CREATE TABLE tags_migrated (id TEXT PRIMARY KEY, space_id TEXT, name TEXT NOT NULL, slug TEXT NOT NULL)");
    sqlite
      .prepare("INSERT INTO tags_migrated (id, space_id, name, slug) SELECT id, ?, name, slug FROM tags")
      .run(defaultSpaceId);
    sqlite.exec("DROP TABLE tags; ALTER TABLE tags_migrated RENAME TO tags;");
  });
}

/** Same story for `structures.slug`: it was globally UNIQUE, it is now unique per space. */
function rebuildLegacyStructures(defaultSpaceId: string): void {
  withoutForeignKeys(() => {
    sqlite.exec(`
      CREATE TABLE structures_migrated (
        id TEXT PRIMARY KEY,
        space_id TEXT,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        icon TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    sqlite
      .prepare(
        `INSERT INTO structures_migrated (id, space_id, name, slug, icon, created_at, updated_at)
         SELECT id, ?, name, slug, icon, created_at, updated_at FROM structures`
      )
      .run(defaultSpaceId);
    sqlite.exec("DROP TABLE structures; ALTER TABLE structures_migrated RENAME TO structures;");
  });
}

function withoutForeignKeys(run: () => void): void {
  const hadForeignKeys = sqlite.pragma("foreign_keys", { simple: true });
  sqlite.pragma("foreign_keys = OFF");
  try {
    run();
  } finally {
    if (hadForeignKeys) sqlite.pragma("foreign_keys = ON");
  }
}

function tableSql(table: string): string {
  const row = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
    | { sql: string | null }
    | undefined;
  return row?.sql ?? "";
}

/**
 * Hand-rolled migration. It runs on every boot, so every step is idempotent:
 * create what is missing, then bring pre-spaces databases forward.
 */
export async function migrate(): Promise<void> {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS spaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS structures (
      id TEXT PRIMARY KEY,
      space_id TEXT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      icon TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (space_id) REFERENCES spaces(id)
    );

    CREATE TABLE IF NOT EXISTS objects (
      id TEXT PRIMARY KEY,
      structure_id TEXT NOT NULL,
      space_id TEXT,
      title TEXT NOT NULL,
      description TEXT,
      icon TEXT,
      cover_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (structure_id) REFERENCES structures(id),
      FOREIGN KEY (space_id) REFERENCES spaces(id)
    );

    CREATE TABLE IF NOT EXISTS property_definitions (
      id TEXT PRIMARY KEY,
      structure_id TEXT NOT NULL,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      type TEXT NOT NULL,
      FOREIGN KEY (structure_id) REFERENCES structures(id)
    );

    CREATE TABLE IF NOT EXISTS object_properties (
      object_id TEXT NOT NULL,
      property_id TEXT NOT NULL,
      value_json TEXT,
      PRIMARY KEY (object_id, property_id),
      FOREIGN KEY (object_id) REFERENCES objects(id),
      FOREIGN KEY (property_id) REFERENCES property_definitions(id)
    );

    CREATE TABLE IF NOT EXISTS blocks (
      id TEXT PRIMARY KEY,
      object_id TEXT NOT NULL,
      parent_id TEXT,
      position INTEGER NOT NULL,
      type TEXT NOT NULL,
      content_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (object_id) REFERENCES objects(id),
      FOREIGN KEY (parent_id) REFERENCES blocks(id)
    );

    CREATE TABLE IF NOT EXISTS links (
      source_object_id TEXT NOT NULL,
      target_object_id TEXT NOT NULL,
      relation TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (source_object_id, target_object_id, relation)
    );

    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY,
      space_id TEXT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      FOREIGN KEY (space_id) REFERENCES spaces(id)
    );

    CREATE TABLE IF NOT EXISTS object_tags (
      object_id TEXT NOT NULL,
      tag_id TEXT NOT NULL,
      PRIMARY KEY (object_id, tag_id)
    );
  `);

  const defaultSpaceId = ensureDefaultSpace();

  // Pre-spaces databases: add the column, then hand every existing row to the default space.
  for (const table of ["structures", "objects"] as const) {
    if (tableExists(table) && !columnsOf(table).includes("space_id")) {
      sqlite.exec(`ALTER TABLE ${table} ADD COLUMN space_id TEXT`);
    }
  }
  // Table-level UNIQUE constraints cannot be dropped in place: rebuild those two tables.
  if (tableExists("structures") && /slug\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(tableSql("structures"))) {
    rebuildLegacyStructures(defaultSpaceId);
  }
  if (tableExists("tags") && !columnsOf("tags").includes("space_id")) rebuildLegacyTags(defaultSpaceId);

  const backfill = (table: string, column: string) =>
    sqlite.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} IS NULL`).run(defaultSpaceId);
  backfill("structures", "space_id");
  backfill("objects", "space_id");
  backfill("tags", "space_id");

  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_objects_structure ON objects(structure_id);
    CREATE INDEX IF NOT EXISTS idx_objects_updated ON objects(updated_at);
    CREATE INDEX IF NOT EXISTS idx_objects_space ON objects(space_id);
    CREATE INDEX IF NOT EXISTS idx_structures_space ON structures(space_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_structures_space_slug ON structures(space_id, slug);
    CREATE INDEX IF NOT EXISTS idx_tags_space ON tags(space_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_space_name ON tags(space_id, name);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_space_slug ON tags(space_id, slug);
    CREATE INDEX IF NOT EXISTS idx_blocks_object ON blocks(object_id);
    CREATE INDEX IF NOT EXISTS idx_blocks_parent ON blocks(parent_id);
    CREATE INDEX IF NOT EXISTS idx_links_source ON links(source_object_id);
    CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_object_id);
    CREATE INDEX IF NOT EXISTS idx_properties_object ON object_properties(object_id);

    -- Full-text index (FTS5): one row per object = title + description + block text + tags.
    -- External tables stay the source of truth; the project re-indexes on every write.
    CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
      object_id UNINDEXED,
      title,
      body,
      tags,
      tokenize = "unicode61 remove_diacritics 2"
    );
  `);
}
