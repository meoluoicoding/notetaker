import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * ISTQB — State Transition: sự kiện làm trạng thái chuyển đổi; test các chuyển
 * đổi hợp lệ (và biên đặc biệt) hơn là từng giá trị. Áp vào: đánh số list,
 * split/merge marks qua biên, fence mở-đóng trong markdown.
 */

const source = fs.readFileSync(fileURLToPath(new URL("../../public/assets/entry-rules.js", import.meta.url)), "utf8");
const sandbox: { NTEntry?: Record<string, (...args: unknown[]) => unknown> } = {};
new Function("window", source)(sandbox);
const rules = sandbox.NTEntry!;
const splitAt = rules.splitAt as (text: string, marks: unknown[], offset: number) => { head: unknown; tail: unknown };
const joinInline = rules.joinInline as (a: unknown, b: unknown) => { text: string; marks: unknown[] };
const numberListRows = rules.numberListRows as <T extends { type: string; _depth?: number }>(rows: T[]) => T[];
const markdownToBlocks = rules.markdownToBlocks as (raw: string) => Array<{ type: string; content: { code?: string } }>;

type Mark = { type: string; from: number; to: number };

describe("state transition: numbered-list counting", () => {
  const row = (type: string, depth = 0) => ({ type, _depth: depth });

  it("a run counts up", () => {
    expect(numberListRows([row("numbered_list"), row("numbered_list")]).map((r) => r._number)).toEqual([1, 2]);
  });
  it("any other block ends the run and restarts the count", () => {
    const rows = numberListRows([row("numbered_list"), row("paragraph"), row("numbered_list")]);
    expect(rows.map((r) => r._number)).toEqual([1, 0, 1]);
  });
  it("a sublist starts at 1; leaving it resumes the parent count", () => {
    const rows = numberListRows([
      row("numbered_list", 0),
      row("numbered_list", 1),
      row("numbered_list", 0),
    ]);
    expect(rows.map((r) => r._number)).toEqual([1, 1, 2]);
  });
});

describe("state transition: splitting a line keeps marks on both sides", () => {
  it("a bold mark crossing the split is cut, never dropped", () => {
    const marks: Mark[] = [{ type: "bold", from: 0, to: 4 }];
    const { head, tail } = splitAt("abcd", marks, 2);
    expect(head).toEqual({ text: "ab", marks: [{ type: "bold", from: 0, to: 2 }] });
    expect(tail).toEqual({ text: "cd", marks: [{ type: "bold", from: 0, to: 2 }] });
  });
  it("an offset outside the line clamps to the edge", () => {
    expect(splitAt("ab", [], -5)).toEqual({ head: { text: "", marks: [] }, tail: { text: "ab", marks: [] } });
    expect(splitAt("ab", [], 99)).toEqual({ head: { text: "ab", marks: [] }, tail: { text: "", marks: [] } });
  });
});

describe("state transition: merging shifts tail marks by head length", () => {
  it("joinInline re-bases the incoming marks", () => {
    const joined = joinInline({ text: "ab", marks: [] }, { text: "cd", marks: [{ type: "bold", from: 0, to: 1 }] });
    expect(joined.text).toBe("abcd");
    expect(joined.marks).toEqual([{ type: "bold", from: 2, to: 3 }]);
  });
});

describe("state transition: fences in markdown", () => {
  it("opening fence -> code; closing fence returns to text mode", () => {
    const blocks = markdownToBlocks("```js\na=1\n```\ntext after");
    expect(blocks.map((b) => b.type)).toEqual(["code", "paragraph"]);
    expect(blocks[0].content.code).toBe("a=1");
  });
  it("an UNCLOSED fence still yields one code block (state stays 'in fence')", () => {
    const blocks = markdownToBlocks("```py\nx=1\ny=2");
    expect(blocks.map((b) => b.type)).toEqual(["code"]);
    expect(blocks[0].content.code).toBe("x=1\ny=2");
  });
  it("fence language is lowercased (Mermaid is still a diagram)", () => {
    const blocks = markdownToBlocks("```MERMAID\nflow\n```");
    expect(blocks[0].type).toBe("mermaid");
  });
});