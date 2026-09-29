import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The inline-mark model (public/assets/inline-marks.js) owns the markdown
 * shortcut rules and the `{ text, marks }` shape. The DOM half (apply /
 * serialize) is covered end-to-end in e2e/inline-format.spec.ts; these tests
 * pin everything that is pure.
 */
const source = fs.readFileSync(fileURLToPath(new URL("../public/assets/inline-marks.js", import.meta.url)), "utf8");
const sandbox: { NTMarks?: MarksApi } = {};
new Function("window", source)(sandbox);
const marks = sandbox.NTMarks!;

type Mark = { type: string; from: number; to: number; href?: string; objectId?: string };
type MarksApi = {
  TYPES: string[];
  classFor(type: string): string;
  normalizeMarks(text: string, marks: Mark[]): Mark[];
  blockRule(text: string): { type: string; content: Record<string, unknown>; rest: string } | null;
  inlineRule(before: string): { type: string; inner: string; from: number; to: number; start: number; end: number } | null;
};

describe("inline marks", () => {
  it("exposes the mark types the editor offers", () => {
    expect(marks.classFor("bold")).toBe("m-bold");
    expect(marks.TYPES).toContain("highlight");
    expect(marks.TYPES).toContain("object");
  });

  it("normalizes, clamps and drops empty marks", () => {
    const out = marks.normalizeMarks("hello", [
      { type: "bold", from: 0, to: 5 },
      { type: "bold", from: 3, to: 3 },
      { type: "nope", from: 0, to: 2 },
      { type: "italic", from: 2, to: 40 },
    ]);
    expect(out).toEqual([
      { type: "bold", from: 0, to: 5 },
      { type: "italic", from: 2, to: 5 },
    ]);
  });

  it("keeps href/objectId only when present", () => {
    const out = marks.normalizeMarks("abc", [{ type: "link", from: 0, to: 3, href: "https://x.test" }]);
    expect(out).toEqual([{ type: "link", from: 0, to: 3, href: "https://x.test" }]);
  });

  // ---------- markdown shortcuts ----------
  it("converts block markers at the start of a line", () => {
    expect(marks.blockRule("# Title")?.type).toBe("heading");
    expect(marks.blockRule("## Title")?.content).toEqual({ level: 2, text: "Title" });
    expect(marks.blockRule("### Title")?.content).toEqual({ level: 3, text: "Title" });
    expect(marks.blockRule("- item")?.type).toBe("bulleted_list");
    expect(marks.blockRule("* item")?.content).toEqual({ text: "item" });
    expect(marks.blockRule("1. first")?.type).toBe("numbered_list");
    expect(marks.blockRule("> quoted")?.type).toBe("quote");
    expect(marks.blockRule("[] task")?.type).toBe("todo");
    expect(marks.blockRule("- [ ] task")?.content).toEqual({ text: "task", checked: false });
    expect(marks.blockRule("---")?.type).toBe("divider");
    expect(marks.blockRule("```js ")?.content).toEqual({ language: "js", code: "" });
    expect(marks.blockRule("``` ")?.content).toEqual({ language: "plaintext", code: "" });
    expect(marks.blockRule("```")).toBeNull();
    expect(marks.blockRule("$$ x^2")?.content).toEqual({ tex: "x^2", display: true });
  });

  it("leaves ordinary text alone", () => {
    for (const text of ["", "hello", "#hashtag", "a - b", "2+2", "just text"]) {
      expect(marks.blockRule(text), text).toBeNull();
    }
  });

  it("detects inline markers only once they are closed", () => {
    expect(marks.inlineRule("**bold")).toBeNull();
    const rule = marks.inlineRule("**bold**");
    expect(rule?.type).toBe("bold");
    expect(rule?.inner).toBe("bold");
    expect(rule?.start).toBe(0);
    expect(rule?.end).toBe(8);
    expect(marks.inlineRule("a `code`")?.type).toBe("code");
    expect(marks.inlineRule("a `code`")?.inner).toBe("code");
    expect(marks.inlineRule("~~gone~~")?.type).toBe("strike");
    expect(marks.inlineRule("==mark==")?.type).toBe("highlight");
    expect(marks.inlineRule("*it*")?.type).toBe("italic");
    expect(marks.inlineRule("**")).toBeNull();
    expect(marks.inlineRule("****")).toBeNull();
  });
});
