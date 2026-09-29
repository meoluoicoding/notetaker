import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { blockTypeSchema } from "../src/shared/schemas";

/**
 * The browser block registry (public/assets/block-registry.js) drives the slash
 * menu and the "+" toolbar. These tests keep it in sync with the server schema.
 */
type Def = {
  id: string;
  type: string;
  kind: string;
  label: string;
  icon: string;
  hint: string;
  keywords: string[];
  defaults: () => Record<string, unknown>;
};
type Registry = {
  definitions: Def[];
  byId(id: string): Def | null;
  byType(type: string): Def | null;
  match(query: string): Def[];
  renderedTypes(): string[];
};

const sandbox: { NTBlocks?: Registry } = {};
const source = fs.readFileSync(fileURLToPath(new URL("../public/assets/block-registry.js", import.meta.url)), "utf8");
new Function("window", source)(sandbox);
const registry = sandbox.NTBlocks!;

const serverTypes = new Set<string>(blockTypeSchema.options);

describe("block registry", () => {
  it("is loadable and exposes the registry API", () => {
    expect(registry).toBeTruthy();
    expect(registry.definitions.length).toBeGreaterThanOrEqual(10);
    expect(registry.renderedTypes()).toEqual(["code", "math", "mermaid", "plantuml", "d2", "whiteboard"]);
  });

  it("only uses block types the server accepts", () => {
    for (const def of registry.definitions) {
      expect(serverTypes.has(def.type), `${def.id} -> ${def.type}`).toBe(true);
    }
  });

  it("has unique ids and complete metadata", () => {
    const ids = registry.definitions.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const def of registry.definitions) {
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.icon.length).toBeGreaterThan(0);
      expect(def.hint.length).toBeGreaterThan(0);
      expect(def.keywords.length).toBeGreaterThan(0);
      for (const kw of def.keywords) expect(kw).toBe(kw.toLowerCase());
    }
  });

  it("returns schema-shaped defaults for every block", () => {
    for (const def of registry.definitions) {
      const content = def.defaults();
      expect(typeof content).toBe("object");
      if (def.kind === "text") {
        expect(Object.keys(content).every((k) => ["text", "level", "checked"].includes(k))).toBe(true);
      }
      if (def.type === "code") expect(content).toMatchObject({ language: expect.any(String), code: expect.any(String) });
      if (def.type === "math") expect(content).toMatchObject({ tex: expect.any(String), display: expect.any(Boolean) });
      if (def.type === "mermaid") expect(content).toMatchObject({ code: expect.any(String) });
      if (def.type === "plantuml") expect(content).toMatchObject({ code: expect.any(String) });
      if (def.type === "d2") expect(content).toMatchObject({ code: expect.any(String) });
      if (def.type === "whiteboard") expect(content).toMatchObject({ snapshot: null });
    }
  });

  it("covers the four block kinds the slash menu promises", () => {
    for (const [query, expectedType] of [
      ["note", "paragraph"],
      ["codeblock", "code"],
      ["mermaid", "mermaid"],
      ["plantuml", "plantuml"],
      ["d2", "d2"],
      ["whiteboard", "whiteboard"],
      ["latex", "math"],
    ] as const) {
      const labels = registry.match(query).map((d) => d.type);
      expect(labels, `/${query}`).toContain(expectedType);
    }
  });

  it("filters as the user types and is case-insensitive", () => {
    expect(registry.match("").length).toBe(registry.definitions.length);
    expect(registry.match("MER")[0].id).toBe("mermaid");
    expect(registry.match("H1")[0].type).toBe("heading");
    expect(registry.match("zzzzqqq")).toEqual([]);
  });

  it("ranks exact keywords above prefixes", () => {
    // "/tex" must offer the LaTeX block even though "text" also starts with tex
    expect(registry.match("tex")[0].id).toBe("math");
    expect(registry.match("tex").map((d) => d.id)).toContain("note");
    expect(registry.match("text")[0].id).toBe("note");
    expect(registry.match("code")[0].type).toBe("code");
  });

  it("maps types back to definitions (used to pick the source field)", () => {
    expect(registry.byType("code")?.defaults()).toHaveProperty("code");
    expect(registry.byType("math")?.defaults()).toHaveProperty("tex");
    expect(registry.byId("divider")?.type).toBe("divider");
    expect(registry.byType("nope")).toBeNull();
  });
});
