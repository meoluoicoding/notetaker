import { db } from "../db/client";
import type { StructureRow, ObjectRow, BlockRow } from "../db/schema";
import { DomainError } from "../shared/errors";
import { searchIndexService } from "./search-index-service";
import { v4 as uuidv4 } from "uuid";

const now = () => new Date().toISOString();

export interface ObjectWithMeta extends ObjectRow {
  structure: StructureRow;
  properties: Record<string, unknown>;
  tags: string[];
  blockCount: number;
}

export interface FullObject extends ObjectWithMeta {
  blocks: BlockRow[];
}

function slugFor(name: string, id: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return base ? `${base}-${id.slice(0, 8)}` : id;
}

export class ObjectService {
  async createObject(input: {
    spaceId: string;
    structureId: string;
    title: string;
    description?: string;
    icon?: string;
    coverUrl?: string;
    properties?: Record<string, unknown>;
    tags?: string[];
    blocks?: Array<{ type: string; content: unknown; parentId?: string | null; position?: number }>;
  }): Promise<FullObject> {
    const structure = await db
      .selectFrom("structures")
      .selectAll()
      .where("id", "=", input.structureId)
      .executeTakeFirst();
    if (!structure) throw new DomainError("STRUCTURE_NOT_FOUND", "Structure not found");
    // A structure never leaks across spaces: an object's type must live in its space.
    if (structure.space_id !== input.spaceId) {
      throw new DomainError("STRUCTURE_NOT_FOUND", "Structure belongs to another space");
    }

    // Validate property definitions belong to object's structure
    const definitions = await db
      .selectFrom("property_definitions")
      .selectAll()
      .where("structure_id", "=", input.structureId)
      .execute();
    const defBySlugOrId = new Map<string, (typeof definitions)[number]>();
    for (const d of definitions) {
      defBySlugOrId.set(d.id, d);
      defBySlugOrId.set(d.slug, d);
    }
    if (input.properties) {
      for (const key of Object.keys(input.properties)) {
        if (!defBySlugOrId.has(key)) {
          throw new DomainError("INVALID_PROPERTY", `Unknown property: ${key}`);
        }
      }
    }

    const id = uuidv4();
    const ts = now();

    const objectRow = await db.transaction().execute(async (trx) => {
      const row = {
        id,
        structure_id: input.structureId,
        space_id: input.spaceId,
        title: input.title,
        description: input.description ?? null,
        icon: input.icon ?? null,
        cover_url: input.coverUrl ?? null,
        created_at: ts,
        updated_at: ts,
      };
      await trx.insertInto("objects").values(row).execute();

      if (input.properties) {
        for (const [key, value] of Object.entries(input.properties)) {
          const def = defBySlugOrId.get(key)!;
          await trx
            .insertInto("object_properties")
            .values({ object_id: id, property_id: def.id, value_json: JSON.stringify(value) })
            .execute();
        }
      }

      if (input.tags && input.tags.length > 0) {
        for (const tagName of input.tags) {
          const tagSlug = tagName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
          let tag = await trx
            .selectFrom("tags")
            .selectAll()
            .where("slug", "=", tagSlug)
            .where("space_id", "=", input.spaceId)
            .executeTakeFirst();
          if (!tag) {
            const tagId = uuidv4();
            await trx
              .insertInto("tags")
              .values({ id: tagId, space_id: input.spaceId, name: tagName, slug: tagSlug })
              .execute();
            tag = { id: tagId, space_id: input.spaceId, name: tagName, slug: tagSlug };
          }
          await trx.insertInto("object_tags").values({ object_id: id, tag_id: tag.id }).execute();
        }
      }

      if (input.blocks && input.blocks.length > 0) {
        let nextPosition = 0;
        for (const b of input.blocks) {
          if (b.parentId) {
            throw new DomainError("INVALID_BLOCK_PARENT", "Initial blocks must be root-level");
          }
          await trx
            .insertInto("blocks")
            .values({
              id: uuidv4(),
              object_id: id,
              parent_id: null,
              position: b.position ?? nextPosition,
              type: b.type,
              content_json: JSON.stringify(b.content ?? { text: "" }),
              created_at: ts,
              updated_at: ts,
            })
            .execute();
          nextPosition++;
        }
      }

      return row;
    });

    const full = await this.getFullObject(objectRow.id);
    if (!full) throw new DomainError("OBJECT_NOT_FOUND", "Object creation failed");
    await searchIndexService.indexObject(objectRow.id);
    return full;
  }

