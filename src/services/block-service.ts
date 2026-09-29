import { db } from "../db/client";
import type { BlockRow } from "../db/schema";
import { DomainError } from "../shared/errors";
import { searchIndexService } from "./search-index-service";
import { v4 as uuidv4 } from "uuid";

const now = () => new Date().toISOString();

export class BlockService {
  async listBlocks(objectId: string): Promise<BlockRow[]> {
    return db
      .selectFrom("blocks")
      .selectAll()
      .where("object_id", "=", objectId)
      .orderBy("position", "asc")
      .execute();
  }

  async getBlock(objectId: string, blockId: string): Promise<BlockRow | null> {
    const row = await db
      .selectFrom("blocks")
      .selectAll()
      .where("id", "=", blockId)
      .where("object_id", "=", objectId)
      .executeTakeFirst();
    return row ?? null;
  }

  async createBlock(
    objectId: string,
    input: { type: string; content: unknown; parentId?: string | null; position?: number }
  ): Promise<BlockRow> {
    await this.assertObjectExists(objectId);

    if (input.parentId) {
      await this.assertParentInSameObject(objectId, input.parentId);
    }

    const parentId = input.parentId ?? null;

    // Determine position: default = append at end of siblings
    const siblingCount = await db
      .selectFrom("blocks")
      .select((eb) => eb.fn.countAll().as("count"))
      .where("object_id", "=", objectId)
      .where("parent_id", "is", parentId)
      .executeTakeFirst();
    const position = input.position ?? Number(siblingCount?.count ?? 0);

    // Insert with position shift if inserting mid-sequence
    const row = await db.transaction().execute(async (trx) => {
      if (input.position !== undefined) {
        await trx
          .updateTable("blocks")
          .set((eb) => ({ position: eb("position", "+", 1) }))
          .where("object_id", "=", objectId)
          .where("parent_id", parentId === null ? "is" : "=", parentId as string | null)
          .where("position", ">=", position)
          .execute();
      }

      const id = uuidv4();
      const ts = now();
      const row = {
        id,
        object_id: objectId,
        parent_id: parentId,
        position,
        type: input.type,
        content_json: JSON.stringify(input.content ?? { text: "" }),
        created_at: ts,
        updated_at: ts,
      };
      await trx.insertInto("blocks").values(row).execute();
      await trx.updateTable("objects").set({ updated_at: ts }).where("id", "=", objectId).execute();
      return row;
    });

    await searchIndexService.indexObject(objectId);
    return row;
  }

  async updateBlock(
    objectId: string,
    blockId: string,
    input: { content?: unknown; type?: string }
  ): Promise<BlockRow | null> {
    const existing = await this.getBlock(objectId, blockId);
    if (!existing) return null;
    const ts = now();
    const updates: Record<string, unknown> = { updated_at: ts };
    if (input.content !== undefined) updates.content_json = JSON.stringify(input.content);
    if (input.type !== undefined) updates.type = input.type;
    await db.transaction().execute(async (trx) => {
      await trx.updateTable("blocks").set(updates).where("id", "=", blockId).execute();
      await trx.updateTable("objects").set({ updated_at: ts }).where("id", "=", objectId).execute();
    });
    await searchIndexService.indexObject(objectId);
    return this.getBlock(objectId, blockId);
  }

