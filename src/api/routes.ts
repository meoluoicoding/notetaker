import { Router } from "express";
import type { Request } from "express";
import { objectService } from "../services/object-service";
import { blockService } from "../services/block-service";
import { structureService } from "../services/structure-service";
import { tagService } from "../services/tag-service";
import { searchService } from "../services/search-service";
import { spaceService } from "../services/space-service";
import {
  createObjectSchema,
  updateObjectSchema,
  updateObjectPropertiesSchema,
  createBlockSchema,
  updateBlockSchema,
  moveBlockSchema,
  createStructureSchema,
  updateStructureSchema,
  createSpaceSchema,
  updateSpaceSchema,
  searchQuerySchema,
} from "../shared/schemas";
import { DomainError } from "../shared/errors";
import { ok } from "./error-handler";
import { serializeBlock } from "./serializers";

export const apiRouter = Router();

/**
 * The active space travels in the `X-Space-Id` header (query `?spaceId=` also
 * works for curl). Requests without it fall back to the oldest space, which is
 * where data written before spaces existed lives.
 */
async function resolveSpaceId(req: Request): Promise<string> {
  const fromHeader = req.header("x-space-id");
  const fromQuery = typeof req.query.spaceId === "string" ? req.query.spaceId : undefined;
  const requested = fromHeader || fromQuery;
  if (!requested) return spaceService.defaultSpaceId();
  if (!(await spaceService.spaceExists(requested))) {
    throw new DomainError("SPACE_NOT_FOUND", "Space not found");
  }
  return requested;
}

// ---------- spaces ----------

apiRouter.get("/spaces", async (_req, res, next) => {
  try {
    ok(res, await spaceService.listSpaces());
  } catch (e) {
    next(e);
  }
});

apiRouter.post("/spaces", async (req, res, next) => {
  try {
    const input = createSpaceSchema.parse(req.body);
    ok(res, await spaceService.createSpace(input));
  } catch (e) {
    next(e);
  }
});

apiRouter.patch("/spaces/:id", async (req, res, next) => {
  try {
    const input = updateSpaceSchema.parse(req.body);
    const space = await spaceService.updateSpace(req.params.id, input);
    if (!space) throw new DomainError("SPACE_NOT_FOUND", "Space not found");
    ok(res, space);
  } catch (e) {
    next(e);
  }
});

apiRouter.delete("/spaces/:id", async (req, res, next) => {
  try {
    const force = req.query.force === "1" || req.query.force === "true";
    const deleted = await spaceService.deleteSpace(req.params.id, { force });
    if (!deleted) throw new DomainError("SPACE_NOT_FOUND", "Space not found");
    ok(res, { deleted: true, force });
  } catch (e) {
    next(e);
  }
});

// ---------- structures ----------

apiRouter.post("/structures", async (req, res, next) => {
  try {
    const spaceId = await resolveSpaceId(req);
    const input = createStructureSchema.parse(req.body);
    const structure = await structureService.createStructure({ ...input, spaceId });
    ok(res, structure);
  } catch (e) {
    next(e);
  }
});

apiRouter.get("/structures", async (req, res, next) => {
  try {
    const spaceId = await resolveSpaceId(req);
    ok(res, await structureService.listStructures(spaceId));
  } catch (e) {
    next(e);
  }
});

apiRouter.get("/structures/:id", async (req, res, next) => {
  try {
    const s = await structureService.getStructure(req.params.id);
    if (!s) throw new DomainError("STRUCTURE_NOT_FOUND", "Structure not found");
    ok(res, s);
  } catch (e) {
    next(e);
  }
});

apiRouter.patch("/structures/:id", async (req, res, next) => {
  try {
    const input = updateStructureSchema.parse(req.body);
    const structure = await structureService.updateStructure(req.params.id, input);
    if (!structure) throw new DomainError("STRUCTURE_NOT_FOUND", "Structure not found");
    ok(res, structure);
  } catch (e) {
    next(e);
  }
});

// ---------- objects ----------

apiRouter.post("/objects", async (req, res, next) => {
  try {
    const spaceId = await resolveSpaceId(req);
    const input = createObjectSchema.parse(req.body);
    const obj = await objectService.createObject({ ...input, spaceId });
    ok(res, { ...obj, blocks: obj.blocks.map(serializeBlock) });
  } catch (e) {
    next(e);
  }
});

apiRouter.get("/objects", async (req, res, next) => {
  try {
    const spaceId = await resolveSpaceId(req);
    const structureId = typeof req.query.structureId === "string" ? req.query.structureId : undefined;
    const tag = typeof req.query.tag === "string" ? req.query.tag : undefined;
    const limit = req.query.limit ? Math.min(Number(req.query.limit) || 100, 200) : 100;
    const offset = Number(req.query.offset) || 0;
    ok(res, await objectService.listObjects({ spaceId, structureId, tag, limit, offset }));
  } catch (e) {
    next(e);
  }
});

