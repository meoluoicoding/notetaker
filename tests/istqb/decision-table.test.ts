import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * ISTQB — Decision Table: không test từng case rời rạc mà liệt kê MỌI tổ hợp
 * điều kiện -> hành động và khẳng định từng dòng. Ở đây là bảng thật của
 * enterAction (3 điều kiện = 8 dòng) + bảng diễn giải marker của markdownToBlocks.
 */

const source = fs.readFileSync(fileURLToPath(new URL("../../public/assets/entry-rules.js", import.meta.url)), "utf8");
const sandbox: { NTEntry?: Record<string, (...args: unknown[]) => unknown> } = {};
new Function("window", source)(sandbox);
const rules = sandbox.NTEntry!;
const enterAction = rules.enterAction as (block: { type: string }, text: string, hasChildren: boolean) => string;
const markdownToBlocks = rules.markdownToBlocks as (
  raw: string,
  opts?: { normalizeLang?: (lang: string) => string; normalizeTex?: (tex: string) => string },
) => Array<{ type: string; content: Record<string, unknown> }>;

describe("decision table: enterAction (C1 emptyText, C2 hasChildren, C3 listOrQuote)", () => {
  type Action = "exit" | "insert" | "split";
  // dòng bảng: [C1 empty, C2 children, C3 list/quote, expected]
  const table: Array<[boolean, boolean, boolean, Action]> = [
    [false, false, false, "split"],
    [false, false, true, "split"],
    [false, true, false, "insert"],
    [false, true, true, "insert"],
    [true, false, false, "split"],
    [true, false, true, "exit"],
    [true, true, false, "insert"],
    [true, true, true, "exit"],
  ];
  const types = { list: "todo", quote: "quote", other: "paragraph" };
  for (const [empty, children, isList, expected] of table) {
    it(`empty=${empty} children=${children} listOrQuote=${isList} -> ${expected}`, () => {
      const type = isList ? types.list : types.other;
      expect(enterAction({ type: type as string }, empty ? "" : "abc", children)).toBe(expected);
      if (isList) expect(enterAction({ type: types.quote }, empty ? "" : "abc", children)).toBe(expected);
    });
  }
});

describe("decision table: markdownToBlocks line grammar (marker -> block type)", () => {
  const convert = (input: string) => markdownToBlocks(input).map((b) => b.type);
  const cases: Array<[string, string[]]> = [
    ["plain text", ["paragraph"]],
    ["", []],
    ["# H", ["heading"]],
    ["###### H", ["heading"]],
    ["#NoSpace", ["paragraph"]], // cần khoảng trắng sau #
    ["- [ ] t", ["todo"]],
    ["- [x] t", ["todo"]],
    ["- a", ["bulleted_list"]],
    ["1. a", ["numbered_list"]],
    ["1) a", ["numbered_list"]],
    ["> q", ["quote"]],
    ["---", ["divider"]],
    ["___", ["divider"]],
    ["**bold**", ["paragraph"]], // marker không ở đầu dòng thì là nội dung
    ["```js\nx\n```", ["code"]],
    ["```mermaid\nx\n```", ["mermaid"]],
    ["```math\nx\n```", ["math"]],
    ["$$x$$", ["math"]],
    ["a\n\nb", ["paragraph", "paragraph"]], // dòng trống tách block
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} -> ${expected.join(", ")}`, () => {
      expect(convert(input)).toEqual(expected);
    });
  }

  it("heading level and todo checked survive the table rows", () => {
    const heading = markdownToBlocks("## Two")[0];
    expect(heading.type).toBe("heading");
    expect(heading.content.level).toBe(2);
    const done = markdownToBlocks("- [x] fin")[0];
    expect((done.content as { checked: boolean }).checked).toBe(true);
    const open = markdownToBlocks("- [ ] todo")[0];
    expect((open.content as { checked: boolean }).checked).toBe(false);
  });
});