/**
 * Block registry (data only, no DOM).
 *
 * One entry per insertable block. The slash menu, the "+" toolbar and the
 * editor all read from here, so adding a block type is a one-line change.
 * `kind` decides how the block is rendered:
 *   text     -> inline contenteditable element
 *   renderer -> mounted by a renderer from the client renderer registry
 */
(function (global) {
  var definitions = [
    {
      id: "note",
      type: "paragraph",
      kind: "text",
      label: "Note",
      icon: "📝",
      hint: "Plain text block",
      keywords: ["note", "text", "paragraph", "para", "p"],
      defaults: function () { return { text: "" }; },
    },
    {
      id: "heading1",
      type: "heading",
      kind: "text",
      label: "Heading 1",
      icon: "H1",
      hint: "Large section title",
      keywords: ["h1", "heading1", "heading", "title"],
      defaults: function () { return { level: 1, text: "" }; },
    },
    {
      id: "heading2",
      type: "heading",
      kind: "text",
      label: "Heading 2",
      icon: "H2",
      hint: "Medium section title",
      keywords: ["h2", "heading2", "heading", "subtitle"],
      defaults: function () { return { level: 2, text: "" }; },
    },
    {
      id: "heading3",
      type: "heading",
      kind: "text",
      label: "Heading 3",
      icon: "H3",
      hint: "Small section title",
      keywords: ["h3", "heading3", "heading"],
      defaults: function () { return { level: 3, text: "" }; },
    },
    {
      id: "todo",
      type: "todo",
      kind: "text",
      label: "Todo",
      icon: "☑",
      hint: "Checkbox item",
      keywords: ["todo", "task", "checkbox", "check"],
      defaults: function () { return { text: "", checked: false }; },
    },
    {
      id: "bulleted",
      type: "bulleted_list",
      kind: "text",
      label: "Bulleted list",
      icon: "•",
      hint: "Unordered list item",
      keywords: ["bullet", "bulleted", "list", "ul", "unordered", "item"],
      defaults: function () { return { text: "" }; },
    },
    {
      id: "numbered",
      type: "numbered_list",
      kind: "text",
      label: "Numbered list",
      icon: "1.",
      hint: "Ordered list item",
      keywords: ["number", "numbered", "ordered", "list", "ol", "item"],
      defaults: function () { return { text: "" }; },
    },
    {
      id: "quote",
      type: "quote",
      kind: "text",
      label: "Quote",
      icon: "❝",
      hint: "Highlighted quotation",
      keywords: ["quote", "blockquote", "citation"],
      defaults: function () { return { text: "" }; },
    },
    {
      id: "code",
      type: "code",
      kind: "renderer",
      label: "Code block",
      icon: "🧩",
      hint: "Syntax-highlighted code",
      keywords: ["code", "codeblock", "snippet", "cb"],
      defaults: function () { return { language: "plaintext", code: "" }; },
    },
    {
      id: "math",
      type: "math",
      kind: "renderer",
      label: "LaTeX formula",
      icon: "∑",
      hint: "KaTeX math block",
      keywords: ["latex", "math", "formula", "equation", "tex"],
      defaults: function () { return { tex: "", display: true }; },
    },
    {
      id: "mermaid",
      type: "mermaid",
      kind: "renderer",
      label: "Mermaid diagram",
      icon: "🧭",
      hint: "Flowchart or diagram from text",
      keywords: ["mermaid", "diagram", "chart", "flowchart", "graph", "flow"],
      defaults: function () { return { code: "graph TD\n  A[Start] --> B[End]" }; },
    },
    {
      id: "plantuml",
      type: "plantuml",
      kind: "renderer",
      label: "PlantUML diagram",
      icon: "📐",
      hint: "UML diagram rendered via PlantUML",
      keywords: ["plantuml", "uml", "sequence", "classdiagram", "usecase", "puml"],
      defaults: function () { return { code: "@startuml\nAlice -> Bob: hello\n@enduml" }; },
    },
    {
      id: "d2",
      type: "d2",
      kind: "renderer",
      label: "D2 diagram",
      icon: "🔷",
      hint: "Diagram from D2 script",
      keywords: ["d2", "diagram", "terrastruct", "d2lang", "layout"],
      defaults: function () { return { code: "a -> b: hello" }; },
    },
    {
      id: "whiteboard",
      type: "whiteboard",
      kind: "renderer",
      label: "Whiteboard",
      icon: "🎨",
      hint: "Freeform drawing canvas (tldraw)",
      keywords: ["whiteboard", "draw", "drawing", "sketch", "canvas", "doodle", "tldraw"],
      defaults: function () { return { snapshot: null }; },
    },
    {
      id: "divider",
      type: "divider",
      kind: "text",
      label: "Divider",
      icon: "―",
      hint: "Horizontal rule",
      keywords: ["divider", "hr", "separator", "rule"],
      defaults: function () { return {}; },
    },
  ];

  function byId(id) {
    for (var i = 0; i < definitions.length; i++) {
      if (definitions[i].id === id) return definitions[i];
    }
    return null;
  }

  function byType(type) {
    for (var i = 0; i < definitions.length; i++) {
      if (definitions[i].type === type) return definitions[i];
    }
    return null;
  }

  /**
   * Slash-menu filter. Ranked so an exact keyword beats a prefix ("/tex" should
   * offer the LaTeX block, not "text"), then label matches, then prefixes.
   */
  function score(def, q) {
    var label = def.label.toLowerCase();
    if (def.keywords.indexOf(q) >= 0) return 0;
    if (label === q) return 1;
    if (label.indexOf(q) === 0) return 2;
    for (var i = 0; i < def.keywords.length; i++) {
      if (def.keywords[i].indexOf(q) === 0) return 3;
    }
    return -1;
  }

  function match(query) {
    var q = String(query == null ? "" : query).trim().toLowerCase();
    if (!q) return definitions.slice();
    var hits = [];
    for (var i = 0; i < definitions.length; i++) {
      var s = score(definitions[i], q);
      if (s >= 0) hits.push({ def: definitions[i], score: s, order: i });
    }
    hits.sort(function (a, b) { return a.score - b.score || a.order - b.order; });
    return hits.map(function (h) { return h.def; });
  }

  function renderedTypes() {
    return definitions.filter(function (d) { return d.kind === "renderer"; }).map(function (d) { return d.type; });
  }

  global.NTBlocks = {
    definitions: definitions,
    byId: byId,
    byType: byType,
    match: match,
    renderedTypes: renderedTypes,
  };
})(typeof window !== "undefined" ? window : globalThis);
