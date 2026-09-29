import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ISTQB — Error Guessing: các lỗi điển hình dễ bỏ sót — injection qua query/URL,
 * offset NaN, đầu vào rỗng/lớn, prefix đè dấu.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notetaker-istqb-eg-"));
process.env.DB_PATH = path.join(tmpDir, "eg.db");
type TermsModule = typeof import("../../src/services/search-service");
let toTerms: TermsModule["toTerms"];
let buildSnippet: TermsModule["buildSnippet"];

const source = fs.readFileSync(fileURLToPath(new URL("../../public/assets/entry-rules.js", import.meta.url)), "utf8");
const sandbox: { NTEntry?: Record<string, (...args: unknown[]) => unknown> } = {};
new Function("window", source)(sandbox);
const rules = sandbox.NTEntry!;
const splitAt = rules.splitAt as (text: string, marks: unknown[], offset: number) => { head: { text: string } };
const safeHref = rules.safeHref as (href: string | null | undefined) => string;
const markdownToBlocks = rules.markdownToBlocks as (raw: string | null | undefined) => unknown[];

describe("error guessing: search helpers", () => {
  it("quote characters in a query are stripped, not injected into FTS", async () => {
    ({ toTerms } = await import("../../src/services/search-service"));
    expect(toTerms('"rust" AND own')).toEqual(["rust", "and", "own"]);
  });

  it("a very long query does not blow up", async () => {
    ({ toTerms, buildSnippet } = await import("../../src/services/search-service"));
    const long = "x".repeat(10_000);
    expect(Array.isArray(toTerms(long))).toBe(true);
    expect(buildSnippet(long.slice(0, 6000), ["y"], 48)).not.toBeNull();
  });

  it("snippet survives a missing term (diacritic folding path)", async () => {
    ({ buildSnippet } = await import("../../src/services/search-service"));
    expect(buildSnippet("", ["x"])).toBeNull();
    expect(buildSnippet("short text", ["nope"])).toBe("short text");
    expect(buildSnippet("x".repeat(200), ["nope"], 48)).toMatch(/^x{96}…$/); // radius*2 + ellipsis
  });
});

describe("error guessing: href across schemes", () => {
  it("uppercase scheme is still recognised as safe/unsafe", () => {
    expect(safeHref("HTTP://example.com")).toBe("HTTP://example.com");
    expect(safeHref("JAVASCRIPT:alert(1)")).toBe("");
  });
  it("null/undefined href -> empty (no crash)", () => {
    expect(safeHref(null)).toBe("");
    expect(safeHref(undefined)).toBe("");
  });
});

describe("error guessing: offsets and empty input", () => {
  it("a non-numeric offset behaves like 0", () => {
    expect(splitAt("abc", [], "oops" as unknown as number).head.text).toBe("");
  });
  it("markdownToBlocks tolerates null/undefined", () => {
    expect(markdownToBlocks(null)).toEqual([]);
    expect(markdownToBlocks(undefined)).toEqual([]);
  });
});