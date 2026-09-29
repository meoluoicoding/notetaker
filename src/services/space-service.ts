import { db } from "../db/client";
import type { SpaceRow, StructureRow } from "../db/schema";
import { DomainError } from "../shared/errors";
import { getNativeSearch } from "../search/native-search";
import { v4 as uuidv4 } from "uuid";

const now = () => new Date().toISOString();

export interface SpaceWithCounts extends SpaceRow {
  objectCount: number;
  typeCount: number;
}

/** A brand-new space is usable straight away: it gets one object type. */
export const DEFAULT_SPACE_TYPE = { name: "Page", slug: "page", icon: "📄" } as const;

export class SpaceService {
  async listSpaces(): Promise<SpaceWithCounts[]> {
    const [spaces, objectCounts, typeCounts] = await Promise.all([
      db.selectFrom("spaces").selectAll().orderBy("created_at", "asc").orderBy("id", "asc").execute(),
      db
        .selectFrom("objects")
        .select(["space_id"])
        .select((eb) => eb.fn.countAll().as("count"))
        .groupBy("space_id")
        .execute(),
      db
        .selectFrom("structures")
        .select(["space_id"])
        .select((eb) => eb.fn.countAll().as("count"))
        .groupBy("space_id")
        .execute(),
    ]);
    const objects = new Map(objectCounts.map((r) => [r.space_id, Number(r.count)]));
    const types = new Map(typeCounts.map((r) => [r.space_id, Number(r.count)]));
    return spaces.map((s) => ({
      ...s,
      objectCount: objects.get(s.id) ?? 0,
      typeCount: types.get(s.id) ?? 0,
    }));
  }

  async getSpace(id: string): Promise<SpaceWithCounts | null> {
    const all = await this.listSpaces();
    return all.find((s) => s.id === id) ?? null;
  }

  /** The space that owns data written before spaces existed (oldest space wins). */
  async defaultSpaceId(): Promise<string> {
    const row = await db
      .selectFrom("spaces")
      .select("id")
      .orderBy("created_at", "asc")
      .orderBy("id", "asc")
      .executeTakeFirst();
    if (!row) throw new DomainError("SPACE_NOT_FOUND", "No space exists yet");
    return row.id;
  }

  async spaceExists(id: string): Promise<boolean> {
    const row = await db.selectFrom("spaces").select("id").where("id", "=", id).executeTakeFirst();
    return Boolean(row);
  }

  /** Creating a space also creates its first object type, inside one transaction. */
  async createSpace(input: { name: string; icon?: string }): Promise<SpaceRow & { structures: StructureRow[] }> {
    const id = uuidv4();
    const ts = now();
    const structureId = uuidv4();
    const structure: StructureRow = {
      id: structureId,
      space_id: id,
      name: DEFAULT_SPACE_TYPE.name,
      slug: DEFAULT_SPACE_TYPE.slug,
      icon: DEFAULT_SPACE_TYPE.icon,
      created_at: ts,
      updated_at: ts,
    };

    const space = await db.transaction().execute(async (trx) => {
      const row: SpaceRow = {
        id,
        name: input.name,
        icon: input.icon ?? null,
        created_at: ts,
        updated_at: ts,
      };
      await trx.insertInto("spaces").values(row).execute();
      await trx.insertInto("structures").values(structure).execute();
      return row;
    });

    return { ...space, structures: [structure] };
  }

  async updateSpace(id: string, input: { name?: string; icon?: string | null }): Promise<SpaceRow | null> {
    const existing = await db.selectFrom("spaces").selectAll().where("id", "=", id).executeTakeFirst();
    if (!existing) return null;

    const patch: { updated_at: string; name?: string; icon?: string | null } = { updated_at: now() };
    if (input.name !== undefined && input.name !== existing.name) patch.name = input.name;
    if (input.icon !== undefined) patch.icon = input.icon;

    await db.updateTable("spaces").set(patch).where("id", "=", id).execute();
    return (await db.selectFrom("spaces").selectAll().where("id", "=", id).executeTakeFirst()) ?? null;
  }

  /**
   * Deleting a space never happens by accident: it must be empty, unless the
   * caller asks for `force`, and the last remaining space is never removed.
   */
  async deleteSpace(id: string, options: { force?: boolean } = {}): Promise<boolean> {
    const space = await db.selectFrom("spaces").selectAll().where("id", "=", id).executeTakeFirst();
    if (!space) return false;

    const total = await db.selectFrom("spaces").select((eb) => eb.fn.countAll().as("count")).executeTakeFirst();
    if (Number(total?.count ?? 0) <= 1) {
      throw new DomainError("LAST_SPACE_REMAINING", "The last space cannot be deleted");
    }

    const objectIds = (
      await db.selectFrom("objects").select("id").where("space_id", "=", id).execute()
    ).map((o) => o.id);

    if (objectIds.length > 0 && !options.force) {
      throw new DomainError(
        "SPACE_NOT_EMPTY",
        `Space still holds ${objectIds.length} object${objectIds.length === 1 ? "" : "s"}`
      );
    }

    const structureIds = (
      await db.selectFrom("structures").select("id").where("space_id", "=", id).execute()
    ).map((s) => s.id);

    await db.transaction().execute(async (trx) => {
      if (objectIds.length > 0) {
        await trx.deleteFrom("blocks").where("object_id", "in", objectIds).execute();
        await trx.deleteFrom("object_properties").where("object_id", "in", objectIds).execute();
        await trx.deleteFrom("object_tags").where("object_id", "in", objectIds).execute();
        await trx.deleteFrom("links").where("source_object_id", "in", objectIds).execute();
        await trx.deleteFrom("links").where("target_object_id", "in", objectIds).execute();
        await trx.deleteFrom("search_index").where("object_id", "in", objectIds).execute();
        await trx.deleteFrom("objects").where("id", "in", objectIds).execute();
      }
      if (structureIds.length > 0) {
        await trx.deleteFrom("property_definitions").where("structure_id", "in", structureIds).execute();
        await trx.deleteFrom("structures").where("id", "in", structureIds).execute();
      }
      await trx.deleteFrom("tags").where("space_id", "=", id).execute();
      await trx.deleteFrom("spaces").where("id", "=", id).execute();
    });

    // Mirror the removal into the optional native (Tantivy) index; no-op without .node.
    getNativeSearch()?.remove(objectIds);

    return true;
  }
}

export const spaceService = new SpaceService();
