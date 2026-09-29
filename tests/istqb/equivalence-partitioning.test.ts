import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ISTQB — Equivalence Partitioning: chia miền đầu vào thành các lớp tương đương,
 * test 1 đại diện mỗi lớp. Không cần nhiều giá trị trong cùng 1 lớp.
 */

// ---- search-service pure helpers (DB_PATH temp để không chạm DB thật) ----
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "notetaker-istqb-ep-"));
process.env.DB_PATH = path.join(tmpDir, "ep.db");
type TermsModule = typeof import("../../src/services/search-service");
let toTerms: TermsModule["toTerms"];
let toFtsQuery: TermsModule["toFtsQuery"];

// ---- entry-rules (sandbox) ----
const source = fs.readFileSync(fileURLToPath(new URL("../../public/assets/entry-rules.js", import.meta.url)), "utf8");
const sandbox: { NTEntry?: Record<string, (...args: unknown[]) => unknown> } = {};
new Function("window", source)(sandbox);
const rules = sandbox.NTEntry!;
const enterAction = rules.enterAction as (block: { type: string }, text: string, hasChildren: boolean) => string;
const pasteHasBlocks = rules.pasteHasBlocks as (raw: string) => boolean;
const safeHref = rules.safeHref as (href: string) => string;

describe("equivalence partitioning: toTerms / toFtsQuery", () => {
  it("word classes", async () => {
    ({ toTerms, toFtsQuery } = await import("../../src/services/search-service"));
    // empty / whitespace-only
    expect(toTerms("")).toEqual([]);
    expect(toTerms("   \t ")).toEqual([]);
    // single word
    expect(toTerms("Rust")).toEqual(["rust"]);
    // multi-word
    expect(toTerms("Rust Ownership")).toEqual(["rust", "ownership"]);
    // unicode diacritics are kept (search-service contract)
    expect(toTerms("bộ nhớ")).toEqual(["bộ", "nhớ"]);
    // numeric-only
    expect(toTerms("2026")).toEqual(["2026"]);
    // punctuation/symbol-only (no terms)
    expect(toTerms("!!?)!")).toEqual([]);
    // mixed word + punctuation splits it
    expect(toTerms("Rust-2.0")).toEqual(["rust", "2", "0"]);

    // FTS query: every term as a required prefix
    expect(toFtsQuery("Rust Own")).toBe('"rust"* AND "own"*');
    expect(toFtsQuery(" ")).toBeNull();
  });
});

describe("equivalence partitioning: enterAction", () => {
  it("returns one representative result per class", () => {
    // list/quote + empty → exit (typing your way out of the list)
    expect(enterAction({ type: "todo" }, "", false)).toBe("exit");
    // split: ordinary non-empty line, no children
    expect(enterAction({ type: "paragraph" }, "text", false)).toBe("split");
    // insert: parent owns children → never split
    expect(enterAction({ type: "paragraph" }, "text", true)).toBe("insert");
    // list + text + no children → split (fills happens on the non-empty item)
    expect(enterAction({ type: "bulleted_list" }, "item", false)).toBe("split");
  });
});

describe("equivalence partitioning: pasteHasBlocks", () => {
  it("one representative per paste class", () => {
    expect(pasteHasBlocks("")).toBe(false); // empty
    expect(pasteHasBlocks("plain text")).toBe(false); // single plain line
    expect(pasteHasBlocks("line1\nline2")).toBe(true); // multi-line block set
    expect(pasteHasBlocks("- item")).toBe(true); // markdown marker on one line
    expect(pasteHasBlocks("```js\nx\n```")).toBe(true); // fence
  });
});

describe("equivalence partitioning: safeHref", () => {
  it("keeps safe schemes, drops executable/unknown", () => {
    expect(safeHref("https://example.com")).toBe("https://example.com");
    expect(safeHref("http://example.com")).toBe("http://example.com");
    expect(safeHref("mailto:a@b.c")).toBe("mailto:a@b.c");
    expect(safeHref("#anchor")).toBe("#anchor");
    expect(safeHref("/local/path")).toBe("/local/path");
    // executable / unknown → empty
    expect(safeHref("javascript:alert(1)")).toBe("");
    expect(safeHref("data:text/html,x")).toBe("");
    expect(safeHref("ftp://x")).toBe("");
  });
});