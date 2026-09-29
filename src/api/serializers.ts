import type { BlockRow } from "../db/schema";

export interface SerializedBlock {
  id: string;
  objectId: string;
  parentId: string | null;
  position: number;
  type: string;
  content: unknown;
  createdAt: string;
  updatedAt: string;
}

export function serializeBlock(row: BlockRow): SerializedBlock {
  let content: unknown = {};
  try {
    content = row.content_json ? JSON.parse(row.content_json) : {};
  } catch {
    content = {};
  }
  return {
    id: row.id,
    objectId: row.object_id,
    parentId: row.parent_id,
    position: row.position,
    type: row.type,
    content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
