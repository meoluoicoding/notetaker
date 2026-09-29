/**
 * tldraw runtime objects (module namespace, React root, Editor instance) must
 * never live on the reactive Alpine component: the reactivity proxy wrapped
 * around them breaks tldraw's internal state machinery. Keep them in this
 * plain, non-reactive map instead (blockId -> { tl, editor, root, mountTag }).
 */
const whiteboardRuntimes = new Map();
let tldrawModule = null;
let tldrawModulePromise = null;
let whiteboardFullscreenId = null;

/**
 * Layout/view caches must NOT live on the reactive Alpine component: blockRows()
 * and viewObjects() are evaluated several times per Alpine flush, and storing
 * computed rows on the proxy would trigger a reactive write on every keystroke.
 * They key on the source array reference (whole-array loads invalidate for free)
 * and are cleared explicitly after in-place structural edits (invalidateRows).
 */
const rowsCache = { key: null, rows: null };
const viewCache = { key: null, rows: null };

function app() {
  return {
    // ---------- state ----------
    structures: [],
    objects: [],
    tags: [],
    blocks: [],
    linkedObjects: [],
    backlinks: [],
    currentObject: null,
    view: "explore",
    rightPanelOpen: true,
    sidebarCollapsed: false,
    newObjectModal: false,
    toast: "",
    theme: document.documentElement.dataset.theme || "light",
    themeMode: document.documentElement.dataset.themeMode || "system",
    newObject: { title: "", description: "", structureId: "", tags: "", content: "" },
    creatingObject: false,

    // Spaces are server-side rows; only "which space I am in" is a browser preference.
    spaces: [],
    currentSpaceId: "",
    spaceSwitcher: { open: false, query: "", newName: "", creating: false },
    spaceForm: { name: "", icon: "🧠" },
    iconChoices: ["🧠", "🚀", "📚", "✍️", "🌱", "💡", "🧪", "🗂️", "🎯", "🪐"],

    // Open tabs + back/forward history: ephemeral UI state, never persisted as domain data.
    tabs: [],
    activeTabId: null,
    history: [],
    historyIndex: -1,

    // Pinned objects: a browser preference per space (localStorage), not an object property.
    pinnedIds: [],

    // Search palette (Ctrl+K)
    palette: { open: false, query: "", hits: [], index: 0, seq: 0 },

    // Object-type picker ("+", FAB, Ctrl+N)
    typePicker: { open: false, query: "", index: 0 },

    // Settings modal (two-pane) + object-type editor
    settings: { open: false, pane: "appearance" },
    typeEditor: { open: false, id: null, name: "", icon: "📄" },

    // slash menu ("/" block inserter) — a content registry, never an app-command palette
    slash: { open: false, blockId: null, query: "", index: 0 },

    // floating inline-format toolbar (ephemeral: follows the selection)
    fmt: { open: false, x: 0, y: 0 },

    // keystrokes typed while a markdown conversion is re-mounting the block
    pendingInput: { blockId: null, buffer: "", lastEvent: null },

    // drag & drop reordering (ephemeral UI state, never persisted)
    drag: { blockId: null, overId: null, place: "before" },

    // undo/redo: in-memory op stack (architect.md §46), never persisted
    undoStack: [],
    redoStack: [],

    // renderer runtime: blockId -> { container, wrapper, cm, textarea }
    rendererState: new Map(),
    codeFolded: new Set(),
    renderedPending: new Set(),
    blockSaveTimers: {},
    loadedAssets: new Set(),
    failedAssets: new Set(),
    assetLoadChain: Promise.resolve(),
    mermaidReady: false,
    d2Instance: null,
    d2Promise: null,
    d2WorkChain: Promise.resolve(),

    /** Block types mounted by a renderer instead of an inline contenteditable. */
    renderedTypes: window.NTBlocks ? window.NTBlocks.renderedTypes() : ["code", "math", "mermaid", "plantuml", "d2", "whiteboard"],
    isRenderedBlock(type) {
      return this.renderedTypes.includes(type);
    },
    /** Registry: block.type -> renderer spec. Type branching lives here, nowhere else. */
    rendererSpecs: {
      code: { sourceKey: "code", editor: "codemirror" },
      math: { sourceKey: "tex", editor: "preview", placeholder: "LaTeX, e.g. \\frac{1}{\\sqrt{2\\pi\\sigma^2}}" },
      mermaid: { sourceKey: "code", editor: "preview" },
      plantuml: { sourceKey: "code", editor: "preview", placeholder: "PlantUML, e.g. @startuml … @enduml" },
      d2: { sourceKey: "code", editor: "preview", placeholder: "D2, e.g. a -> b" },
      whiteboard: { editor: "whiteboard" },
    },

    // code block language handling
    codeLanguages: [
      "plaintext", "javascript", "typescript", "python", "rust", "go",
      "sql", "html", "css", "json", "markdown", "yaml", "bash",
      "java", "c", "cpp", "csharp", "mermaid", "plantuml", "d2",
    ],
    codeLangAliases: {
      js: "javascript", ts: "typescript", py: "python", sh: "bash",
      shell: "bash", zsh: "bash", yml: "yaml", md: "markdown",
      "c++": "cpp", "c#": "csharp", cs: "csharp", text: "plaintext",
      txt: "plaintext", "text/plain": "plaintext", golang: "go", htm: "html",
    },
    normalizeCodeLang(lang) {
      const l = (lang || "").toLowerCase().trim();
      return this.codeLangAliases[l] || l || "plaintext";
    },

    // ---------- theme ----------
    toggleTheme() {
      this.setThemeMode(this.theme === "dark" ? "light" : "dark");
    },

    setThemeMode(mode) {
      this.themeMode = mode;
      try { localStorage.setItem("nt-theme-mode", mode); } catch (e) {}
      this.applyThemeMode(mode);
    },

    applyThemeMode(mode) {
      const resolved = mode === "system"
        ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
        : mode;
      this.theme = resolved;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.dataset.themeMode = mode;
      this.mermaidReady = false;
      this.remountRenderedBlocks();
    },

    async init() {
      this.applyThemeMode(this.themeMode);
      // the inline-format toolbar follows the selection, not the mouse
      document.addEventListener("selectionchange", () => this.syncFormatToolbar());
      // capture phase: a conversion in flight must see keys before anyone else
      document.addEventListener("keydown", (evt) => this.bufferPendingInput(evt), true);
      await this.loadSpaces();
      await this.loadEverything();

      try {
        matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
          if (this.themeMode === "system") this.applyThemeMode("system");
        });
      } catch (e) {}
    },

    /** Which space this browser was last in — the only space-related client state. */
    storedSpaceId() {
      try {
        return localStorage.getItem("nt-space-id") || "";
      } catch (e) {
        return "";
      }
    },

    rememberSpace(id) {
      try {
        localStorage.setItem("nt-space-id", id);
      } catch (e) {}
    },

    async loadSpaces() {
      this.spaces = await this.api("/spaces");
      const stored = this.storedSpaceId();
      const known = this.spaces.find((s) => s.id === stored);
      this.currentSpaceId = known ? known.id : this.spaces[0]?.id ?? "";
      this.restorePinned();
      this.syncSpaceForm();
    },

    activeSpace() {
      return this.spaces.find((s) => s.id === this.currentSpaceId) ?? null;
    },

    /** Structures, objects and tags all come from the server scoped to the active space. */
    async loadEverything() {
      await this.loadStructures();
      if (this.structures.length > 0) this.newObject.structureId = this.structures[0].id;
      await Promise.all([this.loadObjects(), this.loadTags()]);
    },

    async switchSpace(id) {
      if (id === this.currentSpaceId) {
        this.spaceSwitcher.open = false;
        return;
      }
      this.flushBlockSaves();
      this.destroyRenderedBlocks();
      this.currentSpaceId = id;
      this.rememberSpace(id);

      // Tabs, history, the open object and the pins all belong to the space we just left.
      this.tabs = [];
      this.activeTabId = null;
      this.history = [];
      this.historyIndex = -1;
      this.currentObject = null;
      this.blocks = [];
      this.linkedObjects = [];
      this.backlinks = [];
      this.rightPanelOpen = false;
      this.view = "explore";
      this.spaceSwitcher = { open: false, query: "", newName: "", creating: false };

      this.restorePinned();
      this.syncSpaceForm();
      await this.loadEverything();
      this.showToast(`Switched to ${this.activeSpace()?.name ?? "space"}`);
    },

    // ---------- space switcher ----------
    openSpaceSwitcher() {
      this.spaceSwitcher = { open: true, query: "", newName: "", creating: false };
      this.$nextTick(() => {
        const el = document.querySelector(".space-search");
        if (el) el.focus();
      });
    },

    spaceOptions() {
      const q = this.spaceSwitcher.query.trim().toLowerCase();
      if (!q) return this.spaces;
      return this.spaces.filter((s) => s.name.toLowerCase().includes(q));
    },

    async createSpace() {
      const name = this.spaceSwitcher.newName.trim();
      if (!name) {
        this.showToast("Space name is required");
        return;
      }
      const created = await this.api("/spaces", { method: "POST", body: JSON.stringify({ name }) });
      await this.loadSpaces();
      await this.switchSpace(created.id);
      this.showToast(`Space “${created.name}” created`);
    },

    syncSpaceForm() {
      const space = this.activeSpace();
      this.spaceForm = { name: space?.name ?? "", icon: space?.icon ?? "🧠" };
    },

    async saveSpace() {
      const space = this.activeSpace();
      if (!space) return;
      const name = (this.spaceForm.name || "").trim() || space.name;
      const icon = (this.spaceForm.icon || "").trim() || "🧠";
      await this.api(`/spaces/${space.id}`, { method: "PATCH", body: JSON.stringify({ name, icon }) });
      await this.loadSpaces();
      this.syncSpaceForm();
      this.showToast("Space updated");
    },

    setSpaceIcon(icon) {
      this.spaceForm.icon = icon;
      return this.saveSpace();
    },

    /** Deleting is opt-in and destructive: the API refuses a non-empty space without `force`. */
    async deleteActiveSpace() {
      const space = this.activeSpace();
      if (!space) return;
      const force = space.objectCount > 0;
      const question = force
        ? `Delete “${space.name}” and all ${space.objectCount} object${space.objectCount === 1 ? "" : "s"} in it? This cannot be undone.`
        : `Delete the empty space “${space.name}”?`;
      if (!confirm(question)) return;

      try {
        await this.api(`/spaces/${space.id}?force=${force ? 1 : 0}`, { method: "DELETE" });
      } catch (e) {
        return; // api() already surfaced the toast
      }

      this.settings.open = false;
      this.spaceSwitcher.open = false;
      await this.loadSpaces();
      this.currentSpaceId = this.spaces[0]?.id ?? "";
      this.rememberSpace(this.currentSpaceId);
      this.tabs = [];
      this.activeTabId = null;
      this.history = [];
      this.historyIndex = -1;
      this.currentObject = null;
      this.blocks = [];
      this.view = "explore";
      this.restorePinned();
      this.syncSpaceForm();
      await this.loadEverything();
      this.showToast("Space deleted");
    },

    /** One keyboard entry point for app-level shortcuts (markup binds keydown.window). */
    onGlobalKey(evt) {
      const mod = evt.ctrlKey || evt.metaKey;
      const key = (evt.key || "").toLowerCase();
      const target = evt.target;
      const tag = (target && target.tagName ? target.tagName : "").toLowerCase();
      const typing = ["input", "textarea", "select"].includes(tag) || (target && target.isContentEditable);

      // Full screen whiteboard sits above every overlay: only Esc reaches it,
      // and app shortcuts must not pop overlays underneath it.
      if (whiteboardFullscreenId) {
        if (evt.key === "Escape") {
          evt.preventDefault();
          this.toggleWhiteboardFullscreen(whiteboardFullscreenId, false);
        }
        return;
      }

      if (mod && key === "k") { evt.preventDefault(); this.openPalette(); return; }
      if (mod && key === "n") { evt.preventDefault(); this.openTypePicker(); return; }
      // Enter while the type picker is open acts on it even when focus never
      // reached the search input (e.g. right after an object opened): plain
      // Enter picks the highlighted type, Shift+Enter opens the full form.
      if (this.typePicker.open && evt.key === "Enter") {
        evt.preventDefault();
        this.typePickerEnter(evt);
        return;
      }
      if (mod && key === ",") { evt.preventDefault(); this.openSettings(this.settings.pane); return; }
      if (mod && (key === "\\" || evt.code === "Backslash")) {
        evt.preventDefault();
        this.sidebarCollapsed = !this.sidebarCollapsed;
        return;
      }
      // Undo/redo run on the editor's own op stack (architect.md §46): the DOM is
      // only a projection of the model, so the browser's native undo would fight
      // it. A code block or a form field owns its own history and is left alone.
      if (mod && (key === "z" || key === "y")) {
        if (target?.closest?.(".CodeMirror, input, textarea, select")) return;
        evt.preventDefault();
        if (key === "y" || evt.shiftKey) this.redo();
        else this.undo();
        return;
      }
      if (evt.key === "Escape") {
        this.palette.open = false;
        this.typePicker.open = false;
        this.settings.open = false;
        this.newObjectModal = false;
        this.spaceSwitcher.open = false;
        this.closeSlash();
        return;
      }
      // "/" from outside the editor jumps into the current page
      if (!typing && !mod && evt.key === "/" && this.currentObject) {
        const first = document.querySelector(".block-list .block [contenteditable]");
        if (first) { evt.preventDefault(); first.focus(); }
      }
    },

    async api(path, opts = {}) {
      const res = await fetch(`/api/v1${path}`, {
        headers: {
          "Content-Type": "application/json",
          // The active space travels with every request; the server scopes all queries by it.
          ...(this.currentSpaceId ? { "X-Space-Id": this.currentSpaceId } : {}),
        },
        ...opts,
      });
      const body = await res.json();
      if (!res.ok) {
        this.showToast(body?.error?.message || "Request failed");
        throw new Error(body?.error?.code || "API_ERROR");
      }
      return body.data;
    },

    async loadStructures() {
      this.structures = await this.api("/structures");
    },

    async loadTags() {
      this.tags = await this.api("/tags");
    },

    /** Objects are fetched once, newest first; every sidebar view filters this list client-side. */
    async loadObjects() {
      this.objects = await this.api("/objects?limit=200");
    },

    // ---------- views ----------
    reservedViews: ["explore", "all", "today", "calendar", "pinned"],

    isStructureView() {
      return !this.reservedViews.includes(this.view) && !this.view.startsWith("tag:");
    },

    viewObjects() {
      const key = `${this.view}|${this.objects}|${this.pinnedIds}|${this.structures}`;
      if (viewCache.key !== key) {
        viewCache.key = key;
        viewCache.rows = this.computeViewObjects();
      }
      return viewCache.rows;
    },

    /** The filter itself — kept separate so viewObjects() is a cheap cache read. */
    computeViewObjects() {
      if (this.view === "pinned") return this.pinnedObjects();
      if (this.view === "calendar") return this.calendarObjects();
      if (this.view.startsWith("tag:")) {
        const slug = this.view.slice(4);
        return this.objects.filter((o) => o.tags.includes(slug));
      }
      if (this.isStructureView()) return this.objects.filter((o) => o.structure_id === this.view);
      return this.objects;
    },

    async setView(view) {
      this.flushBlockSaves();
      this.destroyRenderedBlocks();
      this.view = view;
      this.currentObject = null;
      this.blocks = [];
      this.activeTabId = null;
      this.rightPanelOpen = false;
    },

    async filterByStructure(id) {
      return this.setView(id);
    },

    async filterByTag(slug) {
      return this.setView(`tag:${slug}`);
    },

    countForStructure(id) {
      return this.objects.filter((o) => o.structure_id === id).length;
    },

    /** "1 block" / "3 blocks" — object rows carry a raw blockCount. */
    blockLabel(object) {
      const n = object.blockCount ?? 0;
      return `${n} ${n === 1 ? "block" : "blocks"}`;
    },

    /** Settings type cards: "10 objects" / "1 object". */
    objectCountLabel(id) {
      const n = this.countForStructure(id);
      return `${n} ${n === 1 ? "object" : "objects"}`;
    },

    /** The card icon: the object's own icon, otherwise its type's. */
    objectIcon(object) {
      return object.icon || object.structure?.icon || "•";
    },

    recentObjects() {
      return this.objects.slice(0, 8);
    },

    pinnedObjects() {
      const pinned = this.pinnedIds;
      return this.objects.filter((o) => pinned.includes(o.id));
    },

    calendarObjects() {
      const daily = this.structures.find((s) => s.slug === "daily-note");
      if (!daily) return [];
      return this.objects
        .filter((o) => o.structure_id === daily.id)
        .sort((a, b) => (a.title < b.title ? 1 : a.title > b.title ? -1 : 0));
    },

    listHeading() {
      if (this.view === "pinned") return "Pinned";
      if (this.view === "calendar") return "Calendar";
      if (this.view === "today") return "Today";
      if (this.view.startsWith("tag:")) return `#${this.view.slice(4)}`;
      const s = this.structures.find((s) => s.id === this.view);
      return s ? `${s.icon || ""} ${s.name}`.trim() : "Explore";
    },

    listSubtitle() {
      const n = this.viewObjects().length;
      const unit = n === 1 ? "object" : "objects";
      if (this.view === "pinned") return `${n} ${unit} pinned to the sidebar`;
      if (this.view === "calendar") return `${n} ${unit} · daily notes, newest date first`;
      if (this.view === "today") return `${n} ${unit} · today's note is created on demand`;
      if (this.view.startsWith("tag:")) return `${n} ${unit} carrying this tag`;
      if (this.isStructureView()) return `${n} ${unit} of this type`;
      return `${n} ${unit} · most recently updated first`;
    },

    emptyStateText() {
      if (this.view === "pinned") return "Nothing pinned yet — hover a card and press 📌.";
      if (this.view === "calendar") return "No daily notes yet. Press Ctrl+N and pick the Daily Note type.";
      return "No objects here yet. Press Ctrl+N or “＋ New object” to create one.";
    },

    async openToday() {
      this.view = "today";
      const d = new Date();
      const todayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      let daily = this.structures.find((s) => s.slug === "daily-note");
      if (!daily) {
        daily = await this.api("/structures", {
          method: "POST",
          body: JSON.stringify({ name: "Daily Note", icon: "📅" }),
        });
        await this.loadStructures();
      }
      const existing = this.objects.filter((o) => o.structure_id === daily.id);
      let today = existing.find((o) => o.title === todayStr);
      if (!today) {
        today = await this.api("/objects", {
          method: "POST",
          body: JSON.stringify({
            structureId: daily.id,
            title: todayStr,
            blocks: [{ type: "paragraph", content: { text: "" } }],
          }),
        });
        await this.loadObjects();
      }
      this.openObject(today.id);
    },

    fmtDate(iso) {
      if (!iso) return "—";
      const d = new Date(iso);
      return isNaN(d) ? "—" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    },

    fmtRelative(iso) {
      if (!iso) return "—";
      const then = new Date(iso).getTime();
      if (isNaN(then)) return "—";
      const minutes = Math.round((Date.now() - then) / 60000);
      if (minutes < 1) return "just now";
      if (minutes < 60) return `${minutes}m ago`;
      const hours = Math.round(minutes / 60);
      if (hours < 24) return `${hours}h ago`;
      const days = Math.round(hours / 24);
      if (days < 30) return `${days}d ago`;
      return new Date(iso).toLocaleDateString();
    },

    // ---------- tabs + history ----------
    openTab(obj) {
      const existing = this.tabs.find((t) => t.id === obj.id);
      if (existing) {
        existing.title = obj.title;
        existing.icon = obj.icon;
      } else {
        this.tabs = [...this.tabs, { id: obj.id, title: obj.title, icon: obj.icon }];
      }
      const MAX_TABS = 10;
      while (this.tabs.length > MAX_TABS) {
        const victim = this.tabs.find((t) => t.id !== obj.id);
        this.tabs = this.tabs.filter((t) => t.id !== victim.id);
      }
      this.activeTabId = obj.id;
    },

    async activateTab(id) {
      if (id === this.activeTabId) return;
      await this.openObject(id);
    },

    async closeTab(id) {
      const idx = this.tabs.findIndex((t) => t.id === id);
      if (idx < 0) return;
      const wasActive = this.activeTabId === id;
      this.tabs = this.tabs.filter((t) => t.id !== id);
      if (!wasActive) return;
      const next = this.tabs[idx] || this.tabs[idx - 1] || null;
      if (next) await this.openObject(next.id);
      else {
        this.activeTabId = null;
        this.currentObject = null;
        this.blocks = [];
        this.destroyRenderedBlocks();
      }
    },

    pushHistory(id) {
      if (this.history[this.historyIndex] === id) return;
      this.history = this.history.slice(0, this.historyIndex + 1);
      this.history.push(id);
      if (this.history.length > 50) this.history.shift();
      this.historyIndex = this.history.length - 1;
    },

    canGoBack() {
      return this.historyIndex > 0;
    },

    canGoForward() {
      return this.historyIndex < this.history.length - 1;
    },

    async goBack() {
      if (!this.canGoBack()) return;
      this.historyIndex -= 1;
      await this.openObject(this.history[this.historyIndex], { skipHistory: true });
    },

    async goForward() {
      if (!this.canGoForward()) return;
      this.historyIndex += 1;
      await this.openObject(this.history[this.historyIndex], { skipHistory: true });
    },

    async openObject(id, opts = {}) {
      this.flushBlockSaves();
      this.destroyRenderedBlocks();
      const obj = await this.api(`/objects/${id}`);
      obj.blocks = obj.blocks.map((b) =>
        b.type === "code"
          ? { ...b, content: { ...b.content, language: this.normalizeCodeLang(b.content?.language) } }
          : b
      );
      // Property definitions (status/due …) are per-structure; the object row
      // only carries the result rows, so the editor needs this one extra fetch.
      // Build the FULL object BEFORE handing it to the reactive component —
      // mutating `obj` after `this.currentObject = obj` would never reach the
      // Alpine proxy it captured.
      const [backlinks, linkedObjects, structDefs] = await Promise.all([
        this.api(`/objects/${id}/backlinks`),
        this.api(`/objects/${id}/linked`),
        this.api(`/structures/${obj.structure_id}`).catch(() => null),
      ]);
      if (structDefs && structDefs.properties) {
        obj.structure = { ...obj.structure, properties: structDefs.properties };
      }
      this.currentObject = obj;
      this.blocks = obj.blocks;
      this.backlinks = backlinks;
      this.linkedObjects = linkedObjects;
      this.openTab(obj);
      if (!opts.skipHistory) this.pushHistory(obj.id);
      this.$nextTick(() => this.hydrateBlockText());
    },

    hydrateBlockText() {
      // fill contenteditable elements from block.content after Alpine renders
      // (rows follow the tree, so the block is looked up by id, never by index)
      document.querySelectorAll(".block[data-block-id]").forEach((el) => {
        const block = this.blocks.find((b) => b.id === el.dataset.blockId);
        const editable = el.querySelector("[contenteditable]");
        if (!block || !editable || editable.isContentEditableDone) return;
        this.fillEditable(editable, block);
        editable.isContentEditableDone = true;
      });
    },

    /**
     * Render order: blocks are a tree (`parentId` + per-sibling `position`), the
     * editor renders it flattened with a depth per row. `_depth` is transient
     * layout state — it is never sent to the API.
     */
    blockRows() {
      if (rowsCache.key !== this.blocks) {
        rowsCache.key = this.blocks;
        const byParent = new Map();
        for (const b of this.blocks) {
          const key = b.parentId || "";
          if (!byParent.has(key)) byParent.set(key, []);
          byParent.get(key).push(b);
        }
        const rows = [];
        const walk = (parentId, depth) => {
          const list = (byParent.get(parentId) ?? []).slice().sort((a, b) => a.position - b.position);
          for (const b of list) {
            b._depth = depth;
            rows.push(b);
            walk(b.id, depth + 1);
          }
        };
        walk("", 0);
        // Numbered items are separate blocks, so their marker is computed here
        // (entry-rules.numberListRows) and rendered through data-number.
        rowsCache.rows = window.NTEntry ? window.NTEntry.numberListRows(rows) : rows;
      }
      return rowsCache.rows;
    },

    /** In-place structural edits (add/delete/convert/move) rebuild the row order. */
    invalidateRows() {
      rowsCache.key = null;
    },

    /**
     * The row above a block in the rendered tree — what Backspace merges into.
     * `this.blocks` is ordered by position only, so the array neighbour is not
     * the visual one once blocks are nested.
     */
    previousRow(blockId) {
      const rows = this.blockRows();
      const at = rows.findIndex((b) => b.id === blockId);
      return at > 0 ? rows[at - 1] : null;
    },

    /**
     * The row below a block in the rendered tree — the next sibling subtree on.
     * Same reason as `previousRow`: only `blockRows` knows the visual order.
     */
    nextRow(blockId) {
      const rows = this.blockRows();
      const at = rows.findIndex((b) => b.id === blockId);
      return at >= 0 && at < rows.length - 1 ? rows[at + 1] : null;
    },

    /**
     * Does this block own nested blocks? Enter, Backspace and Delete all behave
     * differently on a parent: its subtree is never split apart or deleted.
     */
    blockHasChildren(blockId) {
      return this.blocks.some((b) => b.parentId === blockId);
    },

    blockIndent(block) {
      const depth = block._depth || 0;
      return depth ? `margin-left:${depth * 22}px` : "";
    },

    /** Render one text block's `text` + `marks` (inline model, never raw HTML). */
    fillEditable(editable, block) {
      const Marks = window.NTMarks;
      if (Marks) Marks.apply(editable, block.content?.text ?? "", block.content?.marks);
      else editable.textContent = block.content?.text ?? "";
    },

    /**
     * Write a block's model back into its element and return that element.
     *
     * A split or a merge changes the model while the DOM keeps the old text, and
     * `@blur` saves whatever the DOM holds — so the DOM has to be brought back in
     * line, or the next blur writes the pre-split line over the new one.
     */
    syncBlockElement(blockId, content) {
      const block = this.blocks.find((b) => b.id === blockId);
      const el = document.querySelector(`.block[data-block-id="${blockId}"] [contenteditable]`);
      if (block && el) this.fillEditable(el, { ...block, content: { ...block.content, ...content } });
      return el;
    },

    /** The inline model of a contenteditable: `{ text, marks }`. */
    parseInline(el) {
      const Marks = window.NTMarks;
      if (!Marks || !el) return { text: el?.textContent ?? "", marks: [] };
      return Marks.serialize(el);
    },

    /** Persist a text block from its contenteditable (text + marks + extras). */
    saveBlockFromEl(block, el, extra = {}) {
      if (!block) return;
      const parsed = el
        ? this.parseInline(el)
        : { text: block.content?.text ?? "", marks: block.content?.marks ?? [] };
      return this.saveBlockContent(block, { ...parsed, ...extra });
    },

    // ---------- reorder: drag & drop, Tab / Shift+Tab ----------
    onBlockDragStart(block, evt) {
      this.drag = { blockId: block.id, overId: null, place: "before" };
      if (evt.dataTransfer) {
        evt.dataTransfer.effectAllowed = "move";
        evt.dataTransfer.setData("text/plain", block.id);
      }
    },

    onBlockDragOver(block, evt) {
      if (!this.drag.blockId || this.drag.blockId === block.id) return;
      const rect = evt.currentTarget.getBoundingClientRect();
      this.drag.overId = block.id;
      this.drag.place = evt.clientY < rect.top + rect.height / 2 ? "before" : "after";
    },

    onBlockDragLeave(block) {
      if (this.drag.overId === block.id) this.drag.overId = null;
    },

    onBlockDragEnd() {
      this.drag = { blockId: null, overId: null, place: "before" };
    },

    /** Drop on the upper half = before the target, lower half = after it. */
    async onBlockDrop(block) {
      const dragId = this.drag.blockId;
      const place = this.drag.place;
      this.onBlockDragEnd();
      if (!dragId || dragId === block.id) return;
      const moved = this.blocks.find((b) => b.id === dragId);
      if (!moved) return;
      await this.moveBlockTo(moved, block.parentId ?? null, place === "before" ? block.position : block.position + 1);
    },

    /** Tab nests a block under the row above it; Shift+Tab promotes it. */
    async indentBlock(block) {
      const rows = this.blockRows();
      const at = rows.findIndex((b) => b.id === block.id);
      if (at <= 0) return;
      const prev = rows[at - 1];
      const under = this.blocks.filter((b) => (b.parentId || "") === prev.id).length;
      await this.moveBlockTo(block, prev.id, under);
    },

    async outdentBlock(block) {
      if (!block.parentId) return;
      const parent = this.blocks.find((b) => b.id === block.parentId);
      if (!parent) return;
      await this.moveBlockTo(block, parent.parentId ?? null, parent.position + 1);
    },

    async moveBlockTo(block, parentId, position) {
      if (parentId === block.id) return;
      try {
        await this.api(`/objects/${block.objectId}/blocks/${block.id}/move`, {
          method: "POST",
          body: JSON.stringify({ parentId: parentId ?? null, position: Math.max(0, position) }),
        });
        await this.reloadBlocks();
      } catch (e) {
        // api() already surfaced the error toast
      }
    },

    /** The block that owns a contenteditable (for saves from the toolbar). */
    blockFromEl(el) {
      const host = el?.closest?.(".block");
      const id = host?.dataset?.blockId;
      return id ? this.blocks.find((b) => b.id === id) : undefined;
    },

    /** Nearest contenteditable ancestor of a selection node, if any. */
    editableFromNode(node) {
      let n = node;
      while (n && n !== document.body) {
        if (n.nodeType === 1 && n.isContentEditable) return n;
        n = n.parentNode;
      }
      return null;
    },

    closeObject() {
      this.flushBlockSaves();
      this.destroyRenderedBlocks();
      this.currentObject = null;
      this.blocks = [];
      this.activeTabId = null;
      this.loadObjects();
    },

    // ---------- pin (per space, browser-side) ----------
    pinnedKey(id) {
      return `nt-pinned:${id}`;
    },

    restorePinned() {
      this.pinnedIds = [];
      if (!this.currentSpaceId) return;
      try {
        const raw = JSON.parse(localStorage.getItem(this.pinnedKey(this.currentSpaceId)) || "null");
        if (Array.isArray(raw)) this.pinnedIds = raw.filter((id) => typeof id === "string");
      } catch (e) {}
    },

    persistPinned() {
      if (!this.currentSpaceId) return;
      try {
        localStorage.setItem(this.pinnedKey(this.currentSpaceId), JSON.stringify(this.pinnedIds));
      } catch (e) {}
    },

    isPinned(id) {
      return this.pinnedIds.includes(id);
    },

    togglePin(id) {
      const wasPinned = this.isPinned(id);
      this.pinnedIds = wasPinned ? this.pinnedIds.filter((x) => x !== id) : [...this.pinnedIds, id];
      this.persistPinned();
      this.showToast(wasPinned ? "Unpinned" : "Pinned to sidebar");
    },

    // ---------- search palette ----------
    openPalette() {
      this.palette.open = true;
      this.$nextTick(() => {
        const el = document.querySelector(".palette-input");
        if (el) el.focus();
      });
    },

    async runPaletteSearch() {
      const q = this.palette.query.trim();
      this.palette.index = 0;
      if (!q) {
        this.palette.hits = [];
        return;
      }
      const params = new URLSearchParams({ q });
      if (this.isStructureView()) params.set("structureId", this.view);
      else if (this.view.startsWith("tag:")) params.set("tag", this.view.slice(4));

      // Ignore out-of-order responses from earlier keystrokes.
      const seq = ++this.palette.seq;
      const hits = await this.api(`/search?${params.toString()}`);
      if (seq !== this.palette.seq) return;
      this.palette.hits = hits;
      this.palette.index = 0;
    },

    paletteMove(delta) {
      const n = this.palette.hits.length;
      if (!n) return;
      this.palette.index = (this.palette.index + delta + n) % n;
    },

    paletteOpenActive() {
      const hit = this.palette.hits[this.palette.index];
      if (hit) this.openHit(hit);
    },

    matchLabel(matchType) {
      return {
        title_exact: "Title · exact",
        title_prefix: "Title",
        title_substring: "Title",
        body: "Text",
        tag: "Tag",
      }[matchType] || matchType;
    },

    openHit(hit) {
      this.openObject(hit.object.id);
      this.palette.open = false;
    },

    // ---------- object type picker ----------
    openTypePicker() {
      this.spaceMenuOpen = false;
      this.typePicker.open = true;
      this.typePicker.query = "";
      this.typePicker.index = 0;
      this.$nextTick(() => {
        const el = document.querySelector(".picker-input");
        if (el) el.focus();
      });
    },

    typeOptions() {
      const q = this.typePicker.query.trim().toLowerCase();
      if (!q) return this.structures;
      return this.structures.filter((s) => s.name.toLowerCase().includes(q) || (s.slug || "").toLowerCase().includes(q));
    },

    typeMove(delta) {
      const n = this.typeOptions().length;
      if (!n) return;
      this.typePicker.index = (this.typePicker.index + delta + n) % n;
    },

    /** Deterministic tile colour per object type — same slug, same colour, no palette state. */
    typeColor(s) {
      const palette = ["#4f7cf7", "#e0873a", "#d9534f", "#3aa76d", "#8b5cf6", "#0ea5e9", "#eab308", "#ec4899"];
      const key = (s && (s.slug || s.name)) || "";
      let hash = 0;
      for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) % 9973;
      return palette[hash % palette.length];
    },

    typePickerEnter(evt) {
      const options = this.typeOptions();
      const picked = options[this.typePicker.index] ?? options[0];
      if (!picked && this.typePicker.query.trim()) { this.createFromPicker(); return; }
      if (!picked) return;
      if (evt && evt.shiftKey) {
        this.typePicker.open = false;
        this.newObject.structureId = picked.id;
        this.newObjectModal = true;
        return;
      }
      this.typeSelect(picked);
    },

    createFromPicker() {
      const query = this.typePicker.query.trim().toLowerCase();
      const match = this.structures.find((s) => s.name.trim().toLowerCase() === query || (s.slug || "").toLowerCase() === query);
      if (match) return this.typeSelect(match);
      this.typePicker.open = false;
      this.newObject = { ...this.newObject, title: this.typePicker.query.trim(), structureId: this.structures[0]?.id ?? "", description: "", tags: "", content: "" };
      this.newObjectModal = true;
      this.$nextTick(() => this.$refs.newObjectTitle?.focus());
    },

    /** Picking a type creates the object straight away (the detail form stays on Shift+Enter). */
    async typeSelect(s) {
      if (!s || this.creatingObject) return;
      this.typePicker.open = false;
      this.creatingObject = true;
      try {
      const created = await this.api("/objects", {
        method: "POST",
        body: JSON.stringify({
          structureId: s.id,
          title: "Untitled",
          blocks: [{ type: "paragraph", content: { text: "" } }],
        }),
      });
      await Promise.all([this.loadObjects(), this.loadTags()]);
      await this.openObject(created.id);
      await this.$nextTick();
      setTimeout(() => this.focusTitle(), 80);
      this.showToast(`New ${s.name.toLowerCase()} created`);
      } catch (error) {
        this.showToast(error.message || "Could not create object");
      } finally {
        this.creatingObject = false;
      }
    },

    // ---------- settings ----------
    openSettings(pane) {
      this.spaceSwitcher.open = false;
      if (pane) this.settings.pane = pane;
      if (this.settings.pane === "space") this.syncSpaceForm();
      this.settings.open = true;
    },

    notImplemented(label) {
      this.showToast(`${label} is not implemented yet`);
    },

    editType(structure) {
      this.settings.pane = "object-types";
      if (!structure) {
        this.typeEditor = { open: true, id: null, name: "", icon: "📄" };
        return;
      }
      this.typeEditor = { open: true, id: structure.id, name: structure.name, icon: structure.icon || "📄" };
    },

    async saveType() {
      const name = this.typeEditor.name.trim();
      const icon = (this.typeEditor.icon || "").trim() || "📄";
      if (!name) {
        this.showToast("Name is required");
        return;
      }
      if (this.typeEditor.id) {
        await this.api(`/structures/${this.typeEditor.id}`, {
          method: "PATCH",
          body: JSON.stringify({ name, icon }),
        });
        this.showToast("Object type updated");
      } else {
        await this.api("/structures", {
          method: "POST",
          body: JSON.stringify({ name, icon }),
        });
        this.showToast("Object type created");
      }
      this.typeEditor.open = false;
      await this.loadStructures();
      await this.loadObjects();
    },

    /** Full export: structures + tags + every object with its blocks, as one JSON file. */
    async exportJson() {
      this.showToast("Building export…");
      const payload = {
        exportedAt: new Date().toISOString(),
        structures: this.structures,
        tags: this.tags,
        objects: [],
      };
      for (const o of this.objects) {
        payload.objects.push(await this.api(`/objects/${o.id}`));
      }
      const blob = new Blob([JSON.stringify(payload, null, 1)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `notetaker-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      this.showToast(`Exported ${payload.objects.length} objects`);
    },

    // ---------- object creation ----------
    /**
     * Markdown-lite -> block payloads. The grammar lives in entry-rules.js: the
     * paste path builds blocks from a clipboard with the same parser, and the
     * pure version is unit-tested (tests/entry-rules.test.ts).
     */
    parseContentToBlocks(raw) {
      const Rules = window.NTEntry;
      if (!Rules) return [];
      return Rules.markdownToBlocks(raw, {
        normalizeLang: (lang) => this.normalizeCodeLang(lang),
        normalizeTex: (tex) => this.normalizeTex(tex),
      });
    },

    async createObject() {
      if (this.creatingObject) return;
      this.creatingObject = true;
      try {
      const parsed = this.parseContentToBlocks(this.newObject.content);
      const tags = this.newObject.tags.split(",").map((t) => t.trim()).filter(Boolean);
      const description = this.newObject.description.trim();
      const created = await this.api("/objects", {
        method: "POST",
        body: JSON.stringify({
          structureId: this.newObject.structureId,
          title: this.newObject.title.trim() || "Untitled",
          description: description || undefined,
          tags: tags.length ? tags : undefined,
          blocks: parsed.length ? parsed : [{ type: "paragraph", content: { text: "" } }],
        }),
      });
      this.newObjectModal = false;
      this.newObject = { title: "", description: "", structureId: this.structures[0]?.id ?? "", tags: "", content: "" };
      await Promise.all([this.loadObjects(), this.loadTags()]);
      this.showToast("Created");
      this.openObject(created.id);
      } catch (error) {
        this.showToast(error.message || "Could not create object");
      } finally {
        this.creatingObject = false;
      }
    },

    // ---------- editable object properties (right info panel) ----------
    /** Empty string means "no value set"; the control shows a placeholder instead of "". */
    propValue(def) {
      const v = this.currentObject?.properties?.[def?.slug];
      if (v === null || v === undefined || v === "") return "";
      if (def?.type === "boolean") {
        if (v === true || v === "true") return "true";
        if (v === false || v === "false") return "false";
        return "";
      }
      if (Array.isArray(v)) return v.join(", ");
      if (typeof v === "object") return JSON.stringify(v);
      return String(v);
    },

    /** Which input widget a property definition maps to. */
    propInputType(def) {
      const t = (def && def.type) || "text";
      if (t === "number") return "number";
      if (t === "date" || t === "datetime") return "date";
      if (t === "boolean") return "boolean";
      return "text"; // text, select, url, multi_select all edit as text (multi_select = comma list)
    },

    propertyDefs() {
      return this.currentObject?.structure?.properties || [];
    },

    async setProperty(def, evt) {
      if (!this.currentObject) return;
      const raw = evt.target.value;
      let value;
      if (raw === "") {
        value = null;
      } else if (def.type === "boolean") {
        value = raw === "true";
      } else if (def.type === "number") {
        value = raw; // the service coerces and rejects non-numbers
      } else if (def.type === "multi_select") {
        value = raw.split(",").map((s) => s.trim()).filter(Boolean);
      } else {
        value = raw;
      }
      try {
        const updated = await this.api(`/objects/${this.currentObject.id}/properties`, {
          method: "PATCH",
          body: JSON.stringify({ properties: { [def.slug]: value } }),
        });
        if (updated) this.currentObject.properties = updated.properties;
        this.loadObjects(); // keep the list cards in sync
      } catch (error) {
        this.showToast(error.message || "Could not save property");
      }
    },

    /** Property values shown as chips on the list-view cards (label: value). */
    objectProps(o) {
      if (!o || !o.properties) return [];
      return Object.entries(o.properties)
        .filter(([, v]) => v !== null && v !== undefined && v !== "")
        .map(([slug, value]) => ({
          slug,
          value: Array.isArray(value) ? value.join(", ") : typeof value === "object" ? JSON.stringify(value) : String(value),
        }));
    },

    /** Status-like values get a colour so a project list reads at a glance. */
    propChipClass(slug, value) {
      if (slug !== "status" && slug !== "priority") return "";
      const v = String(value || "").toLowerCase();
      if (["done", "completed", "low"].includes(v)) return "chip-ok";
      if (["paused", "blocked", "high", "urgent"].includes(v)) return "chip-warn";
      if (["active", "in-progress", "medium"].includes(v)) return "chip-info";
      return "";
    },

    async renameObject(title) {
      if (!this.currentObject || !title) return;
      // Enter in the title saves, then the blur fires this again: a no-op
      // PATCH (and a second "Renamed" toast). Skip when nothing changed.
      const trimmed = typeof title === "string" ? title.trim() : "";
      if (!trimmed) return; // whitespace-only: keep the current title
      if (trimmed === this.currentObject.title) {
        const tab = this.tabs.find((t) => t.id === this.currentObject.id);
        if (tab) tab.title = this.currentObject.title;
        return;
      }
      const updated = await this.api(`/objects/${this.currentObject.id}`, {
        method: "PATCH",
        body: JSON.stringify({ title: trimmed }),
      });
      this.currentObject = updated;
      const tab = this.tabs.find((t) => t.id === this.currentObject.id);
      if (tab) tab.title = this.currentObject.title;
      this.showToast("Renamed");
    },

    /** Enter in the title saves and jumps into the first block. */
    async commitTitle(evt) {
      const value = (evt.target.textContent || "").trim();
      if (value) await this.renameObject(value);
      evt.target.blur();
      const first = document.querySelector(".block-list .block [contenteditable]");
      if (first) first.focus();
    },

    // ---------- quick page creation ----------
    /** Where the quick "new page" action creates: the structure being viewed, else Page. */
    newPageStructure() {
      if (this.isStructureView()) {
        const viewed = this.structures.find((s) => s.id === this.view);
        if (viewed) return viewed;
      }
      return this.structures.find((s) => s.slug === "page") ?? this.structures[0] ?? null;
    },

    newPageLabel() {
      const structure = this.newPageStructure();
      return structure ? `New ${structure.name.toLowerCase()}` : "New page";
    },

    /** One click: create an empty object of the relevant type and start typing. */
    async createPage() {
      const structure = this.newPageStructure();
      if (!structure) {
        this.showToast("No structure available");
        return;
      }
      const created = await this.api("/objects", {
        method: "POST",
        body: JSON.stringify({
          structureId: structure.id,
          title: "Untitled",
          blocks: [{ type: "paragraph", content: { text: "" } }],
        }),
      });
      await Promise.all([this.loadObjects(), this.loadTags()]);
      this.showToast(`New ${structure.name.toLowerCase()} created`);
      await this.openObject(created.id);
      await this.$nextTick();
      setTimeout(() => this.focusTitle(), 80);
    },

    /** Focus the title and select it so typing replaces "Untitled". */
    focusTitle() {
      const el = document.querySelector(".page-title");
      if (!el) return;
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    },

    async saveDescription(text) {
      if (!this.currentObject) return;
      const value = (text || "").trim() || null;
      if ((this.currentObject.description ?? null) === value) return;
      this.currentObject = await this.api(`/objects/${this.currentObject.id}`, {
        method: "PATCH",
        body: JSON.stringify({ description: value }),
      });
      this.showToast("Saved");
    },

    // ---------- blocks ----------
    blockDefinitions() {
      return window.NTBlocks ? window.NTBlocks.definitions : [];
    },

    blockDefaults(type) {
      const def = window.NTBlocks ? window.NTBlocks.byType(type) : null;
      if (def) return def.defaults();
      return {
        heading: { level: 2, text: "" },
        paragraph: { text: "" },
        todo: { text: "", checked: false },
        quote: { text: "" },
        bulleted_list: { text: "" },
        numbered_list: { text: "" },
        code: { language: "plaintext", code: "" },
        math: { tex: "", display: true },
        mermaid: { code: "graph TD\n  A[Start] --> B[End]" },
        plantuml: { code: "@startuml\nAlice -> Bob: hello\n@enduml" },
        d2: { code: "a -> b: hello" },
        whiteboard: { snapshot: null },
        divider: {},
      }[type] ?? {};
    },

    /** `content` defaults to the type's first definition — pass it when a chip owns its variant. */
    async addBlock(type, content) {
      const payload = { type, content: content ?? this.blockDefaults(type) };
      const block = await this.api(`/objects/${this.currentObject.id}/blocks`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      this.blocks.push(block);
      this.invalidateRows();
      this.$nextTick(() => setTimeout(() => this.focusBlock(block.id), 60));
      this.pushUndo(this.insertEntry(this.currentObject.id, payload, block.id));
      this.showToast("Block added");
    },

    /**
     * Toolbar chips pass the whole definition: H1/H2/H3 share one block type, so
     * looking the defaults up by type would always create the first heading.
     */
    async addBlockDef(def) {
      return this.addBlock(def.type, def.defaults());
    },

    /**
     * POST one block directly below `refBlock` (same parent, next position) and
     * remember the undo entry. The caller owns the content: a line split by Enter
     * or a paste hands over text the type's defaults cannot know.
     */
    async postBlockAfter(refBlock, type, content) {
      const payload = {
        type,
        content: content ?? this.blockDefaults(type),
        // a new line belongs to the same sibling list as the block it follows
        parentId: refBlock?.parentId ?? null,
        position: (refBlock?.position ?? -1) + 1,
      };
      const block = await this.api(`/objects/${this.currentObject.id}/blocks`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      this.blocks.push(block);
      this.invalidateRows();
      this.pushUndo(this.insertEntry(this.currentObject.id, payload, block.id));
      return block;
    },

    /**
     * Insert a block below `refBlock` and put the caret in it.
     * `content` overrides the type defaults (the tail of a split line), while
     * `opts.focus: false` leaves the caret alone (a paste inserts a run of
     * blocks), `opts.reload: false` skips the extra read, and `opts.caret` is
     * "start" | "end" inside the new block.
     */
    async addBlockAfter(type, refBlock, content, opts = {}) {
      const block = await this.postBlockAfter(refBlock, type, content);
      if (opts.reload !== false) {
        // the server renumbered the siblings; take its word for the new order
        await this.reloadBlocks();
      }
      if (opts.focus !== false) {
        // after the reload, so the element being focused is the one now rendered
        const caret = opts.caret ?? "start";
        this.$nextTick(() => setTimeout(() => this.focusBlock(block.id, 2, caret), 40));
      }
      return block;
    },

    /**
     * Undo entry for an insert. Redo re-creates the block, which hands out a
     * new id — the entry remembers it so the next undo deletes the right one.
     */
    insertEntry(objectId, payload, blockId) {
      const entry = {
        label: "insert",
        coalesceKey: null,
        id: blockId,
        undo: async () => {
          await this.api(`/objects/${objectId}/blocks/${entry.id}`, { method: "DELETE" });
          this.destroyRenderedBlock(entry.id);
          this.blocks = this.blocks.filter((b) => b.id !== entry.id);
        },
        redo: async () => {
          const recreated = await this.api(`/objects/${objectId}/blocks`, {
            method: "POST",
            body: JSON.stringify(payload),
          });
          entry.id = recreated.id;
          await this.reloadBlocks();
        },
      };
      return entry;
    },

    /** Re-read the block list: moves and inserts renumber every sibling. */
    async reloadBlocks() {
      const id = this.currentObject?.id;
      if (!id) return;
      try {
        this.blocks = await this.api(`/objects/${id}/blocks`);
        this.$nextTick(() => this.hydrateBlockText());
      } catch (e) {
        // api() already surfaced the error toast
      }
    },

    /** The live copy of a block: renderer closures hold one that edits replace. */
    liveBlock(blockId) {
      return this.blocks.find((b) => b.id === blockId);
    },

    /** Click the empty page below the last block to keep writing there. */
    async addParagraphAtEnd() {
      if (!this.currentObject) return;
      const rows = this.blockRows();
      const last = rows[rows.length - 1];
      if (!last) return this.addBlock("paragraph");
      if (last.type === "paragraph" && !(last.content?.text ?? "").length) {
        const el = document.querySelector(`.block[data-block-id="${last.id}"] [contenteditable]`);
        if (el) { el.focus(); return; }
      }
      return this.addBlockAfter("paragraph", last);
    },

    /** Delete a block from the page (the last remaining block is kept). */
    async deleteBlock(block) {
      if (this.blocks.length <= 1) {
        this.showToast("A page keeps at least one block");
        return;
      }
      await this.removeBlock(block);
      this.showToast("Block deleted");
    },

    /**
     * Remove a block (the server cascades its subtree) and leave an undo entry
     * behind: Ctrl+Z after a delete or a merged line must bring the line back.
     */
    async removeBlock(block) {
      const payload = {
        type: block.type,
        content: block.content,
        parentId: block.parentId ?? null,
        position: block.position,
      };
      await this.api(`/objects/${block.objectId}/blocks/${block.id}`, { method: "DELETE" });
      this.destroyRenderedBlock(block.id);
      const idx = this.blocks.findIndex((b) => b.id === block.id);
      if (idx >= 0) this.blocks.splice(idx, 1);
      this.invalidateRows();
      this.pushUndo(this.removeEntry(block.objectId, payload, block.id));
    },

    /**
     * Undo entry for a removal: undo re-creates the block where it sat (the
     * server hands out a new id, so the entry remembers it), redo deletes it again.
     */
    removeEntry(objectId, payload, blockId) {
      const entry = {
        label: "delete",
        coalesceKey: null,
        id: blockId,
        undo: async () => {
          const recreated = await this.api(`/objects/${objectId}/blocks`, {
            method: "POST",
            body: JSON.stringify(payload),
          });
          entry.id = recreated.id;
          await this.reloadBlocks();
        },
        redo: async () => {
          await this.api(`/objects/${objectId}/blocks/${entry.id}`, { method: "DELETE" });
          this.destroyRenderedBlock(entry.id);
          await this.reloadBlocks();
        },
      };
      return entry;
    },

    /** Heading level marker: H1 → H2 → H3 → H1, saved straight away. */
    async cycleHeadingLevel(block) {
      if (block.type !== "heading") return;
      // Read the live buffer first: clicking the badge blurs the editor, and the
      // save that follows must not reuse a stale copy of the text.
      const el = document.querySelector(`.block[data-block-id="${block.id}"] [contenteditable]`);
      const text = el ? el.textContent ?? "" : block.content?.text ?? "";
      const level = ((Number(block.content?.level) || 1) % 3) + 1;
      const updated = await this.saveBlockContent(block, { level, text });
      this.showToast(`Heading ${updated?.content?.level ?? level}`);
      this.$nextTick(() => this.focusBlock(block.id));
    },

    /**
     * Placeholder policy: the empty page teaches the slash menu once, and a heading
     * names its own level while empty. New lines created with Enter stay clean.
     */
    blockPlaceholder(block) {
      const empty = !(block.content?.text ?? "").length;
      if (!empty) return "";
      if (block.type === "heading") return `Heading ${Number(block.content?.level) || 1}`;
      if (block.type === "paragraph" && this.blocks.length === 1) return "Type '/' to insert a block…";
      return "";
    },

    /**
     * Reveal the source editor of a preview block (math/mermaid/plantuml/d2) and
     * focus it. Its textarea ships hidden, and focus() on a hidden element is a
     * no-op — which used to leave a freshly inserted diagram block unfocusable.
     */
    openRenderSource(blockId) {
      const state = this.rendererState.get(blockId);
      const ta = state?.textarea;
      if (!ta) return false;
      if (ta.hidden) {
        ta.hidden = false;
        if (state.toggleBtn) state.toggleBtn.textContent = "Done";
        this.setRenderStatus(state.container, null);
        this.autoGrowEl(ta);
      }
      ta.focus();
      return true;
    },

    /**
     * Focus whatever represents the block: inline text or its mounted renderer.
     * `caret` is optional — "start" or "end" places the caret inside the text
     * block (arrow-key navigation and a line split both need to land somewhere
     * exact, and `focus()` alone does not say where).
     */
    focusBlock(blockId, retries = 2, caret = null) {
      const state = this.rendererState.get(blockId);
      if (state?.cm) { state.cm.focus(); return true; }
      if (state?.textarea) { return this.openRenderSource(blockId); }
      const block = this.blocks.find((b) => b.id === blockId);
      if (block && this.isRenderedBlock(block.type)) {
        // Renderers mount asynchronously: retry a couple of times, then give up.
        if (retries > 0) setTimeout(() => this.focusBlock(blockId, retries - 1, caret), 450);
        return false;
      }
      const el = document.querySelector(`.block[data-block-id="${blockId}"] [contenteditable]`);
      if (!el) return false;
      el.focus();
      if (caret) this.placeCaretAt(el, caret === "end" ? (el.textContent ?? "").length : 0);
      return true;
    },

    /**
     * Focus the edge of a block: the caret lands at the end of its last line or
     * the start of its first. Renderer blocks own their editor, so CodeMirror and
     * the diagram textareas are handled through their runtime state.
     */
    focusBlockEdge(blockId, edge) {
      const state = this.rendererState.get(blockId);
      if (state?.cm) {
        const cm = state.cm;
        const line = edge === "end" ? cm.lastLine() : cm.firstLine();
        cm.focus();
        cm.setCursor({ line, ch: edge === "end" ? cm.getLine(line).length : 0 });
        return true;
      }
      if (state?.textarea) {
        const ta = state.textarea;
        this.openRenderSource(blockId);
        const at = edge === "end" ? (ta.value ?? "").length : 0;
        ta.selectionStart = at;
        ta.selectionEnd = at;
        return true;
      }
      return this.focusBlock(blockId, 2, edge);
    },

    // ---------- slash menu ----------
    slashOptions() {
      return window.NTBlocks ? window.NTBlocks.match(this.slash.query) : [];
    },

    openSlash(block, query) {
      this.slash.open = true;
      this.slash.blockId = block.id;
      this.slash.query = query;
      this.slash.index = 0;
    },

    closeSlash() {
      this.slash.open = false;
      this.slash.blockId = null;
      this.slash.query = "";
      this.slash.index = 0;
    },

    /**
     * Pattern detection on input ("/", "/cod", "# ", "- ", "**bold**" …) —
     * no markdown parsing per keystroke, just a rule lookup on what was typed.
     */
    onBlockInput(block, evt) {
      const el = evt.target;
      const text = el.textContent ?? "";
      const m = text.match(/^\/(\S*)$/);
      if (m) {
        this.openSlash(block, m[1]);
        return;
      }
      if (this.slash.blockId === block.id) this.closeSlash();
      const rule = window.NTMarks?.blockRule(text);
      if (rule) {
        this.applyBlockRule(block, rule);
        return;
      }
      this.applyInlineRule(block, el);
      // autosave: debounced, never one request per keystroke (skill.md §5)
      this.queueBlockSave(block.id, this.parseInline(el));
    },

    /**
     * A markdown marker at the start of the line converts the block in place
     * ("## " -> heading 2). Same PATCH-as-conversion the slash menu uses.
     */
    async applyBlockRule(block, rule) {
      const idx = this.blocks.findIndex((b) => b.id === block.id);
      if (idx < 0) return;
      // Optimistic swap first: typing does not wait for the round trip, so the
      // keystrokes after the marker must land in the element of the new type.
      const optimistic = { ...block, type: rule.type, content: { ...rule.content } };
      // Alpine rebuilds the element for the new type; keystrokes typed before it
      // is mounted again would fall on the floor, so they are buffered.
      this.pendingInput = { blockId: block.id, buffer: "", lastEvent: null };
      this.blocks[idx] = optimistic;
      this.invalidateRows();
      this.$nextTick(() => this.focusConvertedBlock(optimistic));
      try {
        await this.api(`/objects/${block.objectId}/blocks/${block.id}`, {
          method: "PATCH",
          body: JSON.stringify({ type: rule.type, content: rule.content }),
        });
        // the optimistic copy already is what the server now stores: replacing
        // the block again here would only re-render and drop the caret
      } catch (e) {
        // api() already surfaced the error toast; the UI must not lie about it
        const at = this.blocks.findIndex((b) => b.id === block.id);
        if (at >= 0) this.blocks[at] = block;
        this.invalidateRows();
        this.pendingInput = { blockId: null, buffer: "", lastEvent: null };
      }
    },

    /**
     * A markdown conversion swaps the DOM element: until the new one is
     * focused, printable keys land nowhere — collect them and replay them.
     */
    bufferPendingInput(evt) {
      if (!this.pendingInput.blockId) return;
      // one keystroke is buffered once, however many listeners see the event
      if (evt === this.pendingInput.lastEvent) return;
      if (evt.ctrlKey || evt.metaKey || evt.altKey || evt.key?.length !== 1) return;
      const target = evt.target;
      if (target && (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      evt.preventDefault();
      this.pendingInput.lastEvent = evt;
      this.pendingInput.buffer += evt.key;
    },

    /** Text + marks currently in the block's contenteditable, if it has one. */
    liveInline(blockId) {
      const el = document.querySelector(`.block[data-block-id="${blockId}"] [contenteditable]`);
      return el ? this.parseInline(el) : null;
    },

    /**
     * A converted block gets a brand-new element (Alpine drops the old one):
     * fill it from the model and put the caret back where the marker ended.
     */
    focusConvertedBlock(block) {
      const el = document.querySelector(`.block[data-block-id="${block.id}"] [contenteditable]`);
      if (!el) {
        // the renderer has not mounted yet: keep the buffer and try again
        if (this.pendingInput.blockId === block.id) {
          setTimeout(() => this.focusConvertedBlock(block), 60);
          return;
        }
        this.focusBlock(block.id);
        return;
      }
      const buffered = this.pendingInput.blockId === block.id ? this.pendingInput.buffer : "";
      this.pendingInput = { blockId: null, buffer: "", lastEvent: null };
      const text = (block.content?.text ?? "") + buffered;
      this.fillEditable(el, { content: { ...block.content, text } });
      el.isContentEditableDone = true;
      el.focus();
      window.NTMarks?.placeCaret(el, text.length);
      if (buffered) {
        block.content = { ...block.content, text };
        this.queueBlockSave(block.id, this.parseInline(el));
      }
    },

    /** `**bold**` typed inline: drop the markers, keep the mark. */
    applyInlineRule(block, el) {
      const Marks = window.NTMarks;
      if (!Marks) return;
      const caret = this.caretOffset(el);
      const rule = Marks.inlineRule((el.textContent ?? "").slice(0, caret));
      if (!rule) return;
      const range = Marks.rangeFromOffsets(el, rule.start, rule.end);
      range.deleteContents();
      const span = document.createElement("span");
      span.className = Marks.classFor(rule.type);
      span.textContent = rule.inner;
      range.insertNode(span);
      Marks.placeCaret(el, rule.start + rule.inner.length);
      if (block) this.queueBlockSave(block.id, this.parseInline(el));
    },

    slashMove(delta) {
      const n = this.slashOptions().length;
      if (!n) return;
      this.slash.index = (this.slash.index + delta + n) % n;
    },

    /** Turn the block holding "/query" into the chosen block type. */
    async pickSlash(def) {
      if (!def) return;
      const blockId = this.slash.blockId;
      this.closeSlash();
      const block = this.blocks.find((b) => b.id === blockId);
      if (!block) return;
      try {
        const updated = await this.api(`/objects/${block.objectId}/blocks/${block.id}`, {
          method: "PATCH",
          body: JSON.stringify({ type: def.type, content: def.defaults() }),
        });
        const idx = this.blocks.findIndex((b) => b.id === block.id);
        if (idx >= 0) this.blocks[idx] = updated;
        this.invalidateRows();
        this.$nextTick(() => setTimeout(() => this.focusBlock(block.id), 100));
      } catch (e) {
        // api() already surfaced the error toast
      }
    },

    // ---------- inline formatting (selection toolbar, Ctrl+B/I/U) ----------
    /** Float the toolbar above a non-empty selection inside a text block. */
    syncFormatToolbar() {
      const sel = window.getSelection();
      const el = this.editableFromNode(sel?.anchorNode);
      if (!sel || sel.isCollapsed || !el || !sel.toString().trim()) {
        this.fmt.open = false;
        return;
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (!rect || (!rect.width && !rect.height)) {
        this.fmt.open = false;
        return;
      }
      this.fmt.x = rect.left + rect.width / 2;
      this.fmt.y = rect.top - 8;
      this.fmt.open = true;
    },

    fmtStyle() {
      return `left:${Math.round(this.fmt.x)}px; top:${Math.round(this.fmt.y)}px`;
    },

    /** Apply (or remove) an inline mark on the current selection. */
    applyMark(type) {
      const sel = window.getSelection();
      const el = this.editableFromNode(sel?.anchorNode);
      if (!sel || sel.isCollapsed || !el) return;
      const block = this.blockFromEl(el);
      this.toggleInlineMark(sel.getRangeAt(0), type);
      // the DOM is the edit: read it back into text + marks and save
      if (block) this.patchBlockNow(block.id, this.parseInline(el));
      this.syncFormatToolbar();
    },

    /**
     * bold/italic/underline/strike go through execCommand (it toggles and keeps
     * the caret); the marks with no native command are wrapped/unwrapped here.
     */
    toggleInlineMark(range, type) {
      const Marks = window.NTMarks;
      if (!Marks) return;
      const command = { bold: "bold", italic: "italic", underline: "underline", strike: "strikeThrough" }[type];
      if (command) {
        document.execCommand(command);
        return;
      }
      const existing = this.markedAncestor(range, type);
      if (existing) {
        this.unwrapNode(existing);
        return;
      }
      const span = document.createElement("span");
      span.className = Marks.classFor(type);
      try {
        range.surroundContents(span);
      } catch (e) {
        span.appendChild(range.extractContents());
        range.insertNode(span);
      }
    },

    /** The closest ancestor carrying mark `type`, if the selection sits in one. */
    markedAncestor(range, type) {
      let n = range.commonAncestorContainer;
      while (n && n !== document.body) {
        if (n.nodeType === 1 && (n.getAttribute("class") || "").includes(`m-${type}`)) return n;
        n = n.parentNode;
      }
      return null;
    },

    unwrapNode(node) {
      const parent = node.parentNode;
      if (!parent) return;
      while (node.firstChild) parent.insertBefore(node.firstChild, node);
      parent.removeChild(node);
    },

    /** Character offset of the caret inside an inline editor (0 = start of line). */
    caretOffset(el) {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return 0;
      const range = sel.getRangeAt(0);
      const pre = range.cloneRange();
      pre.selectNodeContents(el);
      pre.setEnd(range.endContainer, range.endOffset);
      return pre.toString().length;
    },

    /** Put the caret at `offset` inside an inline editor (marks-aware). */
    placeCaretAt(el, offset) {
      if (!el) return;
      const at = Math.max(0, offset || 0);
      // NTMarks walks the text nodes, so an offset still lands in the right place
      // when the line is split across mark spans; the fallback is plain text only.
      const Marks = window.NTMarks;
      if (Marks) { Marks.placeCaret(el, at); return; }
      const sel = window.getSelection();
      if (!sel) return;
      const text = el.textContent ?? "";
      const clamped = Math.max(0, Math.min(at, text.length));
      const range = document.createRange();
      const node = el.firstChild;
      if (node && node.nodeType === Node.TEXT_NODE) range.setStart(node, clamped);
      else range.selectNodeContents(el);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    },

    /**
     * Backspace inside an emptied renderer (code/math/mermaid/plantuml/d2) hands
     * the line back to plain text, the way Backspace on an empty block does in
     * every other editor — otherwise the caret has no line to land on.
     *
     * `opts.content` carries the text through the conversion: dropping a list
     * marker or a quote must keep the words, only an emptied renderer has nothing.
     */
    async convertBlockToParagraph(blockId, opts = {}) {
      const idx = this.blocks.findIndex((b) => b.id === blockId);
      if (idx < 0) return;
      const block = this.blocks[idx];
      const content = opts.content ?? { text: "", marks: [] };
      const updated = await this.api(`/objects/${block.objectId}/blocks/${block.id}`, {
        method: "PATCH",
        body: JSON.stringify({ type: "paragraph", content }),
      });
      this.destroyRenderedBlock(blockId);
      this.blocks[idx] = updated;
      this.invalidateRows();
      // A type change re-mounts the element (Alpine drops the old node), so the
      // text that survived the conversion is written back into the new one.
      this.$nextTick(() => {
        const el = document.querySelector(`.block[data-block-id="${updated.id}"] [contenteditable]`);
        if (el) {
          this.fillEditable(el, updated);
          el.isContentEditableDone = true;
        }
        setTimeout(() => this.focusBlock(updated.id, 2, "start"), 60);
      });
    },

    /**
     * Backspace at the start of a line merges into the previous block: the
     * current text is appended to it and the now-empty block is deleted.
     * Returns true when it consumed the keystroke.
     */
    async backspaceMergeBlock(block, el) {
      const idx = this.blocks.findIndex((b) => b.id === block.id);
      if (idx <= 0) return false; // first block: nothing above to merge into
      const prev = this.previousRow(block.id);
      if (!prev) return false;
      // Rendered blocks (code/math/mermaid/plantuml/d2) own their own editors: don't try
      // to splice their internals, a backspace there just drops the block.
      if (this.isRenderedBlock(block.type)) return false;
      const live = el?.textContent ?? block.content?.text ?? "";
      // A line with nested blocks cannot fold into the one above: deleting it
      // would take its subtree with it.
      if (this.blockHasChildren(block.id)) {
        this.showToast("This block has nested blocks — move them out first");
        return false;
      }
      // A renderer above has no text to merge into: an empty line still has to
      // give way (and hand the caret to that block), a non-empty one keeps its text.
      if (this.isRenderedBlock(prev.type)) {
        if (live.length) return false;
        await this.removeBlock(block);
        this.$nextTick(() => this.focusBlock(prev.id));
        return true;
      }
      // Both halves of a merge carry marks, so the join happens on the model.
      const head = this.liveInline(prev.id) ?? {
        text: prev.content?.text ?? "",
        marks: prev.content?.marks ?? [],
      };
      const merged = window.NTEntry
        ? window.NTEntry.joinInline(head, this.parseInline(el))
        : { text: (head.text ?? "") + live, marks: head.marks };

      // Merge into the previous block and delete this one in one round trip each.
      await this.saveBlockContent(prev, merged);
      await this.removeBlock(block);

      this.$nextTick(() => {
        // the merged text has to be in the DOM too, or the next blur-save writes
        // the shorter pre-merge line back over it
        const prevEl = this.syncBlockElement(prev.id, merged);
        if (prevEl) {
          prevEl.focus();
          this.placeCaretAt(prevEl, (merged.text ?? "").length); // caret where the two texts meet
        }
      });
      return true;
    },

    onBlockKeydown(block, evt) {
      if (this.slash.open && this.slash.blockId === block.id) {
        const options = this.slashOptions();
        if (evt.key === "ArrowDown") { evt.preventDefault(); this.slashMove(1); return; }
        if (evt.key === "ArrowUp") { evt.preventDefault(); this.slashMove(-1); return; }
        if (evt.key === "Escape") { evt.preventDefault(); this.closeSlash(); return; }
        if (evt.key === "Enter" || evt.key === "Tab") {
          evt.preventDefault();
          this.pickSlash(options[this.slash.index] ?? options[0]);
          return;
        }
        return;
      }
      if (evt.key === "Tab") {
        // nesting is a block operation, so the key never reaches the caret
        evt.preventDefault();
        if (evt.shiftKey) this.outdentBlock(block);
        else this.indentBlock(block);
        return;
      }
      const mod = evt.ctrlKey || evt.metaKey;
      if (mod && !evt.altKey) {
        const marked = { b: "bold", i: "italic", u: "underline" }[(evt.key || "").toLowerCase()];
        if (marked) {
          evt.preventDefault();
          this.applyMark(marked);
          return;
        }
      }
      if (evt.key === "Backspace") {
        const offset = this.caretOffset(evt.target);
        if (offset !== 0) return;
        // A list marker or a quote bar is formatting, not text: the first
        // Backspace at the start of such a line takes the marker away (an empty
        // item leaves the list outright), the next one merges the line upwards.
        if (window.NTEntry?.isListType(block.type) || block.type === "quote") {
          evt.preventDefault();
          this.convertBlockToParagraph(block.id, { content: this.parseInline(evt.target) });
          return;
        }
        evt.preventDefault();
        // At the start of a line: delete this block and merge its text into
        // the previous block, the way every other editor does.
        this.backspaceMergeBlock(block, evt.target);
        return;
      }
      // Delete at the end of a line pulls the next block up into this one.
      if (evt.key === "Delete") {
        if (this.mergeNextBlockInto(block, evt.target)) evt.preventDefault();
        return;
      }
      // Arrow up/down at the edge of a line walks the block tree, so a page reads
      // as one document instead of a stack of separate inputs.
      if (evt.key === "ArrowUp" || evt.key === "ArrowDown") {
        const delta = evt.key === "ArrowUp" ? -1 : 1;
        if (this.moveCaretAcrossBlocks(block, evt.target, delta)) evt.preventDefault();
        return;
      }
      if (evt.key !== "Enter") return;
      if (evt.isComposing || evt.shiftKey) return;
      evt.preventDefault();
      this.splitBlockOnEnter(block, evt.target);
    },

    /**
     * Enter means "put the rest of this line on the next one", not "append an
     * empty paragraph": the text after the caret moves into the new block, and
     * that block keeps the shape of the line it came from (a todo stays a todo,
     * a numbered item stays numbered). Two shapes take the simpler road:
     *
     *   - an empty list item or quote leaves the block (you typed your way out)
     *   - a block that owns children only opens a new line under its subtree; its
     *     text is left whole, because splitting it would cut the parent's sentence
     *     around its own children
     */
    async splitBlockOnEnter(block, el) {
      const Rules = window.NTEntry;
      if (!Rules || this.isRenderedBlock(block.type)) return;
      const live = this.parseInline(el);
      const action = Rules.enterAction(block, live.text, this.blockHasChildren(block.id));
      const next = Rules.enterContinue(block);
      if (action === "exit") {
        await this.convertBlockToParagraph(block.id, { content: { text: "", marks: [] } });
        return;
      }
      if (action === "insert") {
        await this.addBlockAfter(next.type, block, next.content, { caret: "start" });
        return;
      }
      const { head, tail } = Rules.splitAt(live.text, live.marks, this.caretOffset(el));
      // A plain Enter at the end of a line changes nothing above it, so that save
      // is skipped and only the new line travels to the server.
      if (head.text !== live.text) {
        await this.saveBlockContent(block, head);
        this.syncBlockElement(block.id, head);
      }
      await this.addBlockAfter(next.type, block, { ...next.content, ...tail }, { caret: "start" });
    },

    /**
     * Delete at the end of a line: the next block's text is appended here and
     * that block goes away (with its undo entry). Rendered neighbours and a
     * block that has children are left alone — their content cannot be spliced.
     */
    async mergeNextBlockInto(block, el) {
      const Rules = window.NTEntry;
      if (!Rules || this.isRenderedBlock(block.type)) return false;
      if (this.caretOffset(el) !== (el?.textContent ?? "").length) return false;
      const next = this.nextRow(block.id);
      if (!next || this.isRenderedBlock(next.type)) return false;
      if (this.blockHasChildren(next.id)) return false;
      const head = this.parseInline(el);
      const merged = Rules.joinInline(head, {
        text: next.content?.text ?? "",
        marks: next.content?.marks ?? [],
      });
      await this.saveBlockContent(block, merged);
      await this.removeBlock(next);
      this.$nextTick(() => {
        const target = this.syncBlockElement(block.id, merged);
        if (!target) return;
        target.focus();
        this.placeCaretAt(target, head.text.length);
      });
      return true;
    },

    /**
     * Arrow up/down at the edge of a line moves to the neighbour block in the
     * visual order (blockRows, so nesting counts). Returns true when it took the
     * keystroke; inside a line the browser keeps it.
     */
    moveCaretAcrossBlocks(block, el, delta) {
      if (!el || !delta || this.isRenderedBlock(block.type)) return false;
      const offset = this.caretOffset(el);
      const length = (el.textContent ?? "").length;
      if (delta < 0 && offset !== 0) return false;
      if (delta > 0 && offset !== length) return false;
      const target = delta < 0 ? this.previousRow(block.id) : this.nextRow(block.id);
      if (!target) return false;
      this.focusBlockEdge(target.id, delta < 0 ? "end" : "start");
      return true;
    },

    // ---------- paste: a line of text or a clipboard full of blocks ----------
    /**
     * Paste into a text block. A single line is inserted as text at the caret
     * (never as the clipboard's HTML), while a multi-line or markdown clipboard
     * becomes real blocks — the same ones the "New object" form would build from
     * the same text. Shift+paste keeps the browser's own behaviour.
     */
    onBlockPaste(block, evt) {
      const Rules = window.NTEntry;
      const data = evt.clipboardData;
      if (!Rules || !data || evt.shiftKey) return;
      const text = data.getData("text/plain");
      if (!text) return; // images and files are not this editor's business yet
      evt.preventDefault();
      if (!Rules.pasteHasBlocks(text)) {
        // insertText replaces the selection and leaves the caret, like typing
        document.execCommand("insertText", false, text);
        this.queueBlockSave(block.id, this.parseInline(evt.target));
        return;
      }
      this.pasteBlocks(block, evt.target, text);
    },

    /**
     * A clipboard of blocks: the line splits at the caret, the pasted blocks land
     * in the gap, and the text that followed the caret keeps its own line below.
     * Pasting onto an empty line converts that line instead, so no stray empty
     * paragraph is left above the paste.
     */
    async pasteBlocks(block, el, raw) {
      const Rules = window.NTEntry;
      const payloads = this.parseContentToBlocks(raw);
      if (!payloads.length) return;
      // A selection is replaced by the paste: drop it, then read the caret.
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && el.contains(sel.anchorNode)) document.execCommand("delete");
      const live = this.parseInline(el);
      const { head, tail } = Rules.splitAt(live.text, live.marks, this.caretOffset(el));
      const touched = [];
      let ref = block;
      const takesOverLine = !live.text.length;
      if (takesOverLine) {
        const first = payloads.shift();
        const updated = await this.saveBlockContent(block, first.content, first.type);
        ref = updated;
        touched.push(updated);
      } else if (head.text !== live.text) {
        await this.saveBlockContent(block, head);
        const synced = this.syncBlockElement(block.id, head) ?? el;
        this.placeCaretAt(synced, head.text.length);
      }
      for (const payload of payloads) {
        ref = await this.addBlockAfter(payload.type, ref, payload.content, { focus: false, reload: false });
        touched.push(ref);
      }
      // Whatever stood after the caret keeps its own line, below the paste.
      let tailBlock = null;
      if (tail.text.length) {
        const shape = Rules.enterContinue(block);
        tailBlock = await this.addBlockAfter(shape.type, ref, { ...shape.content, ...tail }, {
          focus: false,
          reload: false,
        });
      }
      await this.reloadBlocks();
      this.$nextTick(() => {
        // the caret ends where a typed paste would leave it: after the content
        const last = touched[touched.length - 1];
        if (tailBlock) this.focusBlockEdge(tailBlock.id, "start");
        else if (last) this.focusBlockEdge(last.id, "end");
      });
      const count = touched.length + (tailBlock ? 1 : 0);
      this.showToast(`Pasted ${count} block${count === 1 ? "" : "s"}`);
    },

    /**
     * Titles and descriptions are plain text: paste them as one line rather than
     * letting the clipboard's HTML into the element.
     */
    onPlainPaste(evt) {
      const text = evt.clipboardData?.getData("text/plain");
      if (text == null) return;
      evt.preventDefault();
      document.execCommand("insertText", false, text.replace(/\s*\n\s*/g, " "));
    },
    async saveBlockContent(block, extra = {}, type) {
      const before = { type: block.type, content: block.content };
      const content = { ...block.content, ...extra };
      const payload = type ? { content, type } : { content };
      const updated = await this.api(`/objects/${block.objectId}/blocks/${block.id}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      const idx = this.blocks.findIndex((b) => b.id === block.id);
      if (idx >= 0) this.blocks[idx] = updated;
      this.invalidateRows();
      // one undo step per edit burst: typing coalesces, a type change never does
      this.pushUndo({
        label: type ? "block change" : "edit",
        coalesceKey: type ? null : `content:${block.id}`,
        undo: () => this.restoreBlock(block.id, before),
        redo: () => this.restoreBlock(block.id, { type: updated.type, content: updated.content }),
      });
      return updated;
    },

    /** Put a block back to a previous `{ type, content }` and re-render it. */
    async restoreBlock(blockId, snapshot) {
      const live = this.blocks.find((b) => b.id === blockId);
      if (!live) return;
      const updated = await this.api(`/objects/${live.objectId}/blocks/${blockId}`, {
        method: "PATCH",
        body: JSON.stringify({ type: snapshot.type, content: snapshot.content }),
      });
      const idx = this.blocks.findIndex((b) => b.id === blockId);
      if (idx >= 0) this.blocks[idx] = updated;
      this.invalidateRows();
      this.$nextTick(() => {
        const el = document.querySelector(`.block[data-block-id="${blockId}"] [contenteditable]`);
        if (el) {
          this.fillEditable(el, updated);
          el.isContentEditableDone = true;
        }
      });
    },

    // ---------- undo / redo (in-memory op stack, architect.md §46) ----------
    canUndo() {
      return this.undoStack.length > 0;
    },

    canRedo() {
      return this.redoStack.length > 0;
    },

    /**
     * Record a finished mutation with the operations that reverse and replay it.
     * Consecutive edits of the same block collapse into one step while the user
     * keeps typing, so Ctrl+Z does not undo a letter at a time.
     */
    pushUndo(entry) {
      const last = this.undoStack[this.undoStack.length - 1];
      if (entry.coalesceKey && last && last.coalesceKey === entry.coalesceKey && Date.now() - last.at < 1500) {
        last.redo = entry.redo;
        last.label = entry.label;
        last.at = Date.now();
        this.redoStack = [];
        return;
      }
      this.undoStack.push({ ...entry, at: Date.now() });
      if (this.undoStack.length > 100) this.undoStack.shift();
      this.redoStack = [];
    },

    async undo() {
      const entry = this.undoStack.pop();
      if (!entry) {
        this.showToast("Nothing to undo");
        return;
      }
      await entry.undo();
      this.redoStack.push(entry);
      this.showToast(`Undo ${entry.label}`);
    },

    async redo() {
      const entry = this.redoStack.pop();
      if (!entry) {
        this.showToast("Nothing to redo");
        return;
      }
      await entry.redo();
      this.undoStack.push({ ...entry, at: Date.now() });
      this.showToast(`Redo ${entry.label}`);
    },

    async saveBlock(block, text, extra = {}) {
      if (text !== undefined) extra = { ...extra, text };
      await this.saveBlockContent(block, extra);
    },

    // ---------- external assets (local vendor first, CDN as fallback) ----------
    katexVersion: "0.18.7",
    mermaidVersion: "10.9.8",
    cmVersion: "5.65.16",
    minified(rel) {
      return rel.replace(/\.(js|css)$/, ".min.$1");
    },
    cmAsset(rel) {
      return [
        `/vendor/codemirror/${rel}`,
        `https://cdn.jsdelivr.net/npm/codemirror@${this.cmVersion}/${this.minified(rel)}`,
      ];
    },
    /** "nt" is the app's own CodeMirror colorscheme (app.css .cm-s-nt): it follows
     *  the --code-* palette vars, so one theme serves light and dark, and a
     *  per-snippet override only re-points those vars. */
    cmTheme() {
      return "nt";
    },
    katexAsset(rel) {
      return [
        `/vendor/katex/${rel}`,
        `https://cdn.jsdelivr.net/npm/katex@${this.katexVersion}/dist/${rel}`,
      ];
    },
    mermaidAsset(rel) {
      return [
        `/vendor/mermaid/${rel}`,
        `https://cdn.jsdelivr.net/npm/mermaid@${this.mermaidVersion}/dist/${rel}`,
      ];
    },
    d2Version: "0.1.33",
    d2Asset(rel) {
      return [
        `/vendor/d2/${rel}`,
        `https://cdn.jsdelivr.net/npm/@terrastruct/d2@${this.d2Version}/dist/browser/${rel}`,
      ];
    },
    tldrawVersion: "5.4.2",
    /** Self-contained ESM bundle (react + tldraw bundled together, see scripts/build-tldraw-vendor.mjs). */
    tldrawModuleAsset() {
      return [
        `/vendor/tldraw/tldraw-${this.tldrawVersion}.mjs`,
        `https://esm.sh/tldraw@${this.tldrawVersion}`,
      ];
    },
    tldrawCssAsset() {
      return [
        "/vendor/tldraw/tldraw.css",
        `https://cdn.jsdelivr.net/npm/tldraw@${this.tldrawVersion}/tldraw.css`,
      ];
    },

    loadScript(src) {
      if (this.loadedAssets.has(src)) return Promise.resolve();
      if (this.failedAssets.has(src)) return Promise.reject(new Error("Asset previously failed: " + src));
      const existing = document.querySelector(`script[src="${src}"], link[href="${src}"]`);
      if (existing) {
        return existing.dataset.loaded === "1"
          ? Promise.resolve()
          : new Promise((res, rej) => {
              existing.addEventListener("load", res);
              existing.addEventListener("error", rej);
            });
      }
      const el = src.endsWith(".css")
        ? Object.assign(document.createElement("link"), { rel: "stylesheet", href: src })
        : Object.assign(document.createElement("script"), { src: src, async: true });
      return new Promise((res, rej) => {
        el.addEventListener("load", () => { el.dataset.loaded = "1"; res(); });
        el.addEventListener("error", () => {
          el.remove();
          this.failedAssets.add(src);
          rej(new Error("Failed to load " + src));
        });
        document.head.appendChild(el);
      });
    },

    /** Try each candidate URL (local vendor, then CDN) and remember what worked. */
    async loadAsset(candidates) {
      const list = Array.isArray(candidates) ? candidates : [candidates];
      let lastError = null;
      for (const url of list) {
        try {
          await this.loadScript(url);
          this.loadedAssets.add(url);
          return url;
        } catch (e) {
          lastError = e;
        }
      }
      throw lastError ?? new Error("No asset candidate loaded");
    },

    /** Serialize asset loading and keep the chain alive even when a load fails. */
    queueAssetLoad(fn) {
      const next = this.assetLoadChain.then(fn);
      this.assetLoadChain = next.then(() => undefined, () => undefined);
      return next;
    },

    /**
     * ESM counterpart of loadAsset: dynamic import() with a vendor-first,
     * CDN-fallback candidate list (used for the D2 WASM bundle).
     */
    async loadModule(candidates) {
      const list = Array.isArray(candidates) ? candidates : [candidates];
      let lastError = null;
      for (const url of list) {
        try {
          const mod = await import(url);
          this.loadedAssets.add(url);
          return mod;
        } catch (e) {
          this.failedAssets.add(url);
          lastError = e;
        }
      }
      throw lastError ?? new Error("No module candidate loaded");
    },

    /** Lazily create the one shared D2 engine (WASM-backed, worker driven). */
    async ensureD2() {
      if (this.d2Instance) return this.d2Instance;
      if (!this.d2Promise) {
        this.d2Promise = this.loadModule(this.d2Asset("index.js")).then((mod) => {
          const D2 = mod?.D2;
          if (typeof D2 !== "function") throw new Error("D2 module unavailable");
          return new D2();
        });
        this.d2Promise.catch(() => { this.d2Promise = null; }); // allow a retry after a failed load
      }
      this.d2Instance = await this.d2Promise;
      return this.d2Instance;
    },

    /**
     * Lazily load the tldraw whiteboard bundle. The vendor bundle re-exports
     * react/react-dom internals; the esm.sh fallback does not, so mount
     * helpers are fetched separately in that case. Cached at module scope so
     * Alpine never wraps the module namespace in a reactivity proxy.
     */
    async ensureTldraw() {
      if (tldrawModule) return tldrawModule;
      if (!tldrawModulePromise) {
        tldrawModulePromise = (async () => {
          await this.loadAsset(this.tldrawCssAsset());
          const mod = await this.loadModule(this.tldrawModuleAsset());
          let TL = mod;
          if (typeof mod?.Tldraw === "function" && (typeof mod.createElement !== "function" || typeof mod.createRoot !== "function")) {
            const [React, ReactDOM] = await Promise.all([
              this.loadModule(`https://esm.sh/react@19.2.1`),
              this.loadModule(`https://esm.sh/react-dom@19.2.1/client`),
            ]);
            if (typeof React.createElement !== "function" || typeof ReactDOM.createRoot !== "function") {
              throw new Error("React unavailable for tldraw");
            }
            TL = { ...mod, createElement: React.createElement, Fragment: React.Fragment, createRoot: ReactDOM.createRoot };
          }
          if (typeof TL.Tldraw !== "function" || typeof TL.createElement !== "function" || typeof TL.createRoot !== "function") {
            throw new Error("tldraw module unavailable");
          }
          return TL;
        })();
        tldrawModulePromise.catch(() => { tldrawModulePromise = null; }); // allow a retry after a failed load
      }
      tldrawModule = await tldrawModulePromise;
      return tldrawModule;
    },

    // ---------- renderer registry: block.type -> mounted renderer ----------
    mountBlockRenderer(host, block) {
      const spec = this.rendererSpecs[block.type];
      if (!spec) {
        host.textContent = `No renderer for block type "${block.type}"`;
        return;
      }
      const existing = this.rendererState.get(block.id);
      if (existing) {
        if (existing.container === host && host.isConnected) return;
        this.destroyRenderedBlock(block.id); // DOM was rebuilt elsewhere: mount fresh
      }
      if (this.renderedPending.has(block.id)) return;
      this.renderedPending.add(block.id);
      const mount = spec.editor === "codemirror"
        ? this.mountCodeRenderer
        : spec.editor === "whiteboard" ? this.mountWhiteboardRenderer : this.mountPreviewRenderer;
      Promise.resolve(mount.call(this, host, block, spec)).finally(() => this.renderedPending.delete(block.id));
    },

    setRenderStatus(host, text, kind) {
      // renderer wrappers (.b-math / .b-code / .b-mermaid) live inside `host`;
      // the status line must sit inside the wrapper it describes
      const root = host.querySelector(".b-math, .b-code, .b-mermaid, .b-plantuml, .b-d2") || host;
      let el = root.querySelector(".render-status");
      if (!text) {
        if (el) el.remove();
        return;
      }
      if (!el) {
        el = document.createElement("div");
        el.className = "render-status";
        root.appendChild(el);
      }
      el.textContent = text;
      el.dataset.kind = kind || "info";
    },

    mountCodeRenderer(host, block, spec) {
      const language = this.normalizeCodeLang(block.content?.language);
      host.textContent = "";
      const wrap = document.createElement("div");
      wrap.className = "b-code";
      // Per-snippet colorscheme ("auto" = follow the app theme; else pin light/dark)
      wrap.dataset.snippetTheme = block.content?.snippetTheme || "";
      const toolbar = document.createElement("div");
      toolbar.className = "code-toolbar";
      const select = document.createElement("select");
      select.className = "code-lang";
      for (const lang of this.codeLanguages) {
        const opt = document.createElement("option");
        opt.value = lang;
        opt.textContent = lang;
        if (lang === language) opt.selected = true;
        select.appendChild(opt);
      }
      select.addEventListener("change", () => this.changeCodeLanguage(block, select.value));
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "code-copy";
      copy.textContent = "Copy";
      copy.addEventListener("click", (evt) => this.copyBlockSource(block, evt));
      // Code folding gutter + find/replace + word completion (architect.md #23)
      const themeBtn = document.createElement("button");
      themeBtn.type = "button";
      themeBtn.className = "code-copy code-theme";
      themeBtn.textContent = "Aa";
      themeBtn.title = "Code colors: follow theme";
      themeBtn.addEventListener("click", () => this.cycleSnippetTheme(block, themeBtn));
      const fold = document.createElement("button");
      fold.type = "button";
      fold.className = "code-copy";
      fold.textContent = "Fold";
      fold.title = "Fold / unfold all code blocks";
      fold.addEventListener("click", () => this.toggleCodeFolding(block.id));
      toolbar.append(select, themeBtn, fold, copy);
      const editorHost = document.createElement("div");
      editorHost.className = "code-editor-host";
      wrap.append(toolbar, editorHost);
      host.appendChild(wrap);
      this.rendererState.set(block.id, { blockId: block.id, container: host, wrapper: wrap, cm: null, textarea: null, spec });
      this.setRenderStatus(host, "Loading editor…", "info");

      // Enter outside the editor (toolbar, block chrome) continues below the block.
      wrap.addEventListener("keydown", (evt) => {
        if (evt.key !== "Enter" || evt.shiftKey || evt.target.closest(".CodeMirror")) return;
        evt.preventDefault();
        this.addBlockAfter("paragraph", this.liveBlock(block.id) ?? block);
      });

      this.queueAssetLoad(async () => {
        try {
          const mode = await this.ensureCmMode(language);
          if (!editorHost.isConnected) return;
          if (typeof window.CodeMirror !== "function") throw new Error("CodeMirror unavailable");
          const cm = window.CodeMirror(editorHost, {
            value: block.content?.code ?? "",
            theme: this.cmTheme(),
            // Without an explicit mode the editor falls back to whatever mode
            // happened to load, which is why snippets lost their colours.
            mode: mode ?? null,
            lineNumbers: true,
            matchBrackets: true,
            autoCloseBrackets: true,
            styleActiveLine: true,
            // indentation: 2 spaces, never tabs (#23: indentation)
            indentUnit: 2,
            tabSize: 2,
            smartIndent: true,
            // find/replace, folding and word completion are addon-driven (#23)
            gutters: ["CodeMirror-linenumbers", "CodeMirror-foldgutter"],
            extraKeys: {
              "Shift-Enter": () => {},
              // Inside the editor Enter is a code line; this is the way out.
              "Ctrl-Enter": () => this.addBlockAfter("paragraph", this.liveBlock(block.id) ?? block),
              "Cmd-Enter": () => this.addBlockAfter("paragraph", this.liveBlock(block.id) ?? block),
              "Ctrl-F": "findPersistent",
              "Cmd-F": "findPersistent",
              "Ctrl-G": "findNext",
              "Cmd-G": "findNext",
              "Shift-Ctrl-G": "findPrev",
              "Shift-Cmd-G": "findPrev",
              // Show the completion menu; a sole match must still be offered, not
              // silently inserted (otherwise Ctrl+Space looks like a no-op).
              "Ctrl-Space": () => this.openCompletion(cm),
              "Cmd-Space": () => this.openCompletion(cm),
              "Ctrl-[": "foldLess",
              "Ctrl-]": "foldMore",
              "Ctrl-/": "toggleComment",
              "Cmd-/": "toggleComment",
              "Shift-Tab": "indentLess",
              Tab: (cm) => cm.execCommand("insertSoftTab"),
            },
          });
          cm.on("change", () => this.queueBlockSave(block.id, { code: cm.getValue(), language }));
          // Backspace in an empty code block steps back to a plain text line
          // instead of leaving an editor the caret cannot leave downwards.
          cm.on("keydown", (instance, evt) => {
            if (evt.key === "Backspace" && instance.getValue() === "") {
              evt.preventDefault();
              this.convertBlockToParagraph(block.id);
            }
          });
          const state = this.rendererState.get(block.id);
          if (state) state.cm = cm;
          this.setRenderStatus(host, null);
          requestAnimationFrame(() => requestAnimationFrame(() => cm.refresh()));
        } catch (e) {
          if (!editorHost.isConnected) return;
          this.mountCodeFallback(host, editorHost, block, language);
        }
      });
    },

    /**
     * Open the completion menu on Ctrl/Cmd+Space.
     *
     * The stock `autocomplete` command is a dead end for user identifiers:
     * javascript-hint is the registered hint for JS mode, it only knows language
     * keywords, so it returns an empty list for `fizz` (a word *this document*
     * defines) and the auto resolver then stops instead of falling back to
     * anyword completion. Merge both sources and always offer, never auto-pick.
     */
    openCompletion(cm) {
      const CM = window.CodeMirror;
      if (!CM?.hint?.anyword) return;
      cm.showHint({
        completeSingle: false,
        hint: (editor) => this.mergeHints(editor, CM),
      });
    },

    /** Keywords from the language plus every word already in the document. */
    mergeHints(editor, CM) {
      const pos = editor.getCursor();
      const anyword = CM.hint.anyword(editor, {});
      const js = CM.hint.javascript ? CM.hint.javascript(editor, {}) : null;
      const seen = new Set();
      const list = [];
      const add = (word) => {
        if (word && !seen.has(word)) {
          seen.add(word);
          list.push(word);
        }
      };
      (js?.list ?? []).forEach(add);
      (anyword?.list ?? []).forEach(add);
      return { list, from: anyword?.from ?? js?.from, to: anyword?.to ?? js?.to };
    },

    /** Plain-textarea fallback so a code block stays editable even without the editor library. */
    mountCodeFallback(host, editorHost, block, language) {
      editorHost.textContent = "";
      const ta = document.createElement("textarea");
      ta.className = "code-area";
      ta.spellcheck = false;
      ta.setAttribute("wrap", "off");
      ta.value = block.content?.code ?? "";
      ta.addEventListener("input", () => {
        this.autoGrowEl(ta);
        this.queueBlockSave(block.id, { code: ta.value, language });
      });
      editorHost.appendChild(ta);
      this.autoGrowEl(ta);
      const state = this.rendererState.get(block.id);
      if (state) state.textarea = ta;
      this.setRenderStatus(host, "Rich editor unavailable — plain text mode", "warn");
    },

    /**
     * Fold / unfold every foldable range in a code block. The fold gutter is always
     * visible; this button is a whole-block shortcut for scanning long snippets.
     */
    toggleCodeFolding(blockId) {
      const state = this.rendererState.get(blockId);
      const cm = state?.cm;
      if (!cm) return;
      const folding = !this.codeFolded.has(blockId);
      cm.execCommand(folding ? "foldAll" : "unfoldAll");
      if (folding) this.codeFolded.add(blockId);
      else this.codeFolded.delete(blockId);
    },

    /**
     * Cycle one snippet's colorscheme: auto (follow the app theme) → dark →
     * light → auto. The choice lives in the block content (`snippetTheme`) —
     * same save path as code/language, so undo/redo, theme switches and reloads
     * all keep it — and applying it is just re-pointing the wrapper's
     * data-snippet-theme attribute (the -nt colorscheme reads CSS vars).
     */
    cycleSnippetTheme(block, btn) {
      const live = this.liveBlock(block.id) ?? block;
      const current = live.content?.snippetTheme || "auto";
      const next = current === "auto" ? "dark" : current === "dark" ? "light" : "auto";
      const label = { auto: "follow theme", light: "light", dark: "dark" }[next];
      this.saveBlockContent(live, { snippetTheme: next })
        .then((updated) => {
          const state = this.rendererState.get(live.id);
          if (state?.wrapper) state.wrapper.dataset.snippetTheme = next === "auto" ? "" : next;
          if (btn) btn.title = `Code colors: ${label}`;
          this.showToast(`Code colors: ${label}`);
        })
        .catch(() => this.showToast("Could not save code colors"));
    },

    async ensureCmMode(lang) {
      const key = this.normalizeCodeLang(lang);
      const assets = [
        "lib/codemirror.css",
        "lib/codemirror.js",
        "addon/edit/closebrackets.js",
        "addon/edit/matchbrackets.js",
        "addon/edit/closetag.js",
        "addon/edit/trailingspace.js",
        "addon/selection/active-line.js",
        "addon/selection/mark-selection.js",
        // find/replace (#23: search)
        "addon/search/searchcursor.js",
        "addon/search/search.js",
        "addon/search/jump-to-line.js",
        "addon/dialog/dialog.js",
        "addon/dialog/dialog.css",
        // folding (#23: folding)
        "addon/fold/foldcode.js",
        "addon/fold/foldgutter.js",
        "addon/fold/foldgutter.css",
        "addon/fold/brace-fold.js",
        "addon/fold/indent-fold.js",
        "addon/fold/comment-fold.js",
        "addon/fold/markdown-fold.js",
        "addon/fold/xml-fold.js",
        // completion (#23: autocomplete)
        "addon/hint/show-hint.js",
        "addon/hint/show-hint.css",
        "addon/hint/anyword-hint.js",
        "addon/hint/javascript-hint.js",
        // comment toggling (Ctrl-/)
        "addon/comment/comment.js",
        "mode/meta.js",
      ];
      const modeAssets = {
        javascript: ["mode/javascript/javascript.js"],
        typescript: ["mode/javascript/javascript.js"],
        json: ["mode/javascript/javascript.js"],
        python: ["mode/python/python.js"],
        rust: ["mode/rust/rust.js"],
        go: ["mode/go/go.js"],
        sql: ["mode/sql/sql.js"],
        html: ["mode/xml/xml.js", "mode/javascript/javascript.js", "mode/css/css.js", "mode/htmlmixed/htmlmixed.js"],
        css: ["mode/css/css.js"],
        markdown: ["mode/markdown/markdown.js"],
        yaml: ["mode/yaml/yaml.js"],
        bash: ["mode/shell/shell.js"],
        java: ["mode/clike/clike.js"],
        c: ["mode/clike/clike.js"],
        cpp: ["mode/clike/clike.js"],
        csharp: ["mode/clike/clike.js"],
        mermaid: ["mode/markdown/markdown.js"],
      };
      const modeSpec = {
        plaintext: null,
        javascript: "javascript",
        typescript: { name: "javascript", typescript: true },
        json: { name: "javascript", json: true },
        python: "python",
        rust: "rust",
        go: "go",
        sql: "sql",
        html: "htmlmixed",
        css: "css",
        markdown: "markdown",
        yaml: "yaml",
        bash: "shell",
        java: "text/x-java",
        c: "text/x-csrc",
        cpp: "text/x-c++src",
        csharp: "text/x-csharp",
        mermaid: "markdown",
      };
      const all = assets.concat(modeAssets[key] ?? []);
      for (const rel of all) {
        await this.loadAsset(this.cmAsset(rel));
      }
      return modeSpec[key] ?? null;
    },

    // ---------- preview renderers (KaTeX, Mermaid, PlantUML, D2) ----------
    /** Wrapper CSS class per rendered block type. */
    previewClassFor(type) {
      if (type === "math") return "b-math";
      if (type === "plantuml") return "b-plantuml";
      if (type === "d2") return "b-d2";
      return "b-mermaid";
    },
    /** Human label used in the empty/error status lines. */
    previewLabelFor(type) {
      return { math: "LaTeX", mermaid: "Mermaid", plantuml: "PlantUML", d2: "D2" }[type] || type;
    },
    async mountPreviewRenderer(host, block, spec) {
      host.textContent = "";
      const wrap = document.createElement("div");
      wrap.className = block.type === "math" ? (block.content?.display === false ? "b-math inline-math" : "b-math") : this.previewClassFor(block.type);
      const toolbar = document.createElement("div");
      toolbar.className = "code-toolbar";
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "code-copy";
      toggle.textContent = "Edit";
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "code-copy";
      copy.textContent = "Copy";
      copy.addEventListener("click", (evt) => this.copyBlockSource(block, evt));
      toolbar.append(toggle, copy);
      // LaTeX blocks also offer inline (text-style) vs display (block-style) rendering.
      if (block.type === "math") {
        const mode = document.createElement("button");
        mode.type = "button";
        mode.className = "code-copy math-mode";
        mode.title = "Switch between display (block) and inline (text) math";
        mode.textContent = block.content?.display === false ? "Inline" : "Display";
        mode.addEventListener("click", () => this.toggleMathDisplay(block.id, mode, host, body, spec, ta));
        toolbar.append(mode);
      }
      const body = document.createElement("div");
      body.className = "render-body";
      const ta = document.createElement("textarea");
      ta.className = "render-source code-area";
      ta.spellcheck = false;
      ta.hidden = true;
      ta.placeholder = spec.placeholder || "";
      ta.value = block.content?.[spec.sourceKey] ?? "";
      wrap.append(toolbar, body, ta);
      host.appendChild(wrap);
      this.rendererState.set(block.id, { blockId: block.id, container: host, wrapper: wrap, cm: null, textarea: ta, toggleBtn: toggle, spec });

      // A diagram owns its own editor, so the block itself is focusable: Enter
      // then opens a text line underneath instead of trapping the caret.
      wrap.tabIndex = 0;
      wrap.title = "Enter for a new line below · click Edit to change the source";
      wrap.addEventListener("mousedown", (evt) => {
        if (evt.target.closest("button, textarea, select, input")) return;
        wrap.focus({ preventScroll: true });
      });
      wrap.addEventListener("keydown", (evt) => {
        if (evt.key !== "Enter" || evt.target !== wrap || evt.shiftKey) return;
        evt.preventDefault();
        this.addBlockAfter("paragraph", this.liveBlock(block.id) ?? block);
      });

      toggle.addEventListener("click", () => {
        ta.hidden = !ta.hidden;
        toggle.textContent = ta.hidden ? "Edit" : "Done";
        if (ta.hidden) {
          // the pending debounced save would otherwise race the re-render and
          // leave the database holding the pre-edit source
          this.patchBlockNow(block.id, this.patchFor(block, spec, ta.value));
          this.renderPreview(host, body, block, spec, ta.value);
        } else {
          this.setRenderStatus(host, null); // stop showing "empty"/"error" while typing
          this.autoGrowEl(ta);
          ta.focus();
        }
      });
      ta.addEventListener("input", () => {
        this.autoGrowEl(ta);
        this.setRenderStatus(host, null);
        this.queueBlockSave(block.id, this.patchFor(block, spec, ta.value));
      });
      ta.addEventListener("blur", () => {
        if (!ta.hidden) this.renderPreview(host, body, block, spec, ta.value);
      });
      // Backspace on an empty source turns the diagram/math block back into a
      // text line, so a keyboard user is never trapped inside a renderer.
      ta.addEventListener("keydown", (evt) => {
        if (evt.key === "Backspace" && ta.value === "") {
          evt.preventDefault();
          this.convertBlockToParagraph(block.id);
          return;
        }
        // Ctrl/Cmd+Enter closes the source and continues on a line below the block.
        if (evt.key === "Enter" && (evt.ctrlKey || evt.metaKey)) {
          evt.preventDefault();
          ta.hidden = true;
          toggle.textContent = "Edit";
          this.patchBlockNow(block.id, this.patchFor(block, spec, ta.value));
          this.renderPreview(host, body, block, spec, ta.value);
          this.addBlockAfter("paragraph", this.liveBlock(block.id) ?? block);
        }
      });
      await this.renderPreview(host, body, block, spec, ta.value);
    },

    /** Flip a LaTeX block between display (centred block) and inline (text-style) math. */
    async toggleMathDisplay(blockId, button, host, body, spec, ta) {
      // Read the live block: mountPreviewRenderer's closure holds a stale copy once
      // saveBlockContent swaps the entry in this.blocks.
      const block = this.blocks.find((b) => b.id === blockId) ?? { content: {} };
      const display = block.content?.display === false;
      const updated = await this.saveBlockContent(block, { display });
      button.textContent = display ? "Display" : "Inline";
      const wrap = host.querySelector(".b-math");
      if (wrap) wrap.classList.toggle("inline-math", !display);
      await this.renderPreview(host, body, updated ?? block, spec, ta.value);
    },

    async renderPreview(host, body, block, spec, source) {
      const text = block.type === "math" ? this.normalizeTex(source) : (source ?? "").trim();
      const label = this.previewLabelFor(block.type);
      if (!text) {
        body.textContent = "";
        this.setRenderStatus(host, `Empty ${label} block — click Edit to write it`, "info");
        return;
      }
      this.setRenderStatus(host, "Rendering…", "info");
      try {
        if (block.type === "math") {
          await this.loadAsset(this.katexAsset("katex.min.css"));
          await this.loadAsset(this.katexAsset("katex.min.js"));
          if (!window.katex) throw new Error("KaTeX unavailable");
          const scratch = document.createElement("div");
          window.katex.render(text, scratch, {
            throwOnError: false,
            errorColor: "#e5484d",
            displayMode: block.content?.display !== false,
            output: "html",
            trust: false,
          });
          body.textContent = "";
          body.appendChild(this.sanitizeNode(scratch));
        } else if (block.type === "plantuml") {
          await this.renderPlantUmlInto(body, text);
        } else if (block.type === "d2") {
          await this.renderD2Into(body, text);
        } else {
          await this.loadAsset(this.mermaidAsset("mermaid.min.js"));
          if (!window.mermaid) throw new Error("Mermaid unavailable");
          if (!this.mermaidReady) {
            window.mermaid.initialize({
              startOnLoad: false,
              securityLevel: "strict",
              theme: this.theme === "dark" ? "dark" : "default",
              fontFamily: "inherit",
              // SVG labels instead of foreignObject HTML: keeps the sanitizer allowlist tight.
              flowchart: { htmlLabels: false },
              class: { htmlLabels: false },
            });
            this.mermaidReady = true;
          }
          const out = await window.mermaid.render(`mmd-${Math.random().toString(36).slice(2)}`, text);
          const svg = out && out.svg ? out.svg : String(out);
          const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
          if (parsed.querySelector("parsererror")) throw new Error("invalid diagram markup");
          const clean = this.sanitizeElement(parsed.documentElement);
          if (!clean.childNodes.length) throw new Error("diagram produced no drawable content");
          body.textContent = "";
          body.appendChild(clean);
        }
        this.setRenderStatus(host, null);
      } catch (e) {
        body.textContent = "";
        this.setRenderStatus(host, `${label} error: ${e?.message || e}`, "error");
      }
    },

    // ---------- PlantUML ----------
    /**
     * PlantUML has no small browser build, so diagrams render through the
     * PlantUML server (kroki.io mirrors the same protocol as a fallback).
     * Payloads travel as an image URL in the "hex" format (~h + UTF-8 hex).
     */
    plantumlEncodeHex(text) {
      let hex = "";
      for (const b of new TextEncoder().encode(text)) hex += b.toString(16).padStart(2, "0");
      return hex;
    },
    plantumlImageUrls(text) {
      const hex = this.plantumlEncodeHex(text);
      return [
        `https://www.plantuml.com/plantuml/svg/~h${hex}`,
        `https://kroki.io/plantuml/svg/~h${hex}`,
      ];
    },
    renderPlantUmlInto(body, text) {
      return new Promise((resolve, reject) => {
        const urls = this.plantumlImageUrls(text);
        const img = document.createElement("img");
        img.alt = "PlantUML diagram";
        img.style.maxWidth = "100%";
        let i = 0;
        img.addEventListener("load", () => {
          body.textContent = "";
          body.appendChild(img);
          resolve();
        });
        img.addEventListener("error", () => {
          i++;
          if (i < urls.length) { img.src = urls[i]; return; }
          reject(new Error("diagram service unreachable"));
        });
        img.src = urls[0];
      });
    },

    // ---------- D2 ----------
    /**
     * D2 renders fully client-side via the official WASM bundle
     * (@terrastruct/d2). Compile/render work is serialized through one chain
     * because the shared engine owns a single worker.
     */
    renderD2Into(body, text) {
      const run = async () => {
        const d2 = await this.ensureD2();
        const result = await d2.compile(text);
        return d2.render(result.diagram, result.renderOptions);
      };
      const next = this.d2WorkChain.then(run);
      this.d2WorkChain = next.then(() => undefined, () => undefined);
      return next.then((svg) => {
        const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
        if (parsed.querySelector("parsererror")) throw new Error("invalid diagram markup");
        const clean = this.sanitizeElement(parsed.documentElement);
        if (!clean.childNodes.length) throw new Error("diagram produced no drawable content");
        body.textContent = "";
        body.appendChild(clean);
      });
    },

    // ---------- whiteboard (tldraw) ----------
    /**
     * Freeform drawing canvas driven by tldraw (react-based). Each block gets
     * its own React root; the drawing is persisted as a tldraw snapshot in
     * `content.snapshot` through the regular block PATCH API. Mount identity
     * is tracked with a string tag because rendererState entries come back as
     * reactive proxies, so object identity comparison would always fail.
     */
    async mountWhiteboardRenderer(host, block, spec) {
      host.textContent = "";
      const wrap = document.createElement("div");
      wrap.className = "b-whiteboard";
      const body = document.createElement("div");
      body.className = "render-body whiteboard-body";
      const canvas = document.createElement("div");
      canvas.className = "tldraw-canvas";
      body.appendChild(canvas);
      wrap.appendChild(body);
      const fsbar = document.createElement("div");
      fsbar.className = "wb-fsbar";
      const fsBtn = document.createElement("button");
      fsBtn.type = "button";
      fsBtn.className = "wb-fsbtn";
      fsBtn.textContent = "⛶ Full screen";
      fsBtn.title = "Full screen whiteboard (Esc to exit)";
      fsBtn.addEventListener("click", () => this.toggleWhiteboardFullscreen(block.id));
      fsbar.appendChild(fsBtn);
      wrap.appendChild(fsbar);
      host.appendChild(wrap);
      const mountTag = `wb-${block.id}-${Date.now()}`;
      const runtime = { tl: null, editor: null, root: null, mountTag };
      whiteboardRuntimes.set(block.id, runtime);
      this.rendererState.set(block.id, { blockId: block.id, container: host, wrapper: wrap, cm: null, textarea: null, spec, mountTag });
      this.setRenderStatus(host, "Loading whiteboard…", "info");
      try {
        const TL = await this.ensureTldraw();
        const state = this.rendererState.get(block.id);
        if (!state || state.mountTag !== mountTag || !canvas.isConnected) return;
        runtime.tl = TL;
        const root = TL.createRoot(canvas);
        runtime.root = root;
        root.render(
          TL.createElement(
            TL.Tldraw,
            {
              colorScheme: this.theme === "dark" ? "dark" : "light",
              onMount: (editor) => {
                if (runtime.mountTag !== mountTag || whiteboardRuntimes.get(block.id) !== runtime) return; // superseded mount
                runtime.editor = editor;
                if (block.content?.snapshot) {
                  try {
                    TL.loadSnapshot(editor.store, block.content.snapshot);
                  } catch (e) {
                    this.setRenderStatus(host, `Whiteboard restore failed: ${e?.message || e}`, "warn");
                  }
                }
                this.setRenderStatus(host, null);
                editor.store.listen(() => this.queueWhiteboardSave(block.id), { scope: "document" });
              },
            }
          )
        );
      } catch (e) {
        const state = this.rendererState.get(block.id);
        if (!state || state.mountTag !== mountTag || !canvas.isConnected) return;
        this.setRenderStatus(host, `Whiteboard error: ${e?.message || e}`, "error");
      }
    },

    /** Debounced persistence of a whiteboard block's tldraw snapshot. */
    queueWhiteboardSave(blockId) {
      clearTimeout(this.blockSaveTimers[blockId]);
      this.blockSaveTimers[blockId] = setTimeout(() => {
        delete this.blockSaveTimers[blockId];
        const runtime = whiteboardRuntimes.get(blockId);
        const block = this.blocks.find((b) => b.id === blockId);
        if (runtime?.tl && runtime?.editor && block) {
          this.saveBlockContent(block, { snapshot: runtime.tl.getSnapshot(runtime.editor.store) });
        }
      }, 800);
    },

    /**
     * Miro-style full screen mode: the same `.b-whiteboard` wrapper (and with
     * it the live tldraw React root + editor, which must never be remounted)
     * is pinned over the whole viewport via a class; drawing and autosave
     * keep running unchanged. `enter` omitted = toggle, otherwise force.
     */
    toggleWhiteboardFullscreen(blockId, enter) {
      const state = this.rendererState.get(blockId);
      const wrap = state?.wrapper;
      if (!wrap || !wrap.isConnected) {
        if (whiteboardFullscreenId === blockId) whiteboardFullscreenId = null;
        document.body.classList.remove("wb-fs-lock");
        return;
      }
      const isOn = wrap.classList.contains("wb-fullscreen");
      const on = enter === undefined ? !isOn : !!enter;
      if (on === isOn) return;
      const btn = wrap.querySelector(".wb-fsbtn");
      if (on) {
        if (whiteboardFullscreenId && whiteboardFullscreenId !== blockId) this.toggleWhiteboardFullscreen(whiteboardFullscreenId, false);
        whiteboardFullscreenId = blockId;
        wrap.classList.add("wb-fullscreen");
        document.body.classList.add("wb-fs-lock");
        if (btn) { btn.textContent = "✕ Exit full screen"; btn.title = "Exit full screen (Esc)"; }
      } else {
        if (whiteboardFullscreenId === blockId) whiteboardFullscreenId = null;
        wrap.classList.remove("wb-fullscreen");
        document.body.classList.remove("wb-fs-lock");
        if (btn) { btn.textContent = "⛶ Full screen"; btn.title = "Full screen whiteboard (Esc to exit)"; }
      }
    },

    /** Copy a block's source text (live editor buffer first, stored content otherwise). */
    blockSource(block, spec) {
      const state = this.rendererState.get(block.id);
      if (state?.cm) return state.cm.getValue();
      if (state?.textarea) return state.textarea.value;
      const key = (spec && spec.sourceKey) || "code";
      return block.content?.[key] ?? "";
    },

    /**
     * A math block stores pure LaTeX. Markdown-style display delimiters
     * (```\[ … \]```, ```$$ … $$```, ```\( … \)```) are a paste/import habit,
     * not a formula: KaTeX renders them literally. Strip them so a pasted
     * equation renders instead of turning into a red error.
     */
    normalizeTex(source) {
      const out = String(source ?? "");
      return out
        .replace(/^\s*(?:\\\[|_?\$\$)/, "")
        .replace(/(?:\\\]|\$\$)\s*$/, "")
        .trim();
    },

    patchFor(block, spec, value) {
      if (block.type === "code") return { code: value, language: this.normalizeCodeLang(block.content?.language) };
      if (block.type === "math") return { tex: this.normalizeTex(value), display: block.content?.display !== false };
      return { [(spec && spec.sourceKey) || "code"]: value };
    },

    /**
     * Allowlist sanitizer for generated markup (KaTeX HTML output, Mermaid/D2 SVG).
     * Unknown elements are dropped, scripts/handlers and url()/javascript: are stripped.
     */
    sanitizeNode(node) {
      const out = document.createDocumentFragment();
      this.copySanitizedChildren(node, out);
      return out;
    },

    /** Same sanitizer, but keeping the element itself (used for the diagram <svg> root). */
    sanitizeElement(src) {
      const tag = src.tagName.toLowerCase();
      const el = document.createElementNS(src.namespaceURI || "http://www.w3.org/1999/xhtml", tag);
      this.copySanitizedAttrs(src, el);
      this.copySanitizedChildren(src, el);
      return el;
    },

    copySanitizedChildren(src, parent) {
      const OK_TAGS = new Set(["span", "div", "br", "em", "strong", "code", "b", "i", "sup", "sub", "p", "ul", "ol", "li", "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "title", "desc", "defs", "marker", "clippath", "use", "symbol"]);
      for (const child of Array.from(src.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE) {
          parent.appendChild(document.createTextNode(child.nodeValue));
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        const tag = child.tagName.toLowerCase();
        // Diagram SVGs (Mermaid, D2) ship styling in a <style> child — keep it
        // only when the stylesheet is free of network references (D2 embeds
        // its fonts as data: URLs, which stay allowed).
        if (tag === "style") {
          const css = child.textContent || "";
          if (!this.embeddedCssUnsafe(css)) {
            const el = document.createElementNS(child.namespaceURI || "http://www.w3.org/2000/svg", "style");
            el.textContent = css;
            parent.appendChild(el);
          }
          continue;
        }
        if (!OK_TAGS.has(tag)) continue;
        const el = document.createElementNS(child.namespaceURI || "http://www.w3.org/1999/xhtml", tag);
        this.copySanitizedAttrs(child, el);
        parent.appendChild(el);
        this.copySanitizedChildren(child, el);
      }
    },

    /** Stylesheet safety gate: block scripts, imports and every url() except embedded fonts. */
    embeddedCssUnsafe(css) {
      if (/expression|@import|javascript:/i.test(css)) return true;
      for (const match of css.matchAll(/url\s*\(([^)]*)\)/gi)) {
        const raw = (match[1] || "").trim().replace(/^['"]|['"]$/g, "");
        if (!/^(data:font|data:application\/font)/i.test(raw)) return true;
      }
      return false;
    },

    copySanitizedAttrs(src, dest) {
      const OK_ATTRS = new Set(["class", "style", "role", "aria-hidden", "aria-label", "xmlns", "viewbox", "width", "height", "d", "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "stroke-opacity", "transform", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "points", "text-anchor", "dominant-baseline", "font-size", "font-family", "font-weight", "font-style", "marker-end", "marker-start", "marker-mid", "markerwidth", "markerheight", "refx", "refy", "orient", "id", "preserveaspectratio", "clip-path"]);
      for (const attr of Array.from(src.attributes)) {
        const name = attr.name.toLowerCase();
        const value = attr.value || "";
        if (name === "style") {
          const style = this.sanitizeCss(value);
          if (style) dest.setAttribute("style", style);
          continue;
        }
        if (name === "href" || name === "xlink:href") {
          if (/^#/.test(value)) dest.setAttribute(attr.name, value);
          continue;
        }
        if (!OK_ATTRS.has(name)) continue;
        if (/^\s*(javascript|data|vbscript):/i.test(value)) continue;
        try { dest.setAttribute(attr.name, value); } catch (e) { /* ignore bad attribute */ }
      }
    },

    sanitizeCss(value) {
      return value
        .split(";")
        .map((decl) => decl.trim())
        .filter((decl) => {
          if (!decl) return false;
          const idx = decl.indexOf(":");
          if (idx <= 0) return false;
          if (!/^[a-z-]+$/i.test(decl.slice(0, idx).trim())) return false;
          return !/url\s*\(|expression|@import|javascript:/i.test(decl.slice(idx + 1));
        })
        .join("; ");
    },

    autoGrowEl(el) {
      el.style.height = "auto";
      el.style.height = Math.max(el.scrollHeight, 48) + "px";
    },

    async copyBlockSource(block, evt) {
      const text = this.blockSource(block, this.rendererSpecs[block.type]);
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const area = evt?.target?.closest(".b-code, .b-math, .b-mermaid, .b-plantuml, .b-d2")?.querySelector("textarea");
        if (area) { area.hidden = false; area.select(); document.execCommand("copy"); }
      }
      this.showToast("Copied");
    },

    async changeCodeLanguage(block, language) {
      const state = this.rendererState.get(block.id);
      const code = state?.cm ? state.cm.getValue() : state?.textarea ? state.textarea.value : block.content?.code ?? "";
      const updated = await this.saveBlockContent(block, { language: this.normalizeCodeLang(language), code });
      const idx = this.blocks.findIndex((b) => b.id === block.id);
      if (idx >= 0 && updated) this.blocks[idx] = updated;
      this.invalidateRows();
      const host = state?.container ?? document.querySelector(`.block[data-block-id="${block.id}"] .b-render`);
      this.destroyRenderedBlock(block.id);
      if (host && host.isConnected) {
        host.textContent = "";
        this.mountBlockRenderer(host, { ...block, ...(updated ?? {}) });
      }
    },

    destroyRenderedBlock(blockId) {
      if (whiteboardFullscreenId === blockId) this.toggleWhiteboardFullscreen(blockId, false);
      const runtime = whiteboardRuntimes.get(blockId);
      if (runtime) {
        try { runtime.root?.unmount(); } catch (e) { /* already gone */ }
        whiteboardRuntimes.delete(blockId);
      }
      const state = this.rendererState.get(blockId);
      if (state) {
        if (state.cm) state.cm.getWrapperElement().remove();
        state.wrapper?.remove();
        this.rendererState.delete(blockId);
      }
      delete this.blockSaveTimers[blockId];
      this.codeFolded.delete(blockId);
    },

    destroyRenderedBlocks() {
      for (const id of Array.from(this.rendererState.keys())) this.destroyRenderedBlock(id);
      for (const id of Object.keys(this.blockSaveTimers)) delete this.blockSaveTimers[id];
      this.renderedPending.clear();
    },

    /**
     * Re-mount the theme-sensitive renderers in place (theme switch). Code
     * blocks keep their editor — the -nt colorscheme reads --code-* CSS vars, so
     * a snippet restyles without losing undo history / scroll — and so does
     * KaTeX (its colours follow the app text colour). Only diagrams that embed
     * generated colours (Mermaid, PlantUML, D2) and the tldraw whiteboard are
     * rebuilt.
     */
    remountRenderedBlocks() {
      for (const [blockId, state] of Array.from(this.rendererState.entries())) {
        const host = state.container;
        const block = this.blocks.find((b) => b.id === blockId);
        const spec = this.rendererSpecs[block?.type];
        if (!spec || spec.editor === "codemirror" || block.type === "math") continue;
        const editedSource = state.textarea && !state.textarea.hidden ? state.textarea.value : null;
        if (whiteboardFullscreenId === blockId) this.toggleWhiteboardFullscreen(blockId, false);
        const runtime = whiteboardRuntimes.get(blockId);
        if (runtime?.tl && runtime?.editor) block.content = { ...block.content, snapshot: runtime.tl.getSnapshot(runtime.editor.store) };
        if (runtime) {
          try { runtime.root?.unmount(); } catch (e) { /* already gone */ }
          whiteboardRuntimes.delete(blockId);
        }
        state.wrapper?.remove();
        this.rendererState.delete(blockId);
        if (!host || !host.isConnected) continue;
        if (editedSource !== null) block.content = { ...block.content, [spec.sourceKey]: editedSource };
        host.textContent = "";
        this.mountBlockRenderer(host, block);
      }
    },

    queueBlockSave(blockId, patch) {
      clearTimeout(this.blockSaveTimers[blockId]);
      this.blockSaveTimers[blockId] = setTimeout(() => {
        delete this.blockSaveTimers[blockId];
        this.applyBlockPatch(blockId, patch);
      }, 500);
    },

    /** Flush a pending save immediately instead of waiting for the debounce. */
    patchBlockNow(blockId, patch) {
      clearTimeout(this.blockSaveTimers[blockId]);
      delete this.blockSaveTimers[blockId];
      this.applyBlockPatch(blockId, patch);
    },

    applyBlockPatch(blockId, patch) {
      const block = this.blocks.find((b) => b.id === blockId);
      if (block) this.saveBlockContent(block, patch);
    },

    /** Save pending edits (called on blur/navigation/save) instead of losing them. */
    flushBlockSaves() {
      for (const blockId of Object.keys(this.blockSaveTimers)) {
        clearTimeout(this.blockSaveTimers[blockId]);
        delete this.blockSaveTimers[blockId];
        const block = this.blocks.find((b) => b.id === blockId);
        if (!block) continue;
        const state = this.rendererState.get(blockId);
        const runtime = whiteboardRuntimes.get(blockId);
        if (state?.cm) this.applyBlockPatch(blockId, { code: state.cm.getValue(), language: this.normalizeCodeLang(block.content?.language) });
        else if (state?.textarea && !state.textarea.hidden) this.applyBlockPatch(blockId, this.patchFor(block, state.spec, state.textarea.value));
        else if (runtime?.tl && runtime?.editor) this.applyBlockPatch(blockId, { snapshot: runtime.tl.getSnapshot(runtime.editor.store) });
      }
    },

    async deleteCurrentObject() {
      if (!this.currentObject) return;
      if (!confirm("Delete this object and all its blocks?")) return;
      const id = this.currentObject.id;
      await this.api(`/objects/${id}`, { method: "DELETE" });
      this.tabs = this.tabs.filter((t) => t.id !== id);
      this.pinnedIds = this.pinnedIds.filter((x) => x !== id);
      this.persistPinned();
      this.currentObject = null;
      this.activeTabId = null;
      await Promise.all([this.loadObjects(), this.loadTags()]);
      this.showToast("Deleted");
    },

    showToast(msg) {
      this.toast = msg;
      setTimeout(() => (this.toast = ""), 2000);
    },
  };
}
