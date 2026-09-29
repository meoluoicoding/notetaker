import { migrate, db, rawSqlite } from "../db/client";
import { searchIndexService } from "../services/search-index-service";
import { getNativeSearch, nativeIndexDir } from "../search/native-search";
import { createApp } from "./app";
import path from "node:path";

const PORT = Number(process.env.PORT) || 3000;

async function main(): Promise<void> {
  await migrate();

  // Auto-seed empty database with structures so the demo is usable immediately
  const structureCount = await db
    .selectFrom("structures")
    .select((eb) => eb.fn.countAll().as("count"))
    .executeTakeFirst();
  if (Number(structureCount?.count ?? 0) === 0) {
    const { seedDatabase } = await import("../db/seed");
    await seedDatabase();
  }

  // Optional native (Tantivy) index: initialize before the FTS heal so
  // reindexAll() mirrors each object into it too. No-op without the .node.
  const native = getNativeSearch();
  if (native) {
    try {
      native.init(nativeIndexDir());
      console.log("native search: enabled (tantivy)");
    } catch (e) {
      console.warn("native search: init failed —", (e as Error).message);
    }
  }

  // Heal the FTS index (also indexes databases written before the index existed)
  const indexed = await searchIndexService.reindexAll();
  console.log(`search index: ${indexed} objects`);

  const app = createApp();
  app.listen(PORT, () => {
    console.log(`notetaker MVP running at http://localhost:${PORT}`);
    console.log(`db: ${rawSqlite.name}`);
  });
}

main().catch((err) => {
  console.error("fatal", err);
  process.exit(1);
});
