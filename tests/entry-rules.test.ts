import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The data-entry rules (public/assets/entry-rules.js) are what makes typing
 * behave like an editor instead of like a form: Enter splits a line, a list
 * continues itself, a paste becomes blocks. They are pure, so they are pinned
 * here; the DOM half (caret, focus, API round trips) is covered end-to-end in
 * e2e/entry.spec.ts.
 */
type Payload = { type: string; content: Record<string, unknown> };
type Inline = { text: string; marks: Array<{ type: string; from: number; to: number; href?: string }> };
type RulesApi = {
  LIST_TYPES: string[];
  isListType(type: string): boolean;
  splitAt(text: string, marks: Inline["marks"], offset: number): { head: Inline; tail: Inline };
  joinInline(a: Inline, b: Inline): Inline;
  enterContinue(block: { type: string }): Payload;
  enterExitsBlock(block: { type: string }, text: string): boolean;
  enterAction(block: { type: string }, text: string, hasChildren: boolean): "exit" | "insert" | "split";
  numberListRows<T extends { type: string; _number?: number }>(rows: T[]): T[];
  pasteHasBlocks(raw: string): boolean;
  safeHref(href: string): string;
  parseInlineMarkdown(text: string): Inline;
  markdownToBlocks(
    raw: string,
    opts?: { normalizeLang?: (lang: string) => string; normalizeTex?: (tex: string) => string },
  ): Payload[];
};

const source = fs.readFileSync(fileURLToPath(new URL("../public/assets/entry-rules.js", import.meta.url)), "utf8");
const sandbox: { NTEntry?: RulesApi } = {};
new Function("window", source)(sandbox);
const rules = sandbox.NTEntry!;

const aliases = (lang: string) => ({ js: "javascript", py: "python" }[lang] ?? (lang || "plaintext"));

