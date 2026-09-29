import { describe, expect, it } from "vitest";
import {
  createObjectSchema,
  createStructureSchema,
  updateObjectSchema,
  searchQuerySchema,
  createBlockSchema,
  moveBlockSchema,
  updateObjectPropertiesSchema,
} from "../../src/shared/schemas";

/**
 * ISTQB — Boundary Value Analysis: giá trị min/max và ±1 của mọi giới hạn.
 * Giới hạn lấy thẳng từ src/shared/schemas.ts (không phát minh).
 */

const ok = (schema: Parameters<typeof createObjectSchema.safeParse>[0], value: unknown) =>
  expect(schema.safeParse(value).success).toBe(true);
const bad = (schema: Parameters<typeof createObjectSchema.safeParse>[0], value: unknown) =>
  expect(schema.safeParse(value).success).toBe(false);
const tryCreate = createObjectSchema.safeParse; // helper typing

describe("boundary: createObjectSchema", () => {
  const base = { structureId: "a0000000-0000-4000-8000-000000000000", title: "t" };

  it("title: 1 and 500 ok; 0 and 501 fail", () => {
    ok(createObjectSchema, { ...base, title: "x" });
    ok(createObjectSchema, { ...base, title: "x".repeat(500) });
    bad(createObjectSchema, { ...base, title: "" });
    bad(createObjectSchema, { ...base, title: "x".repeat(501) });
  });

  it("description: 2000 ok; 2001 and null fail (optional ≠ nullish)", () => {
    ok(createObjectSchema, { ...base, description: "x".repeat(2000) });
    bad(createObjectSchema, { ...base, description: "x".repeat(2001) });
    bad(createObjectSchema, { ...base, description: null });
    ok(createObjectSchema, { ...base });
  });

  it("icon: 32 ok; 33 fail", () => {
    ok(createObjectSchema, { ...base, icon: "x".repeat(32) });
    bad(createObjectSchema, { ...base, icon: "x".repeat(33) });
  });

  it("tags: item length 1 and 100 ok; 0 and 101 fail", () => {
    ok(createObjectSchema, { ...base, tags: ["t"] });
    ok(createObjectSchema, { ...base, tags: ["t".repeat(100)] });
    bad(createObjectSchema, { ...base, tags: [""] });
    bad(createObjectSchema, { ...base, tags: ["t".repeat(101)] });
  });
});

describe("boundary: searchQuerySchema", () => {
  it("q: 200 ok; 201 fail", () => {
    ok(searchQuerySchema, { q: "x".repeat(200) });
    bad(searchQuerySchema, { q: "x".repeat(201) });
    ok(searchQuerySchema, { q: undefined });
  });

  it("limit: 1 and 50 ok; 0 and 51 fail (also coerced strings)", () => {
    ok(searchQuerySchema, { limit: 1 });
    ok(searchQuerySchema, { limit: 50 });
    ok(searchQuerySchema, { limit: "50" }); // coerce
    bad(searchQuerySchema, { limit: 0 });
    bad(searchQuerySchema, { limit: 51 });
  });
});

describe("boundary: structure name", () => {
  it("name: 1 and 200 ok; 0 and 201 fail", () => {
    ok(createStructureSchema, { name: "x" });
    ok(createStructureSchema, { name: "x".repeat(200) });
    bad(createStructureSchema, { name: "" });
    bad(createStructureSchema, { name: "x".repeat(201) });
  });
});

describe("boundary: object + block positions", () => {
  it("move block position: 0 ok; -1 fail (integer)", () => {
    ok(moveBlockSchema, { parentId: null, position: 0 });
    bad(moveBlockSchema, { parentId: null, position: -1 });
    bad(moveBlockSchema, { parentId: null, position: 1.5 });
  });

  it("createBlock position: 0 ok; -1 fail", () => {
    ok(createBlockSchema, { type: "paragraph", content: {}, position: 0 });
    bad(createBlockSchema, { type: "paragraph", content: {}, position: -1 });
  });
});

describe("boundary: updateObjectProperties", () => {
  it("accepts arbitrary keys (id or slug) and any JSON value", () => {
    ok(updateObjectPropertiesSchema, { properties: { status: "done", due: "2026-10-15" } });
    ok(updateObjectPropertiesSchema, { properties: { "a0000000-0000-4000-8000-000000000000": null } });
    // non-serializable values are still schema-valid at the boundary
    bad(updateObjectPropertiesSchema, { properties: 42 });
  });
});
void tryCreate;
void updateObjectSchema;