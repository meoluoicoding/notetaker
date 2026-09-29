/**
 * Benchmark harness — measures the REAL stack (Kysely + SQLite + services +
 * optional native Tantivy) against a scratch database, so it never touches
 * your notes in data/notetaker.db.
 *
 *   npm run bench                # default: seed 300 objects in benchmark/benchmark.db
 *   BENCH_N=1000 npm run bench   # scale up
 *   BENCH_DB=/path/x.db npm run bench
 *
 * Results: console table + benchmark/results/<timestamp>.json + latest.json.
 */
import { performance } from "node:perf_hooks";
import path from "node:path";
import fs from "node:fs";

const BENCH_DB = process.env.BENCH_DB ?? path.resolve("benchmark", "benchmark.db");
const N_OBJECTS = Number(process.env.BENCH_N || 300);

// MUST be set before the db services are imported (they read it at import time).
process.env.DB_PATH = BENCH_DB;

const { migrate, db } = await import("../src/db/client");
const { objectService } = await import("../src/services/object-service");
const { blockService } = await import("../src/services/block-service");
const { structureService } = await import("../src/services/structure-service");
const { spaceService } = await import("../src/services/space-service");
const { searchService } = await import("../src/services/search-service");
const { searchIndexService } = await import("../src/services/search-index-service");
const { getNativeSearch, nativeIndexDir } = await import("../src/search/native-search");

