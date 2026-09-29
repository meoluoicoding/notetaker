# SKILL.md

> Working instructions for agents/collaborators building this project.
> Full specification: see `architect.md` (source of truth — when in doubt, follow it).

# Capacities-like Knowledge & Note-taking App

Block-based, object-oriented, networked note-taking app inspired by Capacities.
Goal: credible demo/MVP with a clean path to offline-first sync, PostgreSQL, semantic search, AI.

---

## 1. Mental Model (never forget)

```text
SPACE → OBJECT → CONTENT → BLOCKS   (NOT: PAGE → HTML)
SPACE → OBJECT → LINKS → GRAPH      (NOT: FOLDER → PAGE)
```

- **Space** is the outermost container (a workspace): object types, objects and tags all belong to exactly one space.
- Space scoping: `structures.space_id`, `objects.space_id`, `tags.space_id`; blocks/properties/links inherit the space through their object. The active space travels in the `X-Space-Id` header and **every** list/count/search query filters on it.
- **Object** is the fundamental entity (Page, Book, Person, Topic, Project…).
- A **Page** is only a presentation/view of an Object — it owns no separate content.
- Content = ordered **tree of Blocks**.
- Every Object has exactly one **Structure** (type/schema).

---

## 2. Tech Stack (fixed — do not swap without explicit request)

| Layer     | Choice                                        |
|-----------|-----------------------------------------------|
| Frontend  | Alpine.js + TypeScript + HTML/CSS             |
| Editor    | contenteditable, CodeMirror 6, KaTeX, Mermaid |
| Backend   | Node.js + Express.js + TypeScript             |
| Validation| Zod (at API boundary only)                    |
| DB access | Kysely (no heavy ORM)                         |
| Database  | SQLite + FTS5 (future: PostgreSQL + pgvector) |
| Fuzzy     | Fuse.js (or small custom scorer)              |
| Testing   | Vitest (unit/integration), Playwright (e2e)   |
| Deploy    | Docker                                        |

---

## 3. Repository Layout

```text
src/
├── server/        app.ts, server.ts, middleware/, routes/
├── api/           controllers/, validators/, serializers/
├── domain/        object/, block/, structure/, property/, link/, tag/, collection/
├── services/      object-service.ts, block-service.ts, link-service.ts, search-service.ts, …
├── repositories/  object-repository.ts, block-repository.ts, …
├── db/            client.ts, migrations/, seeds/
├── editor/        core/, blocks/, commands/, linking/, code/, math/, diagrams/
├── frontend/      app/, components/, pages/, stores/, styles/
└── shared/        types/, constants/, schemas/
```

Layering rule (strict):

```text
Routes → Controllers → Services → Repositories → DB
```

- **Services own business rules. Repositories own persistence.**
- UI only knows services (`objectService`, `blockService`, `searchService`) — never SQL, Kysely, FTS5, or SQLite.
- Controllers validate with Zod before calling services.

---

## 4. Key Domain Contracts

- IDs: opaque UUIDs. Never encode type/timestamp/title into IDs.
- Block: `{ id, objectId, parentId?, position, type, content (JSON) }` — tree via `parent_id + position`.
- Block ordering: **integer position** for MVP (insert = shift siblings). No fractional indexing/LexoRank yet.
- Text blocks: store structured JSON (text + marks), not raw HTML. Marks: bold, italic, underline, strike, code, link, highlight.
- Object links: store `{ "type": "object_reference", "objectId": "…" }`, never `<a href>` HTML. Titles may change; identity must not break.
- Links table = directed edges (source, target, relation). Backlinks = reverse traversal via SQL, no materialization.
- Recursive graph queries: always cap depth (`depth < 5`).
- Tags: first-class `tags` + `object_tags` tables — never one opaque "#a #b" string.
- Properties: generic `property_definitions` + `object_properties(value_json)` — do NOT hard-code properties as columns.
- Collections: saved query AST (`QueryDefinition`), no duplicated object lists. Translate AST → parameterized SQL.
- Daily notes: deterministic identity via unique constraint `(structure_id, date)`.

### Critical invariants (enforce in services/DB)

1. Every object has exactly one structure.
2. Every block belongs to exactly one object.
3. A block's parent must belong to the same object.
4. Link source/target objects must exist — **and live in the same space**.
5. Property definition must belong to the object's structure.
6. Sibling ordering must be deterministic.
7. An object's structure must belong to the object's space (no cross-space types).
8. `structures.slug` and `tags.name/slug` are unique **per space**, never globally.
9. Creating a space seeds one object type ("Page"); the last space can never be deleted.

---

## 5. Behavior Rules

