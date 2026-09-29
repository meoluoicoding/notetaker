/**
 * Inline marks for text blocks.
 *
 * A text block stores `{ text, marks }` — never raw HTML (architect.md §4):
 *   text:  "hello world"
 *   marks: [{ type: "bold", from: 0, to: 5 }]
 *
 * The DOM is only a projection of that model: `apply()` renders text + marks
 * into a contenteditable, `serialize()` reads the DOM back into text + marks.
 * This module owns both directions so no other file has to know about tags.
 */
(function (global) {
  var TYPES = ["bold", "italic", "underline", "strike", "code", "highlight", "link", "object"];

  var TAGS = {
    B: "bold",
    STRONG: "bold",
    I: "italic",
    EM: "italic",
    U: "underline",
    S: "strike",
    STRIKE: "strike",
    DEL: "strike",
    CODE: "code",
    MARK: "highlight",
    A: "link",
  };

  /** `**bold**`, `*italic*`, `` `code` ``, `~~strike~~`, `==highlight==`, `__bold__`, `_italic_` */
  var INLINE_DELIMS = [
    ["**", "bold"],
    ["__", "bold"],
    ["~~", "strike"],
    ["==", "highlight"],
    ["`", "code"],
    ["*", "italic"],
    ["_", "italic"],
  ];

  function classFor(type) {
    return "m-" + type;
  }

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function markTypes(node) {
    if (!node || node.nodeType !== 1) return [];
    var out = [];
    var re = /m-(bold|italic|underline|strike|code|highlight|link|object)/g;
    var cls = node.getAttribute("class") || "";
    var m;
    while ((m = re.exec(cls))) {
      out.push({
        type: m[1],
        href: node.getAttribute("data-href") || undefined,
        objectId: node.getAttribute("data-object-id") || undefined,
      });
    }
    if (out.length) return out;
    var fromTag = TAGS[node.tagName];
    if (fromTag) {
      out.push({ type: fromTag, href: node.getAttribute("href") || undefined });
    }
    return out;
  }

  /** Drop empty/inverted marks, clamp to the text and sort — the stored shape. */
  function normalizeMarks(text, marks) {
    var len = (text || "").length;
    var out = [];
    (marks || []).forEach(function (m) {
      if (!m || TYPES.indexOf(m.type) < 0) return;
      var from = Math.max(0, Math.min(m.from || 0, len));
      var to = Math.max(0, Math.min(m.to || 0, len));
      if (to <= from) return;
      var mark = { type: m.type, from: from, to: to };
      if (m.href) mark.href = m.href;
      if (m.objectId) mark.objectId = m.objectId;
      out.push(mark);
    });
    out.sort(function (a, b) { return a.from - b.from || a.to - b.to; });
    return out;
  }

  function buildRun(text, marks) {
    if (!marks.length) return document.createTextNode(text);
    var span = document.createElement("span");
    span.setAttribute("class", marks.map(function (m) { return classFor(m.type); }).join(" "));
    var link = marks.filter(function (m) { return m.type === "link" && m.href; })[0];
    if (link) span.setAttribute("data-href", link.href);
    var obj = marks.filter(function (m) { return m.type === "object" && m.objectId; })[0];
    if (obj) span.setAttribute("data-object-id", obj.objectId);
    span.textContent = text;
    return span;
  }

  function sameSet(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i].type !== b[i].type) return false;
    return true;
  }

  /** Render `text` + `marks` into `el` (one span per run of equal marks). */
  function apply(el, text, marks) {
    if (!el) return;
    el.textContent = "";
    var str = text == null ? "" : String(text);
    if (!str) return;
    var list = normalizeMarks(str, marks);
    var sets = [];
    for (var i = 0; i < str.length; i++) {
      var active = [];
      for (var j = 0; j < list.length; j++) {
        if (list[j].from <= i && i < list[j].to) active.push(list[j]);
      }
      sets.push(active);
    }
    var frag = document.createDocumentFragment();
    var start = 0;
    while (start < str.length) {
      var end = start + 1;
      while (end < str.length && sameSet(sets[start], sets[end])) end++;
      frag.appendChild(buildRun(str.slice(start, end), sets[start]));
      start = end;
    }
    el.appendChild(frag);
  }

  /** Read a contenteditable back into `{ text, marks }`. */
  function serialize(el) {
    var text = "";
    var marks = [];
    if (el) walk(el, []);
    return { text: text, marks: normalizeMarks(text, marks) };

    function walk(node, stack) {
      for (var child = node.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 3) {
          var start = text.length;
          text += child.nodeValue;
          for (var i = 0; i < stack.length; i++) {
            marks.push({
              type: stack[i].type,
              from: start,
              to: text.length,
              href: stack[i].href,
              objectId: stack[i].objectId,
            });
          }
        } else if (child.nodeType === 1) {
          if (child.tagName === "BR") { text += "\n"; continue; }
          walk(child, stack.concat(markTypes(child)));
        }
      }
    }
  }

  /** DOM range covering the text offsets [from, to) inside `el`. */
  function rangeFromOffsets(el, from, to) {
    var range = document.createRange();
    var seen = 0;
    var startDone = false;
    range.selectNodeContents(el);
    range.collapse(true);
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      var len = node.nodeValue.length;
      if (!startDone && from <= seen + len) {
        range.setStart(node, Math.max(0, from - seen));
        startDone = true;
      }
      if (startDone && to <= seen + len) {
        range.setEnd(node, Math.max(0, to - seen));
        return range;
      }
      seen += len;
    }
    if (startDone) range.setEnd(el, el.childNodes.length);
    return range;
  }

  /** Put the caret at text offset `offset` inside `el`. */
  function placeCaret(el, offset) {
    var sel = window.getSelection();
    if (!sel || !el) return;
    var range = rangeFromOffsets(el, offset, offset);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /**
   * Markdown shortcut at the start of a line: returns the block to convert to
   * and the text that remains after the marker. Pure, so it is testable.
   */
  function blockRule(text) {
    var t = text == null ? "" : String(text);
    var m;
    if ((m = /^(#{1,3})\s([\s\S]*)$/.exec(t))) {
      return { type: "heading", content: { level: m[1].length, text: m[2] }, rest: m[2] };
    }
    if ((m = /^[-*+]\s\[\s?\]\s([\s\S]*)$/.exec(t)) || (m = /^\[\s?\]\s([\s\S]*)$/.exec(t))) {
      return { type: "todo", content: { text: m[1], checked: false }, rest: m[1] };
    }
    if ((m = /^[-*+]\s([\s\S]*)$/.exec(t))) {
      return { type: "bulleted_list", content: { text: m[1] }, rest: m[1] };
    }
    if ((m = /^\d+\.\s([\s\S]*)$/.exec(t))) {
      return { type: "numbered_list", content: { text: m[1] }, rest: m[1] };
    }
    if ((m = /^>\s([\s\S]*)$/.exec(t))) {
      return { type: "quote", content: { text: m[1] }, rest: m[1] };
    }
    if (/^(---|\*\*\*|___)\s*$/.test(t)) return { type: "divider", content: {}, rest: "" };
    // the language needs a closing keystroke, otherwise bare "```" would fire
    // before the user finished typing "```python"
    if ((m = /^```([A-Za-z0-9+#-]*)\s+$/.exec(t))) {
      return { type: "code", content: { language: (m[1] || "plaintext").toLowerCase(), code: "" }, rest: "" };
    }
    if ((m = /^\$\$\s([\s\S]*)$/.exec(t))) {
      return { type: "math", content: { tex: m[1], display: true }, rest: "" };
    }
    return null;
  }

  /**
   * Inline markdown just typed before the caret: `**bo|` -> null, `**bold**|`
   * -> { type: "bold", inner: "bold", from, to, start, end } where start/end
   * cover the delimiters as well, so the caller can replace the whole run.
   */
  function inlineRule(before) {
    var s = before == null ? "" : String(before);
    if (!s) return null;
    for (var i = 0; i < INLINE_DELIMS.length; i++) {
      var d = INLINE_DELIMS[i][0];
      var type = INLINE_DELIMS[i][1];
      var esc = escapeRe(d);
      var re = new RegExp("(?:^|[\\s(])" + esc + "([^" + esc + "]*[^" + esc + "\\s])" + esc + "$");
      var m = re.exec(s);
      if (!m) continue;
      var inner = m[1];
      var to = s.length - d.length;
      var from = to - inner.length;
      return {
        type: type,
        inner: inner,
        from: from,
        to: to,
        start: from - d.length,
        end: s.length,
      };
    }
    return null;
  }

  global.NTMarks = {
    TYPES: TYPES,
    classFor: classFor,
    normalizeMarks: normalizeMarks,
    apply: apply,
    serialize: serialize,
    rangeFromOffsets: rangeFromOffsets,
    placeCaret: placeCaret,
    blockRule: blockRule,
    inlineRule: inlineRule,
    markTypes: markTypes,
  };
})(typeof window !== "undefined" ? window : globalThis);
