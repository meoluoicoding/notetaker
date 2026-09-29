import { db } from "../db/client";
import type { StructureRow, PropertyDefinitionRow } from "../db/schema";
import { DomainError } from "../shared/errors";
import { spaceService } from "./space-service";
import { v4 as uuidv4 } from "uuid";
import { slugify } from "../shared/schemas";

const now = () => new Date().toISOString();

export class StructureService {
  async createStructure(input: {
    spaceId: string;
    name: string;
    icon?: string;
    properties?: Array<{ name: string; type: string }>;
  }): Promise<StructureRow & { properties: PropertyDefinitionRow[] }> {
    if (!(await spaceService.spaceExists(input.spaceId))) {
      throw new DomainError("SPACE_NOT_FOUND", "Space not found");
    }

    const id = uuidv4();
    const ts = now();
    const spaceId = input.spaceId;

    return db.transaction().execute(async (trx) => {
      // Slugs are unique per space: two spaces may both own a "Page" type.
      let slug = slugify(input.name) || id;
      const existing = await trx
        .selectFrom("structures")
        .select("slug")
        .where("slug", "=", slug)
        .where("space_id", "=", spaceId)
        .executeTakeFirst();
      if (existing) slug = `${slug}-${id.slice(0, 8)}`;

      const row = {
        id,
        space_id: spaceId,
        name: input.name,
        slug,
        icon: input.icon ?? null,
        created_at: ts,
        updated_at: ts,
      };
      await trx.insertInto("structures").values(row).execute();

      const properties: PropertyDefinitionRow[] = [];
      if (input.properties) {
        for (const p of input.properties) {
          const def = {
            id: uuidv4(),
            structure_id: id,
            name: p.name,
            slug: slugify(p.name) || uuidv4(),
            type: p.type,
          };
          await trx.insertInto("property_definitions").values(def).execute();
          properties.push(def);
        }
      }

      return { ...row, properties };
    });
  }

  async getStructure(id: string): Promise<(StructureRow & { properties: PropertyDefinitionRow[] }) | null> {
    const row = await db.selectFrom("structures").selectAll().where("id", "=", id).executeTakeFirst();
    if (!row) return null;
    const properties = await db
      .selectFrom("property_definitions")
      .selectAll()
      .where("structure_id", "=", id)
      .orderBy("name", "asc")
      .execute();
    return { ...row, properties };
  }

  async listStructures(spaceId: string): Promise<StructureRow[]> {
    return db
      .selectFrom("structures")
      .selectAll()
      .where("space_id", "=", spaceId)
      .orderBy("name", "asc")
      .execute();
  }

  /** Rename/re-icon a type. Returns null when the structure does not exist. */
  async updateStructure(id: string, input: { name?: string; icon?: string | null }): Promise<StructureRow | null> {
    const existing = await db.selectFrom("structures").selectAll().where("id", "=", id).executeTakeFirst();
    if (!existing) return null;

    const patch: { updated_at: string; name?: string; slug?: string; icon?: string | null } = { updated_at: now() };
    if (input.name !== undefined && input.name !== existing.name) {
      patch.name = input.name;
      patch.slug = await this.uniqueSlug(input.name, id, existing.space_id);
    }
    if (input.icon !== undefined) patch.icon = input.icon;

    await db.updateTable("structures").set(patch).where("id", "=", id).execute();
    return (await db.selectFrom("structures").selectAll().where("id", "=", id).executeTakeFirst()) ?? null;
  }

  /** Slug follows the name; a clash inside the same space gets the id suffix. */
  private async uniqueSlug(name: string, selfId: string, spaceId: string | null): Promise<string> {
    const base = slugify(name) || selfId;
    let query = db
      .selectFrom("structures")
      .select("id")
      .where("slug", "=", base)
      .where("id", "!=", selfId);
    query = spaceId === null ? query.where("space_id", "is", null) : query.where("space_id", "=", spaceId);
    const clash = await query.executeTakeFirst();
    return clash ? `${base}-${selfId.slice(0, 8)}` : base;
  }
}

export const structureService = new StructureService();