- **Autosave**: never POST per keystroke. Local mutation → dirty flag → debounce 300–1000ms → batch save; also save on blur/navigation.
- **Separate state**: persistent (objects, blocks, properties, links) vs ephemeral UI (cursor, slashMenuOpen, dragState…). Never persist UI state as domain data.
- **Editor mutations** = explicit operations (`InsertBlock | DeleteBlock | UpdateBlock | MoveBlock | SetProperty | CreateLink | DeleteLink`) with before/after — enables undo/redo, sync, audit. Undo/redo = in-memory op stack for MVP.
- **Transactions**: object creation (object + properties + blocks + tags + search index) must be atomic; ROLLBACK on failure. No partially-created objects.
- **Renderer registry**: map `block.type → component`. NEVER if/else-if chains on block type.
- **Slash menu vs Command palette**: two separate registries. Slash = insert content; palette (Ctrl+K) = app actions. Keep separate.
- **Markdown shortcuts**: pattern detection on input (`# `, `## `, `- `, `[] `), never a full Markdown parser per keystroke.
- **CodeMirror languages lazy-load** — never bundle all at initial load.
- **Drag & drop** → compute parent/position → `MoveBlock` operation → transaction → render. Never touch DB rows from drag handlers.
- **Deterministic seeds**: `mulberry32(seed)` PRNG, no Faker. Same seed = same dataset.

---

## 5b. Block Renderers & Slash Menu (implemented)

