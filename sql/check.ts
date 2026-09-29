/**
 * SQL query check — runs EXPLAIN QUERY PLAN for every hot query in the app
 * (see sql/queries.sql for the inventory) against a database of your choice and
 * reports which plans scan or use indexes.
 *
 *   npm run sql:check                          # default: benchmark/benchmark.db
 *   SQL_DB=data/notetaker.db npm run sql:check # your real database
 *
 * Read-only: opens SQLite in readonly mode.
 */
import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";

const dbPath = process.env.SQL_DB ?? path.resolve("benchmark", "benchmark.db");
if (!fs.existsSync(dbPath)) {
  console.error(`db not found: ${dbPath} — run "npm run bench" once to seed a benchmark db, or set SQL_DB.`);
  process.exit(2);
}

const db = new Database(dbPath, { readonly: true });

const SOME_OBJECT_ID = (db.prepare("SELECT id FROM objects LIMIT 1").get() as { id: string } | undefined)?.id ?? "";
const SOME_STRUCTURE_ID = (db.prepare("SELECT id FROM structures LIMIT 1").get() as { id: string } | undefined)?.id ?? "";
const SOME_SPACE_ID = (db.prepare("SELECT id FROM spaces LIMIT 1").get() as { id: string } | undefined)?.id ?? "";

interface QueryDef {
  name: string;
  sql: string;
  params?: unknown[];
  /** SCAN here is expected/correct (FTS5, LIKE fallbacks…) — won't warn. */
  expectedScan?: boolean;
}

const QUERIES: QueryDef[] = [
  {
    name: "listObjects by space",
    sql: `SELECT * FROM objects WHERE space_id = ? ORDER BY updated_at DESC LIMIT 100`,
    params: [SOME_SPACE_ID],
  },
  {
    name: "listObjects by structure",
    sql: `SELECT * FROM objects WHERE structure_id = ? ORDER BY updated_at DESC LIMIT 100`,
    params: [db.prepare("SELECT id FROM structures LIMIT ?").get(1)?.id ?? ""],
  },
  {
    name: "listObjects by tag slug",
    sql: `SELECT objects.* FROM objects JOIN object_tags ON object_tags.object_id = objects.id JOIN tags ON tags.id = object_tags.tag_id WHERE tags.slug = ? AND objects.space_id = ? ORDER BY objects.updated_at DESC LIMIT 100`,
    params: ["rust", SOME_SPACE_ID],
  },
  {
    name: "object meta: blocks by object",
    sql: `SELECT * FROM blocks WHERE object_id = ? ORDER BY position ASC`,
    params: [db.prepare("SELECT id FROM objects LIMIT ?").get(1)?.id ?? ""],
  },
  {
    name: "object meta: properties of object",
    sql: `SELECT property_definitions.name, property_definitions.slug, object_properties.value_json FROM object_properties JOIN property_definitions ON property_definitions.id = object_properties.property_id WHERE object_properties.object_id = ?`,
    params: [db.prepare("SELECT id FROM objects LIMIT ?").get(1)?.id ?? ""],
  },
  {
    name: "blocks count per object (hydrate)",
    sql: `SELECT count(*) AS count FROM blocks WHERE object_id = ?`,
    params: [SOME_OBJECT_ID],
  },
  {
    name: "backlinks (links by target)",
    sql: `SELECT source_object_id FROM links WHERE target_object_id = ?`,
    params: [SOME_OBJECT_ID],
  },
  {
    name: "linked (links by source)",
    sql: `SELECT target_object_id FROM links WHERE source_object_id = ?`,
    params: [SOME_OBJECT_ID],
  },
  {
    name: "FTS5 candidates (MATCH)",
    sql: `SELECT search_index.object_id AS objectId FROM search_index JOIN objects ON objects.id = search_index.object_id WHERE search_index MATCH ? AND objects.space_id = ?`,
    params: ['"rust"* AND "own"*', SOME_SPACE_ID],
    expectedScan: true,
  },
  {
    name: "LIKE fallback: title/description",
    sql: `SELECT * FROM objects WHERE lower(title) LIKE ? ESCAPE '\\' OR lower(coalesce(description,'')) LIKE ? ESCAPE '\\' LIMIT 100`,
    params: ["%rust%", "%rust%"],
    expectedScan: true,
  },
  {
    name: "LIKE fallback: tags",
    sql: `SELECT tags.name FROM tags WHERE lower(tags.name) LIKE ? ESCAPE '\\' LIMIT 100`,
    params: ["%rust%"],
    expectedScan: true,
  },
  {
    name: "search_index body substring",
    sql: `SELECT search_index.object_id AS objectId FROM search_index JOIN objects ON objects.id = search_index.object_id WHERE lower(search_index.body) LIKE ? ESCAPE '\\' AND objects.space_id = ?`,
    params: ["%rust%", SOME_SPACE_ID],
    expectedScan: true,
  },
  {
    name: "tags listing with counts",
    sql: `SELECT tags.id, tags.name, tags.slug, count(object_tags.object_id) AS count FROM tags LEFT JOIN object_tags ON object_tags.tag_id = tags.id WHERE tags.space_id = ? GROUP BY tags.id ORDER BY tags.name ASC`,
    params: [SOME_SPACE_ID],
  },
  {
    name: "daily note (structure + title)",
    sql: `SELECT * FROM objects WHERE structure_id = ? AND title = ? LIMIT 1`,
    params: [SOME_STRUCTURE_ID, "2026-01-01"],
  },
  {
    name: "blocks by parent",
    sql: `SELECT * FROM blocks WHERE object_id = ? AND parent_id = ? ORDER BY position ASC`,
    params: [SOME_OBJECT_ID, null],
  },
];

// ---------- report ----------
console.log(`db: ${dbPath}\n`);
const sizes: string[] = [];
for (const t of ["spaces", "structures", "objects", "blocks", "links", "tags", "object_tags", "object_properties", "property_definitions", "search_index"]) {
  try {
    const row = db.prepare(`SELECT count(*) AS c FROM ${t}`).get() as { c: number };
    sizes.push(`${t}=${row.c}`);
  } catch {
    /* virtual table etc. */
  }
}
console.log(`rows: ${sizes.join("  ")}\n`);

let problems = 0;
for (const q of QUERIES) {
  const explainRows = db.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...(q.params ?? [])) as Array<{ detail: string }>;
  const detail = explainRows.map((r) => r.detail.trim()).join(" | ");
  const isScan = /scan/i.test(detail);
  const warn = isScan && !q.expectedScan;
  if (warn) problems++;
  console.log(`${warn ? "⚠️" : isScan ? "· " : "✅"} ${q.name}`);
  console.log(`    ${detail}`);
}

console.log(`\n${problems === 0 ? "✅ no unexpected full-table scans" : `⚠️ ${problems} query(s) with a possible full-table scan — investigate or annotate as expectedScan`}`);
db.close();
process.exit(problems > 0 ? 1 : 0);