/** Deterministic PRNG (mulberry32 — same family as the app's seed). */
function mulberry32(seed: number) {
  return (): number => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(7);
const pick = <T>(a: T[]): T => a[Math.floor(rand() * a.length)];
const PARAS = [
  "Key insight: complexity should be pushed to the edges of the system.",
  "Follow up: compare this approach with the one described in the other book.",
  "Idea: build a small prototype to validate the hypothesis before scaling.",
];
const TAGS = ["rust", "programming", "systems", "design", "science", "productivity", "ai"];

interface BenchResult {
  name: string;
  ops: number;
  totalMs: number;
  avgMs: number | null;
}

const results: BenchResult[] = [];

async function bench(name: string, fn: () => Promise<unknown>, ops = 1): Promise<void> {
  const t0 = performance.now();
  for (let i = 0; i < ops; i++) await fn();
  const totalMs = performance.now() - t0;
  results.push({ name, ops, totalMs, avgMs: totalMs / ops });
}

async function seed(spaceId: string, count: number): Promise<void> {
  const book = await structureService.createStructure({
    spaceId,
    name: "Book",
    icon: "📚",
    properties: [
      { name: "author", type: "text" },
      { name: "year", type: "number" },
      { name: "rating", type: "number" },
    ],
  });
  const project = await structureService.createStructure({
    spaceId,
    name: "Project",
    icon: "🚀",
    properties: [
      { name: "status", type: "select" },
      { name: "due", type: "date" },
    ],
  });
  const structures = [book.id, project.id];
  const pool: string[] = [];

  for (let i = 0; i < count; i++) {
    const id = book.id === structures[i % 2] ? book.id : project.id;
    const obj = await objectService.createObject({
      spaceId,
      structureId: id,
      title: `Bench object ${i}`,
      description: `Description for bench object ${i}.`,
      icon: "🧪",
      properties: id === book.id
        ? { author: `Author ${i % 20}`, year: 1990 + i % 35, rating: 3 + Math.floor(rand() * 3) }
        : { status: pick(["active", "paused", "done"]), due: `2026-01-${String(1 + (i % 28)).padStart(2, "0")}` },
      tags: [pick(TAGS), pick(TAGS)].filter((v, j, a) => a.indexOf(v) === j),
      blocks: [
        { type: "heading", content: { level: 2, text: "Summary" } },
        { type: "paragraph", content: { text: pick(PARAS) } },
        { type: "todo", content: { text: "Follow up with the team", checked: rand() > 0.5 } },
      ],
    });
    pool.push(obj.id);
    if (i > 0 && rand() > 0.8) await objectService.createLink(pool[Math.floor(rand() * pool.length)], obj.id, "mention");
  }
}

async function sampleObjectIds(spaceId: string, n: number): Promise<string[]> {
  const rows = await db
    .selectFrom("objects")
    .select("id")
    .where("space_id", "=", spaceId)
    .limit(Math.max(n, 1))
    .offset(0)
    .execute();
  return rows.map((r) => r.id);
}

async function main(): Promise<void> {
  console.log(`benchmark db: ${BENCH_DB}  (objects target: ${N_OBJECTS})`);
  fs.mkdirSync(path.dirname(BENCH_DB), { recursive: true });

  await migrate();
  const spaceId = await spaceService.defaultSpaceId();
  const structCount = await db
    .selectFrom("structures")
    .select((eb) => eb.fn.countAll().as("count"))
    .executeTakeFirst();
  if (Number(structCount?.count ?? 0) === 0) {
    console.log(`seeding ${N_OBJECTS} objects via the real services…`);
    const t0 = performance.now();
    await seed(spaceId, N_OBJECTS);
    console.log(`seeded in ${(performance.now() - t0).toFixed(0)}ms\n`);
  }

  // make the optional native (Tantivy) layer available to the search benches
  const native = getNativeSearch();
  if (native) {
    try {
      native.init(nativeIndexDir());
      console.log("native search: enabled");
    } catch (e) {
      console.warn("native init failed:", (e as Error).message);
    }
  }

  const ids = await sampleObjectIds(spaceId, 30);
  const blockOf = async (objectId: string) => (await blockService.listBlocks(objectId))[0];
  const firstBlock = await blockOf(ids[0]);
  const firstId = ids[0];

  // --- write path ---
  await bench("createObject (1 obj + 3 blocks, indexed)", async () => {
    await objectService.createObject({
      spaceId,
      structureId: (await structureService.listStructures(spaceId))[0].id,
      title: `bench-create-${Math.random()}`,
      blocks: [{ type: "paragraph", content: { text: "warmup" } }],
    });
  }, 10);

  if (firstBlock) {
    await bench("updateBlock (content)", async () => {
      await blockService.updateBlock(firstId, firstBlock.id, { content: { text: `v${Math.random()}` } });
    }, 20);
  }

  // --- read path ---
  await bench("getFullObject (open page, hydrate meta+blocks)", async () => {
    await objectService.getFullObject(pick(ids));
  }, 100);

  await bench("listObjects space (limit 100)", async () => {
    await objectService.listObjects({ spaceId, limit: 100 });
  }, 20);

  await bench("listObjects by structure (limit 100)", async () => {
    await objectService.listObjects({ spaceId, structureId: (await structureService.listStructures(spaceId))[0].id, limit: 100 });
  }, 20);

  // --- search path ---
  await bench("search exact/prefix (FTS5 + LIKE pipeline)", async () => {
    await searchService.search("rust", { spaceId, limit: 20 });
  }, 20);

  await bench("search typo 'bnch' (fuzzy via Tantivy, union pipeline)", async () => {
    await searchService.search("bnch", { spaceId, limit: 20 });
  }, 20);

  if (native) {
    await bench("native indexSearch (raw nudana)", async () => {
      native.search("bench", 20);
    }, 100);
  }

  // --- bulk / maintenance ---
  await bench("searchIndexService.reindexAll (full heal)", async () => {
    await searchIndexService.reindexAll();
  }, 1);

  // --- report ---
  console.table(results, ["name", "ops", "totalMs", "avgMs"]);
  const outDir = path.resolve("benchmark", "results");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const payload = {
    at: new Date().toISOString(),
    env: { node: process.version, objects: N_OBJECTS, db: BENCH_DB, native: Boolean(native) },
    results,
  };
  fs.writeFileSync(path.join(outDir, `${stamp}.json`), JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(outDir, "latest.json"), JSON.stringify(payload, null, 2));
  console.log(`\nreport: benchmark/results/${stamp}.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});