- Block metadata lives in `public/assets/block-registry.js` (`window.NTBlocks`): id, type, kind (`text` | `renderer`), label, icon, keywords, `defaults()`. The slash menu and the "+" toolbar both read it — add a block type in one place only.
- `/` in a text block opens the slash menu (pattern detection on input, ranked: exact keyword → label → prefix). Arrow keys move, Enter/Tab picks, Esc closes. Picking **converts the current block in place** (`PATCH { type, content }`).
- Renderer types (`code`, `math`, `mermaid`) mount through `rendererSpecs` in `app.js` (`block.type → renderer`); never add if/else chains on block type in markup — use `isRenderedBlock()` + `.b-render` host with `x-init="mountBlockRenderer($el, block)"`.
- Third-party editor libs are served from `node_modules` via `/vendor/*` (express mounts in `server/app.ts`), with the CDN only as a fallback. Never reintroduce a hard CDN dependency: an offline browser must still get CodeMirror/KaTeX/Mermaid.
- Generated markup (KaTeX HTML, Mermaid SVG) always goes through `sanitizeNode()`/`sanitizeElement()` (tag + attribute allowlist, no `url()`/`javascript:`). Mermaid runs with `securityLevel: "strict"` and `htmlLabels: false` so labels stay inside the allowlist.
- Renderer edits autosave through `queueBlockSave()` (debounced) and `flushBlockSaves()` (blur/navigation) — mirror the CodeMirror path for any new renderer.
- **Chips pass their whole definition** (`addBlockDef(def)` → `addBlock(def.type, def.defaults())`). Several definitions share one block type (H1/H2/H3 are all `heading`), so looking defaults up by type always returns the first one — the old bug where every heading chip created an H1.
- **Heading level is visible while writing**: every `heading` block shows an `H1`/`H2`/`H3` badge in the left gutter (`cycleHeadingLevel()` cycles 1→2→3→1). The cycle reads the live contenteditable buffer before PATCHing, so clicking the badge never overwrites unsaved text.
- **Placeholder policy**: `blockPlaceholder()` returns the slash hint only for a lone empty paragraph (an empty page teaches the command once); an empty heading names its level ("Heading 2"); every other case — including each new line created with Enter — shows nothing. The hint is bound with `:data-placeholder`, never hard-coded.
- Block hover controls (＋ add below / ✕ delete) sit in the right gutter; the left gutter belongs to the heading badge.
- **Code block editor** (architect.md #23): CodeMirror 5 with line numbers, bracket matching/autoclose, active-line highlight, 2-space soft-tab indentation, a fold gutter plus a toolbar "Fold" button (`toggleCodeFolding`, whole-block fold/unfold, fold state tracked in the ephemeral `codeFolded` set), and find/replace (`Ctrl/Cmd-F`, `G`, `Shift-G`) + word completion (`Ctrl/Cmd-Space`) + comment toggle (`Ctrl/Cmd-/`) from lazily loaded addons. Addon paths are listed in `ensureCmMode()` — anything the editor references must appear there or the command silently no-ops.
- **LaTeX block**: KaTeX renders `content.tex` with `displayMode = content.display !== false`. The toolbar carries an "Inline"/"Display" button (`toggleMathDisplay`) that persists `content.display` and flips the `.inline-math` class. It takes the **block id, not the block object**: `saveBlockContent()` swaps the entry in `this.blocks`, so a closure over the mounted block object would read a stale `display` and flip the same value forever.

---

## 5c. App Shell & Navigation (implemented)

The shell mirrors the reference UI (Anytype-like): title bar, sidebar, tab strip, overlay layer.

- **Title bar**: space button (opens the space switcher), sidebar toggle, Settings, back/forward history, the tab strip, search (Ctrl+K) and the theme toggle.
- **Spaces are server rows** (`GET/POST /spaces`, `PATCH/DELETE /spaces/:id`). The client keeps only `nt-space-id` (last used space) and sends `X-Space-Id` on every request; `switchSpace()` clears tabs, history, the open object and reloads structures/objects/tags.
- **Tabs & history are ephemeral UI state.** `tabs`/`activeTabId`/`history`/`historyIndex` live on the `app()` object only — never persisted, never treated as domain data. Replaying history passes `openObject(id, { skipHistory: true })` so back/forward does not push new entries.
- **One fetch, client-side views.** `loadObjects()` loads the newest 200 objects *of the active space* once; `viewObjects()` filters for Explore / one type / one tag / Pinned / Calendar. Never re-query per view. Object rows use the DB's `structure_id` and `space_id` (never a camelCase remap).
- **Browser preferences, not object data**: last used space (`nt-space-id`), pinned ids per space (`nt-pinned:<spaceId>`) and theme mode (`nt-theme-mode`). Pinning must never PATCH the object.
- **Overlays**: `Ctrl+K` opens the search palette, `Ctrl+N` (also the "+" tab button, the sidebar New row and the FAB) opens the object-type picker, `Shift+Enter` in the picker opens the full new-object form, `Esc` closes everything. Both panels carry the keyboard hint footer ("↑↓ to navigate · Esc to close · ↵ to select").
- **Settings modal** = Appearance (light/dark/system through `setThemeMode` → `applyThemeMode`), Space settings (name/icon via `PATCH /spaces/:id`, content counts per space, guarded delete) and Object types. Type tiles colour deterministically from the slug (`typeColor`). Renaming/re-iconing a type is `PATCH /api/v1/structures/:id` (`saveType()`); items that are not built yet say so through `notImplemented()` instead of faking behaviour.
- Every directive that can call a method (`@…`, `:…`, `x-on:`/`x-init`/`x-if`/`x-for`/`x-show`/`x-text`/`x-model`) is scanned by `tests/ui-wiring.test.ts` — a method used in markup but missing in `app.js` fails the suite. Add a method and its markup together.

---

## 5d. Data Entry (implemented)

Typing/editing rules live in `public/assets/entry-rules.js` (`window.NTEntry`) as pure functions — no DOM, no Alpine, no fetch — and are pinned by `tests/entry-rules.test.ts`; `app.js` only performs them. End-to-end: `e2e/tests/entry.spec.ts`. Full spec: architect.md #21b.

- **Enter splits, it does not append a paragraph.** `splitBlockOnEnter` cuts the line at the caret (text + marks), saves the head into the current block, and creates the next block with the tail. The new block keeps the line's shape (`enterContinue`: todo → todo, both list types → themselves, quote → quote, heading → paragraph). Two shapes take the simpler road (`enterAction`): an empty list item or quote converts back to a paragraph (you typed your way out of the list), and a block that **owns children** only opens an empty line beneath its subtree — its text is never split, because cutting the parent's sentence around its own children is the one thing a reader cannot repair.
- **A split/merge must write its model back into the DOM** (`syncBlockElement`) before anything else focuses away: `@blur` saves the element's text, so a model-only change would be overwritten by the next blur.
- **Backspace** at offset 0 of a list item or quote drops the marker and keeps the words; anywhere else it merges the line into the one above. A line that owns child blocks is never merged (the server cascades descendants) — the UI refuses and says so. Merges join the inline models with `joinInline`, marks included.
- **Delete** at the end of a line pulls the next block's text up and removes that block (same guards).
- **ArrowUp/ArrowDown** at a line edge move the caret to the neighbouring block in visual order (`blockRows`) and land at its edge (`focusBlockEdge`, which also handles CodeMirror and the diagram textareas). Inside a line the browser keeps the key.
- **Paste** is text-first: a single line without a block marker is inserted as text at the caret (`execCommand("insertText")`, never the clipboard's HTML); a multi-line or markdown clipboard becomes real blocks at the caret (`pasteBlocks`), the text after the caret keeping its own line below. Pasting onto an empty line takes that line over instead of leaving a stray empty paragraph. Titles/descriptions use `onPlainPaste` (newlines flattened). Shift+paste stays with the browser.
- **One markdown grammar, two callers**: `markdownToBlocks` in entry-rules.js serves both the paste path and the "New object" form. Never add a second parser to app.js. `parseContentToBlocks` is now a thin delegate.
- **Numbered lists count in JS, not CSS**: every item is its own block, so there is no `<ol>` to count them — `numberListRows` walks the rendered rows (called from `blockRows()`), restarts on any other block, gives a nested item its own sublist, and the markup renders `:data-number` (CSS prints `attr(data-number)`). A run of numbered blocks must read 1. 2. 3., never 1. 1. 1.
- **A todo block is a `<div class="b-todo">`, never a `<label>`**: a label hands the click's focus to the checkbox, so clicking the text would not let you type.
- **Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y** run the editor's own op stack (never the browser's native undo — the DOM is a projection of the model); CodeMirror blocks and form fields are skipped so their own history survives. Paste, delete and merge each leave undo entries (`removeEntry` re-creates a deleted block and remembers its new id).
- The "New object" form creates on **Ctrl+Enter**, and its content field accepts the same markdown-lite (headings, todos, bullets, numbered items, quotes, dividers, fences, inline marks), so a pasted document and a pasted clipboard agree.

---

## 6. API Conventions

Routes: `/api/v1/spaces` (+ `PATCH/DELETE /api/v1/spaces/:id`), `/api/v1/objects`, `/api/v1/objects/:id/blocks|properties|links`, `/api/v1/structures` (+ `PATCH /api/v1/structures/:id` to rename/re-icon a type), `/api/v1/tags`, `/api/v1/search`, `/api/v1/collections`. Every space-scoped route reads the active space from the `X-Space-Id` header (`?spaceId=` also works); omit it and the oldest space is used.

Success: `{ "data": {}, "meta": {} }`.
Error: `{ "error": { "code": "OBJECT_NOT_FOUND", "message": "…" } }` — never raw DB errors, never stack traces.

Domain error → HTTP mapping: NotFound→404, Invalid→400/422, Duplicate→409.

App routes use object ID as canonical identity: `/objects/:id` (not title).

---

## 7. Security (non-negotiable)

- Parameterized SQL always — never concatenate user input into SQL.
- Sanitize all user content (HTML, Mermaid/SVG output, images). Code blocks are displayed as text — never executed.
- Never `innerHTML = userInput` un-sanitized. Never trust client-side validation.
- Never log secrets/tokens/private content.

---

## 8. Explicit Non-Goals (do NOT build these now)

```text
CRDT / real-time multiplayer        Graph database
Microservices / Kubernetes          Custom vector DB
Custom LaTeX/diagram parser         Full offline sync
Complex permissions / RBAC          Fractional indexing
Materialized backlinks              Heavy ORM
Global mutable store                premature optimization
```

Conflict strategy (future sync): last-write-wins. AI/embeddings are Phase 11+ — out of scope until core is stable.

---

## 9. Implementation Phases (build in this order)

0. Foundation — TypeScript, Express, Alpine, SQLite, Kysely, Zod, app shell, seed system
1. Object system — structures, objects, properties, tags, CRUD
2. Page — PageShell, header, title, description, properties
3. Block engine — paragraph, heading, todo, quote, divider; nested/insert/reorder/delete
4. Editor commands — slash menu, markdown shortcuts, `@`/`[[` linking
5. Specialized blocks — CodeMirror, KaTeX, Mermaid, image, table
6. Search — FTS5, exact matching, ranking
7. Graph — links, backlinks, traversal
8. Collections — query AST, saved queries
9. Polish — keyboard, undo/redo, autosave, drag/drop, themes
10. Offline — local-first + sync queue
11. AI — embeddings, hybrid search, RAG (only after core is stable)

---

## 10. Workflow for Agents

- Read `architect.md` for full details of any subsystem before implementing it.
- Follow KISS / DRY / YAGNI / SOLID / separation of concerns; no premature abstraction.
- No `any`-sprawl: use shared types in `src/shared/types/` and Zod schemas in `src/shared/schemas/`.
- Tests: unit-test block tree, position calc, slash parser, markdown shortcuts, query parser, link/backlink creation, property validation; integration-test services + repositories + transactions; e2e-test core flows (create page, slash command, code block, object link, backlink, search, undo).
- Run `npm run typecheck` and `npm run test` after changes; `npm run e2e` for the browser suite. There is no `lint` script and no build step — `public/` is served as-is (only the tldraw vendor bundle is generated, `npm run build:vendor`).
- **Optional native search**: `search-native/` is a napi-rs cdylib wrapping Tantivy 0.24.1 (the same version `rust-lib`'s flowy-search pins). It is a *secondary* index: SQLite/FTS5 stays the source of truth and the whole FTS5 pipeline runs without it. Build with `npm run build:native` (cargo + copy to `search-native/search-native.node`); disable with `NT_NATIVE_SEARCH=0`. `search-index-service` mirrors writes into it and `search-service` adds its typo-tolerant ids to the candidate pool; the `.node` sits outside the repo's git ignore scope, so keep tests green with and without it (`tests/native-search.test.ts` self-skips).
- Do not commit unless explicitly asked.
