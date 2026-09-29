import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getNativeSearch } from "../src/search/native-search";

/**
 * Smoke test for the optional Tantivy native layer. Skipped automatically when
 * `search-native/search-native.node` has not been built (npm run build:native) —
 * the FTS5 pipeline must keep working without it.
 */

const native = getNativeSearch();
const enabled = !!native;

describe.skipIf(!enabled)("native search (Tantivy via napi-rs)", () => {
  let dir = "";
  afterAll(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* already gone */
    }
  });

  it("indexes, counts and searches with prefix + typo tolerance", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "nt-tantivy-"));
    native!.init(dir);
    native!.add([
      {
        id: "a",
        title: "Notetaker MVP",
        body: "Key insight: complexity should be pushed to the edges.",
        tags: "productivity",
      },
      {
        id: "b",
        title: "Reading Tracker",
        body: "A todo list for books.",
        tags: "reading",
      },
    ]);
    expect(native!.count()).toBe(2);

    // prefix match on the title
    expect(native!.search("noteta", 5).map((h) => h.id)).toContain("a");
    // typo ("notetakr") still finds "Notetaker" — fuzzy term query
    expect(native!.search("notetakr", 5).map((h) => h.id)).toContain("a");
    // body text match
    expect(native!.search("complexity", 5).map((h) => h.id)).toContain("a");
    // tag match
    expect(native!.search("reading", 5).map((h) => h.id)).toContain("b");

    // delete removes the document
    native!.remove(["a"]);
    expect(native!.count()).toBe(1);
    expect(native!.search("notetaker", 5).map((h) => h.id)).not.toContain("a");
  });
});