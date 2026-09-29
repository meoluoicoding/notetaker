import { db } from "../db/client";
import type { BlockRow, ObjectRow, TagRow } from "../db/schema";
import { getNativeSearch } from "../search/native-search";

/**
 * Owns the FTS5 `search_index` table.
 *
 * `search_index` is a derived projection: one row per object holding
 * title + description + block text + tags. Objects/blocks/tags stay the source
 * of truth, so every write to them must re-index the object it belongs to.
 */

/** Content keys that are structure/formatting, never searchable text. */
const NON_TEXT_KEYS = new Set(["language", "level", "checked", "align", "type", "marks"]);

/** Flatten the text carried by a block's JSON content (text, code, nested values…). */
export function blockText(content: unknown): string {
  const parts: string[] = [];
  const walk = (value: unknown, key: string | null): void => {
    if (typeof value === "string") {
      if (key === null || !NON_TEXT_KEYS.has(key)) parts.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v) => walk(v, key));
      return;
    }
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, k);
    }
  };
  walk(content, null);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function parseContent(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export class SearchIndexService {
  /** (Re)build the index row for one object. Removes the row when the object is gone. */
  async indexObject(objectId: string): Promise<void> {
    const object: ObjectRow | undefined = await db
      .selectFrom("objects")
      .selectAll()
      .where("id", "=", objectId)
      .executeTakeFirst();
    if (!object) {
      await this.removeObject(objectId);
      return;
    }

    const [blocks, tagRows] = await Promise.all([
      db
        .selectFrom("blocks")
        .selectAll()
        .where("object_id", "=", objectId)
        .orderBy("position", "asc")
        .execute(),
      db
        .selectFrom("object_tags")
        .innerJoin("tags", "tags.id", "object_tags.tag_id")
        .select(["tags.name"])
        .where("object_tags.object_id", "=", objectId)
        .execute(),
    ]);

    const body = [object.description ?? "", ...blocks.map((b: BlockRow) => blockText(parseContent(b.content_json)))]
      .filter((part) => part.length > 0)
      .join("\n");
    const tags = tagRows.map((t: Pick<TagRow, "name">) => t.name).join(" ");

    await db.transaction().execute(async (trx) => {
      await trx.deleteFrom("search_index").where("object_id", "=", objectId).execute();
      await trx
        .insertInto("search_index")
        .values({ object_id: objectId, title: object.title, body, tags })
        .execute();
    });

    // Mirror into the optional Tantivy index (no-op when the .node is absent).
    getNativeSearch()?.add([{ id: objectId, title: object.title, body, tags }]);
  }

  async removeObject(objectId: string): Promise<void> {
    await db.deleteFrom("search_index").where("object_id", "=", objectId).execute();
    getNativeSearch()?.remove([objectId]);
  }

  /** Rebuild the whole index (used after seeding and on boot to heal drifted indexes). */
  async reindexAll(): Promise<number> {
    const objects = await db.selectFrom("objects").select("id").execute();
    const ids = objects.map((o) => o.id);
    await db.deleteFrom("search_index").execute();
    for (const id of ids) await this.indexObject(id);
    return ids.length;
  }
}

export const searchIndexService = new SearchIndexService();
