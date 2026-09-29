/**
 * Data-entry rules for the block editor.
 *
 * Everything the editor needs to turn a keystroke or a clipboard into block
 * operations, as pure functions — no DOM, no Alpine, no fetch — so the rules
 * stay unit-testable (tests/entry-rules.test.ts) and app.js only performs them:
 *
 *   Enter   -> split the line at the caret, not "always a new paragraph"
 *   shape   -> which block continues a line (a todo stays a todo, a heading does not)
 *   paste   -> one line stays a line, a clipboard full of blocks becomes blocks
 *
 * The markdown-lite parser lives here too: the block paste path and the
 * "New object" form build the same blocks from the same text.
 */
(function (global) {
  var LIST_TYPES = ["todo", "bulleted_list", "numbered_list"];
  var MARK_TYPES = ["bold", "italic", "underline", "strike", "code", "highlight", "link", "object"];

  /** A line that carries block syntax: heading, item, todo, quote, fence, rule, math. */
  var BLOCK_MARKER = /^\s*(#{1,6}\s|[-*+]\s|\[[ xX]?\]|\d+[.)]\s|>\s|```|~~~|-{3,}|\*{3,}|_{3,}|\$\$)/;

  function isListType(type) {
    return LIST_TYPES.indexOf(type) > -1;
  }

  /** Marks covering `[from, to)`, re-based to 0; href/objectId survive. */
  function sliceMarks(marks, from, to) {
    var out = [];
    (marks || []).forEach(function (m) {
      if (!m || MARK_TYPES.indexOf(m.type) < 0) return;
      var start = Math.max(Number(m.from) || 0, from);
      var end = Math.min(Number(m.to) || 0, to);
      if (end <= start) return;
      var kept = { type: m.type, from: start - from, to: end - from };
      if (m.href) kept.href = m.href;
      if (m.objectId) kept.objectId = m.objectId;
      out.push(kept);
    });
    return out.sort(function (a, b) { return a.from - b.from || a.to - b.to; });
  }

  /**
   * Split a line at `offset` — what Enter does. Each half keeps its share of the
   * marks (a mark crossing the split is cut on both sides, never dropped).
   */
  function splitAt(text, marks, offset) {
    var str = text == null ? "" : String(text);
    var at = Math.max(0, Math.min(Math.round(Number(offset) || 0), str.length));
    return {
      head: { text: str.slice(0, at), marks: sliceMarks(marks, 0, at) },
      tail: { text: str.slice(at), marks: sliceMarks(marks, at, str.length) },
    };
  }

  /** `a` + `b` as one line: b's marks shift right by a's length (backspace/Delete merge). */
  function joinInline(a, b) {
    var head = a || { text: "", marks: [] };
    var tail = b || { text: "", marks: [] };
    var headText = head.text == null ? "" : String(head.text);
    var shifted = (tail.marks || []).map(function (m) {
      var moved = { type: m.type, from: m.from + headText.length, to: m.to + headText.length };
      if (m.href) moved.href = m.href;
      if (m.objectId) moved.objectId = m.objectId;
      return moved;
    });
    return {
      text: headText + (tail.text == null ? "" : String(tail.text)),
      marks: (head.marks || []).concat(shifted),
    };
  }

  /**
   * The shape of the block Enter creates below `block`. A list keeps its marker
   * (the number comes from the list, not from the item), a quote keeps quoting,
   * a heading hands the caret back to a paragraph.
   */
  function enterContinue(block) {
    var type = block && block.type;
    if (type === "todo") return { type: "todo", content: { text: "", marks: [], checked: false } };
    if (type === "bulleted_list") return { type: "bulleted_list", content: { text: "", marks: [] } };
    if (type === "numbered_list") return { type: "numbered_list", content: { text: "", marks: [] } };
    if (type === "quote") return { type: "quote", content: { text: "", marks: [] } };
    return { type: "paragraph", content: { text: "", marks: [] } };
  }

  /**
   * Enter on an empty list item or quote leaves the block instead of adding one
   * more: that is how every editor lets you type your way out of a list.
   */
  function enterExitsBlock(block, text) {
    var type = block && block.type;
    if (!isListType(type) && type !== "quote") return false;
    return !String(text == null ? "" : text).length;
  }

  /**
   * What Enter does to the line the caret is in:
   *
   *   "exit"   an empty list item or quote leaves the block (becomes a paragraph)
   *   "insert" the line owns child blocks: only open a new line, never split —
   *            splitting would cut the parent's sentence around its own children
   *   "split"  ordinary line: the text after the caret moves to the new line
   */
  function enterAction(block, text, hasChildren) {
    if (enterExitsBlock(block, text)) return "exit";
    return hasChildren ? "insert" : "split";
  }

  /**
   * Does this clipboard carry blocks, or just a line of text? A single line is
   * typed in at the caret; anything else (or a markdown marker) is built as blocks.
   */
  function pasteHasBlocks(raw) {
    var text = String(raw == null ? "" : raw).replace(/\r\n?/g, "\n").replace(/\n+$/, "");
    if (!text.trim()) return false;
    if (text.indexOf("\n") > -1) return true;
    return BLOCK_MARKER.test(text);
  }

  /** Only links a block may carry: no javascript:/data: URLs from a clipboard. */
  function safeHref(href) {
    var url = String(href == null ? "" : href);
    return /^(https?:\/\/|mailto:|#|\/)/i.test(url) ? url : "";
  }

  /**
   * Inline markdown of one line -> `{ text, marks }`. One level deep (the
   * editor's own model), and the delimiters never reach the DOM as HTML.
   */
  function parseInlineMarkdown(text) {
    var str = text == null ? "" : String(text);
    var out = { text: "", marks: [] };
    var re = /\[([^\]\n]+)\]\(([^)\s]+)\)|`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|~~([^~\n]+)~~|==([^=\n]+)==|\*([^*\n]+)\*|_([^_\n]+)_/g;
    var last = 0;
    var m;

    function push(plain, mark) {
      var start = out.text.length;
      out.text += plain;
      if (mark && plain.length) {
        mark.from = start;
        mark.to = out.text.length;
        out.marks.push(mark);
      }
    }

    while ((m = re.exec(str))) {
      if (m.index > last) push(str.slice(last, m.index), null);
      if (m[1] !== undefined) {
        var href = safeHref(m[2]);
        if (href) push(m[1], { type: "link", href: href });
        else push(m[0], null); // an unsafe URL stays visible text, never a link
      } else {
        var type = m[3] ? "code"
          : m[4] || m[5] ? "bold"
            : m[6] ? "strike"
              : m[7] ? "highlight"
                : "italic";
        push(m[3] || m[4] || m[5] || m[6] || m[7] || m[8] || m[9], { type: type });
      }
      last = m.index + m[0].length;
    }
    if (last < str.length) push(str.slice(last), null);
    return out;
  }

  /**
   * Number the numbered-list rows in visual order. Every list item is its own
   * block, so the browser cannot do this: an `ol` would, but a stack of blocks is
   * not one. A run of numbered items counts up, a deeper item starts its own
   * sublist at 1, and any other block in between restarts the count — the way a
   * numbered list behaves in a document. Rows are annotated in place with
   * `_number` and the same array is returned.
   */
  function numberListRows(rows) {
    var counts = [];
    var inRun = false;
    (rows || []).forEach(function (row) {
      if (!row || row.type !== "numbered_list") {
        inRun = false;
        counts = [];
        if (row) row._number = 0;
        return;
      }
      var depth = Math.max(0, row._depth || 0);
      if (!inRun) counts = [];
      counts = counts.slice(0, depth + 1); // leaving a sublist resumes the parent's count
      counts[depth] = (counts[depth] || 0) + 1;
      row._number = counts[depth];
      inRun = true;
    });
    return rows;
  }

  function textPayload(type, text, extra) {
    var inline = parseInlineMarkdown(text);
    var content = { text: inline.text, marks: inline.marks };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) content[k] = extra[k];
    return { type: type, content: content };
  }

  /**
   * Markdown-lite -> block payloads, one pass per line. This is the same grammar
   * the "New object" form documents, so a pasted document and a typed one agree.
   * `opts.normalizeLang` maps fence aliases (js -> javascript), `opts.normalizeTex`
   * strips `\[ … \]` wrappers from math.
   */
  function markdownToBlocks(raw, opts) {
    var options = opts || {};
    var normalizeLang = typeof options.normalizeLang === "function"
      ? options.normalizeLang
      : function (l) { return l; };
    var normalizeTex = typeof options.normalizeTex === "function"
      ? options.normalizeTex
      : function (t) { return String(t == null ? "" : t).trim(); };

    var lines = String(raw == null ? "" : raw).replace(/\r\n?/g, "\n").split("\n");
    var blocks = [];
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      var m;

      var fence = /^\s*```(\S*)\s*$/.exec(line);
      if (fence) {
        var body = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
          body.push(lines[i]);
          i++;
        }
        i++; // closing fence — or the end of the clipboard
        var code = body.join("\n");
        var lang = String(normalizeLang(fence[1] || "") || "").toLowerCase();
        if (lang === "mermaid") blocks.push({ type: "mermaid", content: { code: code } });
        else if (lang === "plantuml") blocks.push({ type: "plantuml", content: { code: code } });
        else if (lang === "d2") blocks.push({ type: "d2", content: { code: code } });
        else if (lang === "math" || lang === "latex" || lang === "katex") {
          blocks.push({ type: "math", content: { tex: normalizeTex(code), display: true } });
        } else blocks.push({ type: "code", content: { language: lang || "plaintext", code: code } });
        continue;
      }

      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        blocks.push({ type: "divider", content: {} });
        i++;
        continue;
      }
      if ((m = /^\s*(#{1,6})\s+(.*?)\s*$/.exec(line))) {
        blocks.push(textPayload("heading", m[2], { level: m[1].length }));
        i++;
        continue;
      }
      if ((m = /^\s*[-*+]\s+\[([ xX])\]\s*(.*)$/.exec(line)) || (m = /^\s*\[([ xX])\]\s*(.*)$/.exec(line))) {
        blocks.push(textPayload("todo", m[2], { checked: m[1] !== " " }));
        i++;
        continue;
      }
      if ((m = /^\s*[-*+]\s+(.*)$/.exec(line))) {
        blocks.push(textPayload("bulleted_list", m[1].trim()));
        i++;
        continue;
      }
      if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
        blocks.push(textPayload("numbered_list", m[1].trim()));
        i++;
        continue;
      }
      if ((m = /^\s*>\s?(.*)$/.exec(line))) {
        blocks.push(textPayload("quote", m[1].trim()));
        i++;
        continue;
      }
      if ((m = /^\s*\$\$(.+?)\$\$\s*$/.exec(line))) {
        blocks.push({ type: "math", content: { tex: normalizeTex(m[1]), display: true } });
        i++;
        continue;
      }
      // blank lines separate blocks, they do not become empty ones
      var flat = line.trim();
      if (flat) blocks.push(textPayload("paragraph", flat));
      i++;
    }
    return blocks;
  }

  global.NTEntry = {
    LIST_TYPES: LIST_TYPES,
    isListType: isListType,
    sliceMarks: sliceMarks,
    splitAt: splitAt,
    joinInline: joinInline,
    enterContinue: enterContinue,
    enterExitsBlock: enterExitsBlock,
    enterAction: enterAction,
    numberListRows: numberListRows,
    pasteHasBlocks: pasteHasBlocks,
    safeHref: safeHref,
    parseInlineMarkdown: parseInlineMarkdown,
    markdownToBlocks: markdownToBlocks,
  };
})(typeof window !== "undefined" ? window : globalThis);
