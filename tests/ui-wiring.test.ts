import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Wiring guard for this Alpine + plain-JS front end: every handler referenced
 * from the markup must exist on the app() object, and every asset the page
 * loads must be served from /assets or /vendor (no stray CDN dependencies).
 */
const read = (rel: string) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const html = read("../public/index.html");
const appJs = read("../public/assets/app.js");
const registryJs = read("../public/assets/block-registry.js");
const css = read("../public/assets/app.css");

/**
 * Every directive that can call a method: event handlers (@…), bindings (:…)
 * and the x-* directives. A typo in any of them is a runtime Alpine error, so
 * they are all scanned — not just the handful of attributes that used to exist.
 */
function handlerExpressions(): string[] {
  const found: string[] = [];
  const attrPattern = /(?:@[\w.:-]+|x-on:[\w.:-]+|:[\w.-]+|x-init|x-if|x-for|x-show|x-text|x-model)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = attrPattern.exec(html))) found.push(match[1]);
  return found;
}

/** Leading identifier of every `name(` call inside a directive expression. */
function calledMethods(): string[] {
  const names = new Set<string>();
  for (const expression of handlerExpressions()) {
    // Prose inside string literals is not code: drop it before scanning for calls.
    const code = expression
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""');
    for (const call of code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = call[1];
      if (["JSON", "String", "Number", "Boolean", "Math", "window", "document"].includes(name)) continue;
      names.add(name);
    }
  }
  return Array.from(names).sort();
}

/** `methodName(` declarations on the app() object (async methods included). */
function declaresMethod(name: string): boolean {
  return new RegExp(`\\n\\s*(?:async\\s+)?${name}\\s*\\(`).test(appJs);
}

