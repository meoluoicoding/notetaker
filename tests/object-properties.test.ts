import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DomainError } from "../src/shared/errors";

/**
 * An object's properties (a Project's status/due, a Book's rating …) are the
 * only domain value the app writes after creation besides blocks. This pins the
 * upsert/delete/coercion contract of `objectService.updateObjectProperties`.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notetaker-object-props-"));
process.env.DB_PATH = path.join(tmpDir, "object-props-test.db");

let objectService: typeof import("../src/services/object-service").objectService;
let structureService: typeof import("../src/services/structure-service").structureService;
let spaceService: typeof import("../src/services/space-service").spaceService;
let closeDb: () => void;

let spaceId = "";
let projectStruct: { id: string; name: string };
let projectId = "";

beforeAll(async () => {
  const client = await import("../src/db/client");
  await client.migrate();
  closeDb = () => client.rawSqlite.close();

  ({ objectService } = await import("../src/services/object-service"));
  ({ structureService } = await import("../src/services/structure-service"));
  ({ spaceService } = await import("../src/services/space-service"));

  spaceId = await spaceService.defaultSpaceId();
  projectStruct = await structureService.createStructure({
    spaceId,
    name: "Project",
    icon: "🚀",
    properties: [
      { name: "status", type: "select" },
      { name: "due", type: "date" },
      { name: "priority", type: "number" },
      { name: "done", type: "boolean" },
    ],
  });
  const created = await objectService.createObject({
    spaceId,
    structureId: projectStruct.id,
    title: "Notetaker MVP",
    properties: { status: "active" },
  });
  projectId = created.id;
});

afterAll(() => {
  closeDb?.();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("objectService.updateObjectProperties", () => {
  it("sets a property by slug and returns the hydrated object", async () => {
    const updated = await objectService.updateObjectProperties(projectId, { due: "2026-12-31" });
    expect(updated).toBeTruthy();
    expect(updated!.properties).toMatchObject({ status: "active", due: "2026-12-31" });
  });

  it("overwrites an existing value instead of duplicating rows", async () => {
    await objectService.updateObjectProperties(projectId, { status: "paused" });
    const updated = await objectService.updateObjectProperties(projectId, { status: "done" });
    expect(updated!.properties.status).toBe("done");
    // one row per (object, property) — the PK makes this structural, but pin it anyway
    expect(Object.keys(updated!.properties)).toHaveLength(2);
  });

  it("coerces number strings to numbers and rejects non-numeric values", async () => {
    await objectService.updateObjectProperties(projectId, { priority: "3" });
    let updated = await objectService.getObject(projectId);
    expect(updated!.properties.priority).toBe(3);
    await expect(
      objectService.updateObjectProperties(projectId, { priority: "high" })
    ).rejects.toThrow(DomainError);
  });

  it("accepts boolean strings", async () => {
    await objectService.updateObjectProperties(projectId, { done: "true" });
    const updated = await objectService.getObject(projectId);
    expect(updated!.properties.done).toBe(true);
  });

  it("removes a value when set to null or empty string", async () => {
    await objectService.updateObjectProperties(projectId, { due: null, status: "" });
    const updated = await objectService.getObject(projectId);
    expect(updated!.properties.due).toBeUndefined();
    expect(updated!.properties.status).toBeUndefined();
  });

  it("rejects keys that do not belong to the object's structure", async () => {
    await expect(
      objectService.updateObjectProperties(projectId, { bogus: "x" })
    ).rejects.toThrow("Unknown property");
  });

  it("does not touch objects of another structure or missing objects", async () => {
    const page = await objectService.createObject({
      spaceId,
      structureId: (
        await structureService.createStructure({ spaceId, name: "Plain", icon: "📄" })
      ).id,
      title: "No props",
    });
    await expect(
      objectService.updateObjectProperties(page.id, { status: "active" })
    ).rejects.toThrow("Unknown property");
    expect(await objectService.updateObjectProperties("00000000-0000-4000-8000-000000000000", { status: "x" }))
      .toBeNull();
  });
});