  async moveBlock(
    objectId: string,
    blockId: string,
    input: { parentId?: string | null; position: number }
  ): Promise<BlockRow | null> {
    const existing = await this.getBlock(objectId, blockId);
    if (!existing) return null;
    const newParent = input.parentId ?? null;
    if (newParent !== null) {
      await this.assertParentInSameObject(objectId, newParent);
      // Prevent moving a block under its own descendant
      if (await this.isDescendant(newParent, blockId, objectId)) {
        throw new DomainError("INVALID_BLOCK_PARENT", "Cannot move a block under its own descendant");
      }
    }

    await db.transaction().execute(async (trx) => {
      const oldParent = existing.parent_id;
      const parentChanged =
        oldParent !== newParent || (oldParent === null) !== (newParent === null);

      if (parentChanged) {
        // Close gap in old sibling list
        await trx
          .updateTable("blocks")
          .set((eb) => ({ position: eb("position", "-", 1) }))
          .where("object_id", "=", objectId)
          .where("parent_id", oldParent === null ? "is" : "=", oldParent as string | null)
          .where("position", ">", existing.position)
          .execute();
        // Open gap in new sibling list
        await trx
          .updateTable("blocks")
          .set((eb) => ({ position: eb("position", "+", 1) }))
          .where("object_id", "=", objectId)
          .where("parent_id", newParent === null ? "is" : "=", newParent as string | null)
          .where("position", ">=", input.position)
          .execute();
      } else {
        const target = input.position;
        if (target === existing.position) return;
        if (target < existing.position) {
          await trx
            .updateTable("blocks")
            .set((eb) => ({ position: eb("position", "+", 1) }))
            .where("object_id", "=", objectId)
            .where("parent_id", oldParent === null ? "is" : "=", oldParent as string | null)
            .where("position", ">=", target)
            .where("position", "<", existing.position)
            .execute();
        } else {
          await trx
            .updateTable("blocks")
            .set((eb) => ({ position: eb("position", "-", 1) }))
            .where("object_id", "=", objectId)
            .where("parent_id", oldParent === null ? "is" : "=", oldParent as string | null)
            .where("position", ">", existing.position)
            .where("position", "<=", target)
            .execute();
        }
      }

      await trx
        .updateTable("blocks")
        .set({ parent_id: newParent, position: input.position, updated_at: now() })
        .where("id", "=", blockId)
        .execute();
      await trx.updateTable("objects").set({ updated_at: now() }).where("id", "=", objectId).execute();
    });

    return this.getBlock(objectId, blockId);
  }

  async deleteBlock(objectId: string, blockId: string): Promise<boolean> {
    const existing = await this.getBlock(objectId, blockId);
    if (!existing) return false;

    await db.transaction().execute(async (trx) => {
      // Collect descendants (bounded by object scope) then delete deepest-first
      const allBlocks = await trx
        .selectFrom("blocks")
        .selectAll()
        .where("object_id", "=", objectId)
        .execute();
      const toDelete = new Set<string>([blockId]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const b of allBlocks) {
          if (b.parent_id && toDelete.has(b.parent_id) && !toDelete.has(b.id)) {
            toDelete.add(b.id);
            grew = true;
          }
        }
      }
      await trx
        .deleteFrom("blocks")
        .where("object_id", "=", objectId)
        .where("id", "in", Array.from(toDelete))
        .execute();
      // Close gap
      await trx
        .updateTable("blocks")
        .set((eb) => ({ position: eb("position", "-", 1) }))
        .where("object_id", "=", objectId)
        .where("parent_id", existing.parent_id === null ? "is" : "=", existing.parent_id)
        .where("position", ">", existing.position)
        .execute();
      await trx.updateTable("objects").set({ updated_at: now() }).where("id", "=", objectId).execute();
    });
    await searchIndexService.indexObject(objectId);
    return true;
  }

  private async assertObjectExists(objectId: string): Promise<void> {
    const row = await db
      .selectFrom("objects")
      .select("id")
      .where("id", "=", objectId)
      .executeTakeFirst();
    if (!row) throw new DomainError("OBJECT_NOT_FOUND", "Object not found");
  }

  private async assertParentInSameObject(objectId: string, parentId: string): Promise<void> {
    const parent = await db
      .selectFrom("blocks")
      .select(["id", "object_id"])
      .where("id", "=", parentId)
      .executeTakeFirst();
    if (!parent) throw new DomainError("BLOCK_NOT_FOUND", "Parent block not found");
    if (parent.object_id !== objectId) {
      throw new DomainError("INVALID_BLOCK_PARENT", "Parent block must belong to the same object");
    }
  }

  private async isDescendant(candidateId: string, ancestorId: string, objectId: string): Promise<boolean> {
    const all = await db
      .selectFrom("blocks")
      .select(["id", "parent_id"])
      .where("object_id", "=", objectId)
      .execute();
    const byId = new Map(all.map((b) => [b.id, b.parent_id]));
    let current: string | null | undefined = candidateId;
    let depth = 0;
    while (current && depth < 100) {
      if (current === ancestorId) return true;
      current = byId.get(current) ?? null;
      depth++;
    }
    return false;
  }
}

export const blockService = new BlockService();
