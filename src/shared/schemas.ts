import { z } from "zod";

export const propertyTypeSchema = z.enum([
  "text",
  "number",
  "boolean",
  "date",
  "datetime",
  "select",
  "multi_select",
  "object",
  "multi_object",
  "url",
]);

export const blockTypeSchema = z.enum([
  "paragraph",
  "heading",
  "todo",
  "bulleted_list",
  "numbered_list",
  "quote",
  "code",
  "math",
  "mermaid",
  "plantuml",
  "d2",
  "whiteboard",
  "image",
  "divider",
  "object",
  "bookmark",
  "table",
]);

export const createObjectSchema = z.object({
  structureId: z.string().uuid(),
  title: z.string().min(1).max(500),
  description: z.string().max(2000).optional(),
  icon: z.string().max(32).optional(),
  coverUrl: z.string().url().optional(),
  properties: z.record(z.string().uuid(), z.unknown()).optional(),
  tags: z.array(z.string().min(1).max(100)).optional(),
  blocks: z
    .array(
      z.object({
        type: blockTypeSchema,
        content: z.unknown(),
        parentId: z.string().uuid().nullish(),
        position: z.number().int().min(0).optional(),
      })
    )
    .optional(),
});

export const updateObjectPropertiesSchema = z.object({
  /** Keys are property definition ids or slugs; null/"" removes the value. */
  properties: z.record(z.string(), z.unknown()),
});

export const updateObjectSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(2000).nullish(),
  icon: z.string().max(32).nullish(),
  coverUrl: z.string().url().nullish(),
});

export const createBlockSchema = z.object({
  type: blockTypeSchema,
  content: z.unknown(),
  parentId: z.string().uuid().nullish(),
  position: z.number().int().min(0).optional(),
});

export const updateBlockSchema = z.object({
  content: z.unknown().optional(),
  type: blockTypeSchema.optional(),
});

export const moveBlockSchema = z.object({
  parentId: z.string().uuid().nullish(),
  position: z.number().int().min(0),
});

export const searchQuerySchema = z.object({
  q: z.string().max(200).default(""),
  structureId: z.string().uuid().optional(),
  tag: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

export const createStructureSchema = z.object({
  name: z.string().min(1).max(200),
  icon: z.string().max(32).optional(),
  properties: z
    .array(
      z.object({
        name: z.string().min(1).max(200),
        type: propertyTypeSchema,
      })
    )
    .optional(),
});

export const updateStructureSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  icon: z.string().max(32).nullish(),
});

export const createSpaceSchema = z.object({
  name: z.string().min(1).max(120),
  icon: z.string().max(32).optional(),
});

export const updateSpaceSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  icon: z.string().max(32).nullish(),
});

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