describe("entry rules", () => {
  it("is loadable and exposes the rules the editor calls", () => {
    expect(rules).toBeTruthy();
    expect(rules.LIST_TYPES).toEqual(["todo", "bulleted_list", "numbered_list"]);
    expect(rules.isListType("todo")).toBe(true);
    expect(rules.isListType("quote")).toBe(false);
  });

  // ---------- Enter splits the line it stands on ----------
  it("splits text at the caret", () => {
    const split = rules.splitAt("hello world", [], 5);
    expect(split.head.text).toBe("hello");
    expect(split.tail.text).toBe(" world");
    // Enter at the very end keeps the whole line where it was
    expect(rules.splitAt("hello", [], 5).tail.text).toBe("");
    expect(rules.splitAt("hello", [], 0).head.text).toBe("");
  });

  it("clamps an out-of-range caret instead of dropping text", () => {
    const split = rules.splitAt("abc", [], 99);
    expect(split.head.text).toBe("abc");
    expect(split.tail.text).toBe("");
    expect(rules.splitAt("abc", [], -3).head.text).toBe("");
  });

  it("cuts a mark that crosses the split on both sides", () => {
    const marks = [{ type: "bold", from: 0, to: 11 }];
    const split = rules.splitAt("hello world", marks, 5);
    expect(split.head.marks).toEqual([{ type: "bold", from: 0, to: 5 }]);
    expect(split.tail.marks).toEqual([{ type: "bold", from: 0, to: 6 }]);
  });

  it("re-bases marks that survive wholly inside one half", () => {
    const marks = [{ type: "italic", from: 6, to: 11, href: undefined }];
    const split = rules.splitAt("hello world", marks, 5);
    expect(split.head.marks).toEqual([]);
    expect(split.tail.marks).toEqual([{ type: "italic", from: 1, to: 6 }]);
  });

  it("shifts the marks of the second line when two lines are joined", () => {
    const joined = rules.joinInline(
      { text: "abc", marks: [{ type: "bold", from: 0, to: 3 }] },
      { text: "de", marks: [{ type: "code", from: 0, to: 2 }] },
    );
    expect(joined.text).toBe("abcde");
    expect(joined.marks).toEqual([
      { type: "bold", from: 0, to: 3 },
      { type: "code", from: 3, to: 5 },
    ]);
  });

  it("continues the block the caret is in, not always a paragraph", () => {
    expect(rules.enterContinue({ type: "todo" })).toEqual({
      type: "todo",
      content: { text: "", marks: [], checked: false },
    });
    expect(rules.enterContinue({ type: "bulleted_list" }).type).toBe("bulleted_list");
    expect(rules.enterContinue({ type: "numbered_list" }).type).toBe("numbered_list");
    expect(rules.enterContinue({ type: "quote" }).type).toBe("quote");
    // a heading hands the caret back to a paragraph
    expect(rules.enterContinue({ type: "heading" }).type).toBe("paragraph");
    expect(rules.enterContinue({ type: "paragraph" }).type).toBe("paragraph");
    expect(rules.enterContinue(null).type).toBe("paragraph");
  });

  it("lets Enter on an empty list item or quote leave the block", () => {
    expect(rules.enterExitsBlock({ type: "todo" }, "")).toBe(true);
    expect(rules.enterExitsBlock({ type: "numbered_list" }, "")).toBe(true);
    expect(rules.enterExitsBlock({ type: "quote" }, "")).toBe(true);
    expect(rules.enterExitsBlock({ type: "todo" }, "still writing")).toBe(false);
    expect(rules.enterExitsBlock({ type: "paragraph" }, "")).toBe(false);
  });

  it("decides what Enter does: exit, insert or split", () => {
    // an empty list item leaves the block, children or not
    expect(rules.enterAction({ type: "todo" }, "", false)).toBe("exit");
    expect(rules.enterAction({ type: "todo" }, "", true)).toBe("exit");
    // a block that owns children only opens a line, its text is never split
    expect(rules.enterAction({ type: "paragraph" }, "parent line", true)).toBe("insert");
    expect(rules.enterAction({ type: "heading" }, "parent line", true)).toBe("insert");
    expect(rules.enterAction({ type: "numbered_list" }, "item", true)).toBe("insert");
    // an ordinary line splits at the caret
    expect(rules.enterAction({ type: "paragraph" }, "parent line", false)).toBe("split");
    expect(rules.enterAction({ type: "heading" }, "", false)).toBe("split");
  });

  // ---------- paste ----------
  it("tells a line of text apart from a clipboard full of blocks", () => {
    expect(rules.pasteHasBlocks("just a sentence")).toBe(false);
    expect(rules.pasteHasBlocks("one line\n")).toBe(false);
    expect(rules.pasteHasBlocks("")).toBe(false);
    expect(rules.pasteHasBlocks("   \n  ")).toBe(false);
    expect(rules.pasteHasBlocks("first line\nsecond line")).toBe(true);
    expect(rules.pasteHasBlocks("# Heading")).toBe(true);
    expect(rules.pasteHasBlocks("- item")).toBe(true);
    expect(rules.pasteHasBlocks("1. item")).toBe(true);
    expect(rules.pasteHasBlocks("- [ ] task")).toBe(true);
    expect(rules.pasteHasBlocks("> quoted")).toBe(true);
    expect(rules.pasteHasBlocks("```js")).toBe(true);
    expect(rules.pasteHasBlocks("---")).toBe(true);
  });

  it("only keeps links a block is allowed to carry", () => {
    expect(rules.safeHref("https://example.test/a")).toBe("https://example.test/a");
    expect(rules.safeHref("mailto:a@b.test")).toBe("mailto:a@b.test");
    expect(rules.safeHref("javascript:alert(1)")).toBe("");
    expect(rules.safeHref("data:text/html,x")).toBe("");
  });

  it("turns inline markdown into text + marks", () => {
    expect(rules.parseInlineMarkdown("plain words")).toEqual({ text: "plain words", marks: [] });
    expect(rules.parseInlineMarkdown("a **bold** b")).toEqual({
      text: "a bold b",
      marks: [{ type: "bold", from: 2, to: 6 }],
    });
    expect(rules.parseInlineMarkdown("`code`")).toEqual({
      text: "code",
      marks: [{ type: "code", from: 0, to: 4 }],
    });
    expect(rules.parseInlineMarkdown("[site](https://x.test)")).toEqual({
      text: "site",
      marks: [{ type: "link", from: 0, to: 4, href: "https://x.test" }],
    });
    // an unsafe scheme stays visible text, it never becomes a link
    const unsafe = rules.parseInlineMarkdown("[x](javascript:alert(1))");
    expect(unsafe.text).toBe("[x](javascript:alert(1))");
    expect(unsafe.marks).toEqual([]);
    expect(rules.parseInlineMarkdown("~~gone~~").marks[0].type).toBe("strike");
    expect(rules.parseInlineMarkdown("==hi==").marks[0].type).toBe("highlight");
    expect(rules.parseInlineMarkdown("*it*").marks[0].type).toBe("italic");
    // open delimiters are just characters
    expect(rules.parseInlineMarkdown("**not bold")).toEqual({ text: "**not bold", marks: [] });
  });

  it("builds blocks from a pasted document", () => {
    const blocks = rules.markdownToBlocks(
      [
        "# Title",
        "Intro paragraph.",
        "- bullet",
        "- [ ] open task",
        "- [x] done task",
        "1. first",
        "2) second",
        "> quote",
        "---",
      ].join("\n"),
    );
    expect(blocks.map((b) => b.type)).toEqual([
      "heading",
      "paragraph",
      "bulleted_list",
      "todo",
      "todo",
      "numbered_list",
      "numbered_list",
      "quote",
      "divider",
    ]);
    expect(blocks[0].content).toEqual({ level: 1, text: "Title", marks: [] });
    expect(blocks[3].content).toMatchObject({ text: "open task", checked: false });
    expect(blocks[4].content).toMatchObject({ text: "done task", checked: true });
  });

  it("keeps markdown formatting inside a pasted line", () => {
    const [block] = rules.markdownToBlocks("say **this** out loud");
    expect(block.content).toEqual({ text: "say this out loud", marks: [{ type: "bold", from: 4, to: 8 }] });
  });

  it("maps fenced code to the right block and language", () => {
    const blocks = rules.markdownToBlocks(
      ["```js", "const a = 1;", "```", "```mermaid", "graph TD", "```", "```math", "x^2", "```"].join("\n"),
      { normalizeLang: aliases, normalizeTex: (t) => t.trim() },
    );
    expect(blocks.map((b) => b.type)).toEqual(["code", "mermaid", "math"]);
    expect(blocks[0].content).toEqual({ language: "javascript", code: "const a = 1;" });
    expect(blocks[1].content).toEqual({ code: "graph TD" });
    expect(blocks[2].content).toEqual({ tex: "x^2", display: true });
  });

  it("reads $$ … $$ and drops blank separator lines", () => {
    const blocks = rules.markdownToBlocks("first\n\n\nsecond\n$$ a^2 $$\n");
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "paragraph", "math"]);
    expect(blocks[2].content).toEqual({ tex: "a^2", display: true });
  });

  it("never invents blocks out of nothing", () => {
    expect(rules.markdownToBlocks("")).toEqual([]);
    expect(rules.markdownToBlocks("\n\n")).toEqual([]);
  });

  // ---------- numbered lists are a stack of blocks, not an <ol> ----------
  it("numbers consecutive numbered blocks 1, 2, 3 …", () => {
    const rows = rules.numberListRows([
      { type: "paragraph" },
      { type: "numbered_list", _depth: 0 },
      { type: "numbered_list", _depth: 0 },
      { type: "numbered_list", _depth: 0 },
    ]);
    expect(rows.map((r) => r._number)).toEqual([0, 1, 2, 3]);
  });

  it("restarts the count after any other block interrupts the list", () => {
    const rows = rules.numberListRows([
      { type: "numbered_list", _depth: 0 },
      { type: "numbered_list", _depth: 0 },
      { type: "paragraph" },
      { type: "numbered_list", _depth: 0 },
      { type: "todo", _depth: 0 },
      { type: "numbered_list", _depth: 0 },
    ]);
    expect(rows.map((r) => r._number)).toEqual([1, 2, 0, 1, 0, 1]);
  });

  it("gives a nested list its own count and resumes the parent's after it", () => {
    const rows = rules.numberListRows([
      { type: "numbered_list", _depth: 0 },
      { type: "numbered_list", _depth: 1 },
      { type: "numbered_list", _depth: 1 },
      { type: "numbered_list", _depth: 0 },
    ]);
    expect(rows.map((r) => r._number)).toEqual([1, 1, 2, 2]);
  });

  it("survives an empty or rowwise-odd input", () => {
    expect(rules.numberListRows([])).toEqual([]);
    const rows = rules.numberListRows([null as unknown as { type: string }]);
    expect(rows.length).toBe(1);
  });
});