describe("front-end wiring", () => {
  it("declares every method the markup calls", () => {
    const missing = calledMethods().filter((name) => !declaresMethod(name));
    expect(missing, "handlers referenced in index.html but missing in app.js").toEqual([]);
  });

  it("has a quick create-page action wired to the API", () => {
    expect(html).toContain('@click="createPage()"');
    expect(appJs).toMatch(/async createPage\(\)/);
    expect(appJs).toContain('method: "POST"');
    expect(appJs).toMatch(/newPageLabel\(\)/);
    // created pages start with a block so the editor is immediately usable
    expect(appJs).toMatch(/createPage[\s\S]{0,700}blocks: \[\{ type: "paragraph"/);
  });

  it("keeps the title inline-editable and saveable with Enter", () => {
    expect(html).toMatch(/class="page-title"[^>]*[\s\S]{0,320}commitTitle\(\$event\)/);
    expect(appJs).toMatch(/async commitTitle\(evt\)/);
  });

  it("loads Alpine and the registry before the app script", () => {
    const registryIndex = html.indexOf("/assets/block-registry.js");
    const appIndex = html.indexOf("/assets/app.js");
    expect(registryIndex).toBeGreaterThan(-1);
    expect(appIndex).toBeGreaterThan(registryIndex);
  });

  it("does not hard-depend on a CDN for editor libraries", () => {
    const scriptTags = Array.from(html.matchAll(/<script[^>]+src="([^"]+)"/g)).map((m) => m[1]);
    const cdn = scriptTags.filter((src) => /^https?:\/\//.test(src));
    expect(cdn, "app shell scripts must be local (vendor mounts)").toEqual([]);
    const appSources = appJs + registryJs;
    // CDN URLs are only allowed as fallbacks inside asset candidate lists
    for (const url of Array.from(appSources.matchAll(/https:\/\/(cdn\.jsdelivr\.net|esm\.sh)[^\s"']*/g)).map((m) => m[0])) {
      expect(url).toMatch(/codemirror|katex|mermaid|alpinejs|d2|tldraw|react/);
    }
    expect(appSources).toMatch(/\/vendor\/codemirror\//);
    expect(appSources).toMatch(/\/vendor\/katex\//);
    expect(appSources).toMatch(/\/vendor\/mermaid\//);
    expect(appSources).toMatch(/\/vendor\/d2\//);
    expect(appSources).toMatch(/\/vendor\/tldraw\//);
  });

  it("ships the tldraw vendor bundle the whiteboard renderer needs", () => {
    const dir = fileURLToPath(new URL("../public/vendor/tldraw", import.meta.url));
    const files = fs.readdirSync(dir);
    expect(files.some((f) => /^tldraw-\d+\..*\.mjs$/.test(f)), "bundled tldraw ESM is missing (run npm run build:vendor)").toBe(true);
    expect(files).toContain("tldraw.css");
  });

  it("routes block types through the registry instead of hard-coded chains", () => {
    expect(html).toContain("isRenderedBlock(block.type)");
    expect(html).toContain("mountBlockRenderer($el, block)");
    expect(html).not.toMatch(/x-if="block\.type === 'code'"/);
    expect(html).not.toMatch(/x-if="block\.type === 'math'"/);
    expect(appJs).toMatch(/rendererSpecs:/);
  });

  it("keeps the slash menu and the toolbar on the same registry", () => {
    expect(html).toContain("slashOptions()");
    expect(html).toContain("pickSlash(opt)");
    expect(html).toMatch(/x-for="def in blockDefinitions\(\)"/);
    expect(appJs).toContain("window.NTBlocks");
  });

  it("deletes blocks through the block API and leaves an undo step behind", () => {
    expect(html).toMatch(/@click="deleteBlock\(block\)"/);
    expect(appJs).toMatch(/async deleteBlock\(block\)/);
    // the removal goes through the API, and Ctrl+Z must be able to bring it back
    expect(appJs).toMatch(/async removeBlock\(block\)[\s\S]{0,400}method: "DELETE"/);
    expect(appJs).toMatch(/removeEntry\(block\.objectId, payload, block\.id\)/);
  });

  it("gives every toolbar chip its own definition instead of looking defaults up by type", () => {
    // H1/H2/H3 share one block type: byType("heading") always returns H1.
    expect(appJs).toMatch(/addBlockDef\(def\)\s*\{\s*return this\.addBlock\(def\.type, def\.defaults\(\)\)/);
    expect(appJs).not.toMatch(/addBlockDef\(def\)\s*\{[^}]*blockDefaults\(def\.type\)/);
    expect(html).toMatch(/@click="addBlockDef\(def\)"/);
  });

  it("shows the heading level in the editor and lets it be changed", () => {
    expect(html).toContain("cycleHeadingLevel(block)");
    expect(html).toMatch(/x-text="'H' \+ \(block\.content\.level \|\| 1\)"/);
    expect(appJs).toMatch(/async cycleHeadingLevel\(block\)/);
    // changing the level must not drop the text being edited
    expect(appJs).toMatch(/async cycleHeadingLevel\(block\)[\s\S]{0,600}\{ level, text \}/);
    expect(css).toContain(".heading-badge");
  });

  it("keeps the slash hint out of every new line", () => {
    expect(html).toMatch(/:data-placeholder="blockPlaceholder\(block\)"/);
    expect(html).not.toContain(`data-placeholder="Type '/' to insert a block…"`);
    expect(appJs).toMatch(/blockPlaceholder\(block\)[\s\S]{0,400}this\.blocks\.length === 1/);
  });

  it("gives every object a tab, a back/forward history and a keyboard-driven picker", () => {
    expect(html).toContain("activateTab(tab.id)");
    expect(html).toContain("closeTab(tab.id)");
    expect(html).toContain('@click="goBack()"');
    expect(html).toContain('@click="goForward()"');
    expect(html).toContain('@click="openTypePicker()"');
    expect(html).toContain("typePickerEnter($event)");
    expect(appJs).toMatch(/async openObject\(id, opts = \{\}\)/);
    expect(appJs).toMatch(/pushHistory\(obj\.id\)/);
    // history replay must not push a new entry while navigating back
    expect(appJs).toMatch(/skipHistory: true/);
  });

  it("opens one search palette on Ctrl+K instead of a toolbar-bound overlay", () => {
    expect(html).toContain("onGlobalKey($event)");
    expect(html).toMatch(/x-model="palette\.query"/);
    expect(appJs).toMatch(/runPaletteSearch\(\)/);
    expect(appJs).toMatch(/paletteOpenActive\(\)/);
    expect(appJs).not.toMatch(/searchHits/);
  });

  it("shows the palette and picker keyboard hints the reference UI uses", () => {
    expect(html).toContain("↑↓ to navigate");
    expect(html).toContain("Esc to close");
    expect(html).toContain("↵ to select");
    expect(html).toContain("Shift+↵ for the full form");
  });

  it("edits object types in Settings through the structure API", () => {
    expect(html).toMatch(/@click="editType\(s\)"/);
    expect(html).toMatch(/@click="saveType\(\)"/);
    expect(html).toContain('x-model="typeEditor.name"');
    expect(appJs).toMatch(/async saveType\(\)[\s\S]{0,900}\/structures/);
    expect(appJs).toMatch(/structures\/\$\{this\.typeEditor\.id\}[\s\S]{0,120}method: "PATCH"/);
  });

  it("keeps only browser-local state local (last space, per-space pins, theme)", () => {
    expect(appJs).toContain('localStorage.setItem("nt-space-id"');
    expect(appJs).toContain("nt-pinned:");
    expect(appJs).toMatch(/pinnedKey\(this\.currentSpaceId\)/);
    expect(html).toMatch(/@click(?:\.\w+)*="togglePin\(o\.id\)"/);
    // the workspace name/icon are server rows now, not localStorage preferences
    expect(appJs).not.toContain('localStorage.setItem("nt-space"');
    // pinning must never issue an object PATCH
    expect(appJs).not.toMatch(/togglePin[\s\S]{0,400}method: "PATCH"/);
  });

  it("sends the active space with every request and scopes the UI to it", () => {
    expect(appJs).toContain('"X-Space-Id": this.currentSpaceId');
    expect(appJs).toMatch(/async switchSpace\(id\)/);
    expect(appJs).toMatch(/async loadSpaces\(\)/);
    expect(html).toContain("openSpaceSwitcher()");
    expect(html).toMatch(/@click="switchSpace\(s\.id\)"/);
    expect(html).toContain('x-text="activeSpace() ? activeSpace().name : ');
    // switching spaces drops tabs, history and the open object of the previous space
    expect(appJs).toMatch(/async switchSpace\(id\)[\s\S]{0,900}this\.tabs = \[\];/);
    expect(appJs).toMatch(/async switchSpace\(id\)[\s\S]{0,1200}this\.historyIndex = -1;/);
  });

  it("creates, renames and deletes spaces through the space API", () => {
    expect(html).toMatch(/@click="createSpace\(\)"/);
    expect(html).toContain('x-model="spaceSwitcher.newName"');
    expect(html).toMatch(/@click="deleteActiveSpace\(\)"/);
    expect(appJs).toMatch(/method: "POST", body: JSON\.stringify\(\{ name \}\)/);
    expect(appJs).toMatch(/\/spaces\/\$\{space\.id\}[\s\S]{0,80}method: "PATCH"/);
    // deletions are opt-in and travel with an explicit force flag
    expect(appJs).toMatch(/\/spaces\/\$\{space\.id\}\?force=\$\{force \? 1 : 0\}/);
    expect(appJs).toMatch(/method: "DELETE"/);
  });

  it("has one entry point for the light/dark/system theme", () => {
    expect(html).toContain("setThemeMode('light')");
    expect(html).toContain("setThemeMode('dark')");
    expect(html).toContain("setThemeMode('system')");
    expect(appJs).toMatch(/applyThemeMode\(mode\)/);
    expect(appJs).toMatch(/nt-theme-mode/);
  });

  it("styles every panel the reference shell introduces", () => {
    for (const selector of [".titlebar", ".tabstrip", ".sb-nav", ".picker-row", ".palette-row", ".space-panel", ".space-row", ".settings", ".st-nav", ".fab"]) {
      expect(css, `${selector} is missing from app.css`).toContain(selector);
    }
  });

  it("gives code blocks the editor capabilities the spec requires", () => {
    // architect.md #23: line numbers, syntax highlighting, bracket matching,
    // search, folding, autocomplete, indentation — all CodeMirror addon driven.
    expect(appJs).toMatch(/lineNumbers: true/);
    expect(appJs).toMatch(/matchBrackets: true/);
    expect(appJs).toMatch(/"Ctrl-F": "findPersistent"/);
    // completion must offer, never auto-pick: the stock `autocomplete` command
    // silently inserts a lone match and closes the menu, so Ctrl+Space looks dead.
    expect(appJs).toMatch(/"Ctrl-Space": \(\) => this\.openCompletion\(cm\)/);
    expect(appJs).toMatch(/completeSingle: false/);
    expect(appJs).toMatch(/"Ctrl-\[": "foldLess"/);
    expect(appJs).toMatch(/indentUnit: 2,?\s*tabSize: 2,/);
    expect(appJs).toMatch(/CodeMirror-foldgutter/);
    // every addon the editor references must actually be loaded
    for (const rel of [
      "addon/search/search.js", "addon/search/searchcursor.js", "addon/dialog/dialog.js",
      "addon/fold/foldcode.js", "addon/fold/foldgutter.js", "addon/fold/brace-fold.js",
      "addon/hint/show-hint.js", "addon/hint/anyword-hint.js", "addon/comment/comment.js",
    ]) {
      expect(appJs, `${rel} must be in ensureCmMode's asset list`).toContain(`"${rel}"`);
    }
    // the whole-block fold shortcut is wired to the toolbar and clears on unmount
    expect(appJs).toMatch(/toggleCodeFolding\(blockId\)/);
    expect(appJs).toMatch(/codeFolded: new Set\(\)/);
    expect(appJs).toMatch(/this\.codeFolded\.delete\(blockId\)/);
  });

  it("lets a LaTeX block switch between display and inline math", () => {
    // KaTeX displayMode comes from content.display; the toggle must persist it.
    expect(appJs).toMatch(/displayMode: block\.content\?\.display !== false/);
    expect(appJs).toMatch(/async toggleMathDisplay\(blockId, button, host, body, spec, ta\)/);
    expect(appJs).toMatch(/this\.saveBlockContent\(block, \{ display \}\)/);
    expect(css).toContain(".b-math.inline-math");
    // a stale closure would flip the same value forever: the live block is looked up
    expect(appJs).not.toMatch(/toggleMathDisplay\(block, mode, host, body, spec, ta\)/);
  });

  // ---------- data entry: Enter, Backspace, Delete, arrows, paste ----------
  it("loads the data-entry rules before the app script", () => {
    const rules = html.indexOf("/assets/entry-rules.js");
    expect(rules).toBeGreaterThan(html.indexOf("/assets/inline-marks.js"));
    expect(rules).toBeLessThan(html.indexOf("/assets/app.js"));
  });

  it("declares every data-entry handler app.js owns", () => {
    for (const name of [
      "splitBlockOnEnter", "mergeNextBlockInto", "moveCaretAcrossBlocks", "focusBlockEdge",
      "onBlockPaste", "pasteBlocks", "onPlainPaste", "postBlockAfter", "removeBlock", "removeEntry",
    ]) {
      expect(declaresMethod(name), `${name} is missing in app.js`).toBe(true);
    }
  });

  it("binds the paste handler on every text block", () => {
    const bindings = html.match(/@paste="onBlockPaste\(block, \$event\)"/g) ?? [];
    expect(bindings.length, "heading, paragraph, both lists, todo and quote").toBe(6);
    // titles and descriptions are plain text, so their paste is flattened
    expect(html.match(/@paste="onPlainPaste\(\$event\)"/g)?.length).toBe(2);
  });

  it("splits the line on Enter instead of always appending a paragraph", () => {
    expect(appJs).toMatch(/this\.splitBlockOnEnter\(block, evt\.target\)/);
    expect(appJs).toMatch(/async splitBlockOnEnter\(block, el\)[\s\S]{0,900}Rules\.splitAt\(/);
    // the new line keeps the shape of the line it came from (list, quote, todo)
    expect(appJs).toMatch(/const next = Rules\.enterContinue\(block\)/);
    expect(appJs).toMatch(/Rules\.enterAction\(block, live\.text, this\.blockHasChildren\(block\.id\)\)/);
    expect(appJs).not.toMatch(/this\.saveBlockFromEl\(block, evt\.target\);\s*this\.addBlockAfter\("paragraph", block\)/);
  });

  it("never splits or deletes the subtree of a block that owns children", () => {
    // Enter on a parent only opens a line: its text stays whole
    expect(appJs).toMatch(/action === "insert"[\s\S]{0,220}addBlockAfter\(next\.type, block, next\.content/);
    expect(appJs).toMatch(/blockHasChildren\(blockId\) \{\s*return this\.blocks\.some\(\(b\) => b\.parentId === blockId\)/);
    expect(appJs).toMatch(/blockHasChildren\(block\.id\)[\s\S]{0,120}move them out first/);
    expect(appJs).toMatch(/blockHasChildren\(next\.id\)/);
    // visual neighbours come from the tree, never from the position-ordered array
    expect(appJs).toMatch(/nextRow\(blockId\) \{[\s\S]{0,300}rows\[at \+ 1\]/);
  });

  it("takes a list marker away with Backspace and joins lines with Delete", () => {
    expect(appJs).toMatch(/isListType\(block\.type\) \|\| block\.type === "quote"[\s\S]{0,220}convertBlockToParagraph\(block\.id, \{ content: this\.parseInline\(evt\.target\) \}\)/);
    expect(appJs).toMatch(/this\.mergeNextBlockInto\(block, evt\.target\)/);
    expect(appJs).toMatch(/async mergeNextBlockInto\(block, el\)[\s\S]{0,900}await this\.removeBlock\(next\)/);
    // a conversion must carry the text through instead of blanking the line
    expect(appJs).toMatch(/async convertBlockToParagraph\(blockId, opts = \{\}\)/);
    expect(appJs).toMatch(/const content = opts\.content \?\? \{ text: "", marks: \[\] \}/);
  });

  it("walks the block tree with the arrow keys at the edges of a line", () => {
    expect(appJs).toMatch(/this\.moveCaretAcrossBlocks\(block, evt\.target, delta\)/);
    expect(appJs).toMatch(/moveCaretAcrossBlocks\(block, el, delta\)[\s\S]{0,700}this\.focusBlockEdge\(target\.id/);
    expect(appJs).toMatch(/focusBlock\(blockId, retries = 2, caret = null\)/);
    expect(appJs).toMatch(/if \(caret\) this\.placeCaretAt\(el, caret === "end"/);
  });

  it("pastes text as text and a clipboard of blocks as blocks", () => {
    expect(appJs).toMatch(/onBlockPaste\(block, evt\)[\s\S]{0,500}getData\("text\/plain"\)/);
    expect(appJs).toMatch(/execCommand\("insertText", false, text\)/);
    expect(appJs).toMatch(/Rules\.pasteHasBlocks\(text\)/);
    // the markdown grammar has exactly one implementation: entry-rules.js
    expect(appJs).toMatch(/parseContentToBlocks\(raw\)[\s\S]{0,400}Rules\.markdownToBlocks\(raw/);
    expect(appJs).not.toMatch(/const fence = line\.match\(\/\^```/);
    // clipboard HTML never reaches the model
    expect(appJs).not.toMatch(/onBlockPaste[\s\S]{0,900}text\/html/);
  });

  it("numbers a run of numbered blocks instead of printing 1. on every line", () => {
    expect(html).toMatch(/:data-number="block\._number \|\| 1"/);
    expect(css).toContain('content: attr(data-number) "."');
    expect(appJs).toMatch(/window\.NTEntry\.numberListRows\(rows\)/);
  });

  it("creates an object from the full form without reaching for the mouse", () => {
    expect(html).toContain('@keydown.ctrl.enter.prevent="createObject()"');
  });
});