  async getObject(id: string): Promise<ObjectWithMeta | null> {
    return this.hydrate(await this.fetchRow(id));
  }

  async getFullObject(id: string): Promise<FullObject | null> {
    const meta = await this.getObject(id);
    if (!meta) return null;
    const blocks = await db
      .selectFrom("blocks")
      .selectAll()
      .where("object_id", "=", id)
      .orderBy("position", "asc")
      .execute();
    return { ...meta, blocks };
  }

  async listObjects(
    filter: { spaceId?: string; structureId?: string; tag?: string; limit?: number; offset?: number } = {}
  ): Promise<ObjectWithMeta[]> {
    let query = db.selectFrom("objects").selectAll("objects").orderBy("objects.updated_at", "desc");
    if (filter.spaceId) query = query.where("objects.space_id", "=", filter.spaceId);
    if (filter.structureId) query = query.where("objects.structure_id", "=", filter.structureId);
    if (filter.tag) {
      query = query
        .innerJoin("object_tags", "object_tags.object_id", "objects.id")
        .innerJoin("tags", "tags.id", "object_tags.tag_id")
        .where("tags.slug", "=", filter.tag);
    }
    query = query.limit(filter.limit ?? 100).offset(filter.offset ?? 0);
    const rows = await query.execute();
    return (await Promise.all(rows.map((r) => this.hydrate(r)))).filter(
      (o): o is ObjectWithMeta => o !== null
    );
  }

  async updateObject(id: string, input: { title?: string; description?: string | null; icon?: string | null; coverUrl?: string | null }): Promise<ObjectWithMeta | null> {
    const existing = await this.fetchRow(id);
    if (!existing) return null;
    const updates: Record<string, unknown> = { updated_at: now() };
    if (input.title !== undefined) updates.title = input.title;
    if (input.description !== undefined) updates.description = input.description;
    if (input.icon !== undefined) updates.icon = input.icon;
    if (input.coverUrl !== undefined) updates.cover_url = input.coverUrl;
    await db.updateTable("objects").set(updates).where("id", "=", id).execute();
    if (input.title !== undefined || input.description !== undefined) {
      await searchIndexService.indexObject(id);
    }
    return this.getObject(id);
  }

  /**
   * Patch an object's properties (e.g. a Project's status/due).
   * Keys may be a property definition id or slug; `null` removes the value
   * (deletes the row), any other value must survive JSON.stringify. Values are
   * coerced to the definition's type (number, boolean) so the DB stays clean.
   */
  async updateObjectProperties(id: string, properties: Record<string, unknown>): Promise<ObjectWithMeta | null> {
    const existing = await this.fetchRow(id);
    if (!existing) return null;
    const definitions = await db
      .selectFrom("property_definitions")
      .selectAll()
      .where("structure_id", "=", existing.structure_id)
      .execute();
    const defByKey = new Map<string, (typeof definitions)[number]>();
    for (const d of definitions) {
      defByKey.set(d.id, d);
      defByKey.set(d.slug, d);
    }

    const ts = now();
    await db.transaction().execute(async (trx) => {
      for (const [key, raw] of Object.entries(properties)) {
        const def = defByKey.get(key);
        if (!def) throw new DomainError("INVALID_PROPERTY", `Unknown property: ${key}`);
        if (raw === null || raw === undefined || raw === "") {
          await trx.deleteFrom("object_properties").where("object_id", "=", id).where("property_id", "=", def.id).execute();
          continue;
        }
        let value: unknown = raw;
        if (def.type === "number") {
          const n = typeof raw === "number" ? raw : Number(raw);
          if (!Number.isFinite(n)) throw new DomainError("INVALID_PROPERTY", `Property "${def.name}" expects a number`);
          value = n;
        } else if (def.type === "boolean") {
          value = raw === true || raw === "true" || raw === 1 || raw === "1";
        } else if (def.type === "date" || def.type === "datetime") {
          if (typeof raw !== "string" || !raw.trim()) throw new DomainError("INVALID_PROPERTY", `Property "${def.name}" expects a date string`);
          value = raw;
        }
        const serialized = JSON.stringify(value);
        if (serialized === undefined) throw new DomainError("INVALID_PROPERTY", `Property "${def.name}" is not JSON-serializable`);
        await trx
          .insertInto("object_properties")
          .values({ object_id: id, property_id: def.id, value_json: serialized })
          .onConflict((oc) =>
            oc.columns(["object_id", "property_id"]).doUpdateSet({ value_json: serialized })
          )
          .execute();
      }
      await trx.updateTable("objects").set({ updated_at: ts }).where("id", "=", id).execute();
    });

    return this.getObject(id);
  }