apiRouter.get("/objects/:id", async (req, res, next) => {
  try {
    const obj = await objectService.getFullObject(req.params.id);
    if (!obj) throw new DomainError("OBJECT_NOT_FOUND", "Object not found");
    ok(res, { ...obj, blocks: obj.blocks.map(serializeBlock) });
  } catch (e) {
    next(e);
  }
});

apiRouter.patch("/objects/:id", async (req, res, next) => {
  try {
    const input = updateObjectSchema.parse(req.body);
    const obj = await objectService.updateObject(req.params.id, input);
    if (!obj) throw new DomainError("OBJECT_NOT_FOUND", "Object not found");
    ok(res, obj);
  } catch (e) {
    next(e);
  }
});

apiRouter.patch("/objects/:id/properties", async (req, res, next) => {
  try {
    const input = updateObjectPropertiesSchema.parse(req.body);
    const obj = await objectService.updateObjectProperties(req.params.id, input.properties);
    if (!obj) throw new DomainError("OBJECT_NOT_FOUND", "Object not found");
    ok(res, obj);
  } catch (e) {
    next(e);
  }
});

apiRouter.delete("/objects/:id", async (req, res, next) => {
  try {
    const deleted = await objectService.deleteObject(req.params.id);
    if (!deleted) throw new DomainError("OBJECT_NOT_FOUND", "Object not found");
    ok(res, { deleted: true });
  } catch (e) {
    next(e);
  }
});

// ---------- links ----------

apiRouter.post("/objects/:id/links", async (req, res, next) => {
  try {
    const { targetId, relation } = req.body as { targetId?: string; relation?: string };
    if (!targetId || typeof targetId !== "string") {
      throw new DomainError("INVALID_QUERY", "targetId is required");
    }
    await objectService.createLink(req.params.id, targetId, relation);
    ok(res, { linked: true, sourceId: req.params.id, targetId, relation: relation ?? null });
  } catch (e) {
    next(e);
  }
});

apiRouter.delete("/objects/:id/links/:targetId", async (req, res, next) => {
  try {
    const relation = typeof req.query.relation === "string" ? req.query.relation : undefined;
    await objectService.deleteLink(req.params.id, req.params.targetId, relation);
    ok(res, { deleted: true });
  } catch (e) {
    next(e);
  }
});

apiRouter.get("/objects/:id/backlinks", async (req, res, next) => {
  try {
    ok(res, await objectService.getBacklinks(req.params.id));
  } catch (e) {
    next(e);
  }
});

apiRouter.get("/objects/:id/linked", async (req, res, next) => {
  try {
    ok(res, await objectService.getLinkedObjects(req.params.id));
  } catch (e) {
    next(e);
  }
});

// ---------- blocks ----------

apiRouter.get("/objects/:id/blocks", async (req, res, next) => {
  try {
    ok(res, (await blockService.listBlocks(req.params.id)).map(serializeBlock));
  } catch (e) {
    next(e);
  }
});

apiRouter.post("/objects/:id/blocks", async (req, res, next) => {
  try {
    const input = createBlockSchema.parse(req.body);
    ok(res, serializeBlock(await blockService.createBlock(req.params.id, input)));
  } catch (e) {
    next(e);
  }
});

apiRouter.patch("/objects/:id/blocks/:blockId", async (req, res, next) => {
  try {
    const input = updateBlockSchema.parse(req.body);
    const block = await blockService.updateBlock(req.params.id, req.params.blockId, input);
    if (!block) throw new DomainError("BLOCK_NOT_FOUND", "Block not found");
    ok(res, serializeBlock(block));
  } catch (e) {
    next(e);
  }
});

apiRouter.post("/objects/:id/blocks/:blockId/move", async (req, res, next) => {
  try {
    const input = moveBlockSchema.parse(req.body);
    const block = await blockService.moveBlock(req.params.id, req.params.blockId, input);
    if (!block) throw new DomainError("BLOCK_NOT_FOUND", "Block not found");
    ok(res, serializeBlock(block));
  } catch (e) {
    next(e);
  }
});

apiRouter.delete("/objects/:id/blocks/:blockId", async (req, res, next) => {
  try {
    const deleted = await blockService.deleteBlock(req.params.id, req.params.blockId);
    if (!deleted) throw new DomainError("BLOCK_NOT_FOUND", "Block not found");
    ok(res, { deleted: true });
  } catch (e) {
    next(e);
  }
});

// ---------- tags ----------

apiRouter.get("/tags", async (req, res, next) => {
  try {
    const spaceId = await resolveSpaceId(req);
    ok(res, await tagService.listTags(spaceId));
  } catch (e) {
    next(e);
  }
});

// ---------- search ----------

apiRouter.get("/search", async (req, res, next) => {
  try {
    const spaceId = await resolveSpaceId(req);
    const { q, structureId, tag, limit } = searchQuerySchema.parse(req.query);
    const hits = await searchService.search(q, { spaceId, structureId, tag, limit });
    ok(res, hits, {
      query: q,
      count: hits.length,
      filters: { spaceId, structureId: structureId ?? null, tag: tag ?? null },
    });
  } catch (e) {
    next(e);
  }
});