  async deleteObject(id: string): Promise<boolean> {
    const existing = await this.fetchRow(id);
    if (!existing) return false;
    await db.transaction().execute(async (trx) => {
      await trx.deleteFrom("blocks").where("object_id", "=", id).execute();
      await trx.deleteFrom("object_properties").where("object_id", "=", id).execute();
      await trx.deleteFrom("object_tags").where("object_id", "=", id).execute();
      await trx.deleteFrom("links").where("source_object_id", "=", id).execute();
      await trx.deleteFrom("links").where("target_object_id", "=", id).execute();
      await trx.deleteFrom("objects").where("id", "=", id).execute();
    });
    await searchIndexService.removeObject(id);
    return true;
  }

  async createLink(sourceId: string, targetId: string, relation?: string): Promise<void> {
    const [source, target] = await Promise.all([
      this.fetchRow(sourceId),
      this.fetchRow(targetId),
    ]);
    if (!source) throw new DomainError("OBJECT_NOT_FOUND", `Source object not found: ${sourceId}`);
    if (!target) throw new DomainError("LINK_TARGET_NOT_FOUND", `Target object not found: ${targetId}`);
    // Links never cross spaces: the graph is scoped like every other query.
    if (source.space_id !== target.space_id) {
      throw new DomainError("LINK_TARGET_NOT_FOUND", "Target object belongs to another space");
    }
    const rel = relation ?? null;
    await db
      .insertInto("links")
      .values({
        source_object_id: sourceId,
        target_object_id: targetId,
        relation: rel,
        created_at: now(),
      })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  async deleteLink(sourceId: string, targetId: string, relation?: string): Promise<void> {
    let query = db
      .deleteFrom("links")
      .where("source_object_id", "=", sourceId)
      .where("target_object_id", "=", targetId);
    if (relation !== undefined) query = query.where("relation", "=", relation);
    await query.execute();
  }

  async getBacklinks(id: string): Promise<ObjectWithMeta[]> {
    const links = await db
      .selectFrom("links")
      .select("source_object_id")
      .where("target_object_id", "=", id)
      .execute();
    return (
      await Promise.all(links.map((l) => this.getObject(l.source_object_id)))
    ).filter((o): o is ObjectWithMeta => o !== null);
  }

  async getLinkedObjects(id: string): Promise<ObjectWithMeta[]> {
    const links = await db
      .selectFrom("links")
      .select("target_object_id")
      .where("source_object_id", "=", id)
      .execute();
    return (
      await Promise.all(links.map((l) => this.getObject(l.target_object_id)))
    ).filter((o): o is ObjectWithMeta => o !== null);
  }

  private async fetchRow(id: string): Promise<ObjectRow | undefined> {
    return db.selectFrom("objects").selectAll().where("id", "=", id).executeTakeFirst();
  }

  private async hydrate(row: ObjectRow | undefined): Promise<ObjectWithMeta | null> {
    if (!row) return null;
    const [structure, propRows, tagRows, blockCount] = await Promise.all([
      db.selectFrom("structures").selectAll().where("id", "=", row.structure_id).executeTakeFirst(),
      db
        .selectFrom("object_properties")
        .innerJoin("property_definitions", "property_definitions.id", "object_properties.property_id")
        .select(["property_definitions.name", "property_definitions.slug", "object_properties.value_json"])
        .where("object_properties.object_id", "=", row.id)
        .execute(),
      db
        .selectFrom("object_tags")
        .innerJoin("tags", "tags.id", "object_tags.tag_id")
        .select(["tags.name"])
        .where("object_tags.object_id", "=", row.id)
        .execute(),
      db
        .selectFrom("blocks")
        .select((eb) => eb.fn.countAll().as("count"))
        .where("object_id", "=", row.id)
        .executeTakeFirst(),
    ]);
    const properties: Record<string, unknown> = {};
    for (const p of propRows) {
      try {
        properties[p.slug] = p.value_json === null ? null : JSON.parse(p.value_json);
      } catch {
        properties[p.slug] = null;
      }
    }
    if (!structure) throw new DomainError("STRUCTURE_NOT_FOUND", `Structure missing for object ${row.id}`);
    return {
      ...row,
      structure,
      properties,
      tags: tagRows.map((t) => t.name),
      blockCount: Number(blockCount?.count ?? 0),
    };
  }
}

export const objectService = new ObjectService();
export { slugFor };
