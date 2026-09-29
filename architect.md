# ARCHITECT.md

# Capacities-like Knowledge & Note-taking App

> Architecture specification for a block-based, object-oriented, networked note-taking application inspired by Capacities.
>
> Status: `Draft / Implementation Ready`
>
> Primary goal: build a technically credible demo/MVP with a clean path toward offline-first sync, PostgreSQL, semantic search, and AI.

---

## 1. Product Definition

The application is a **personal knowledge management system** built around:

```text
Object
├── Properties
├── Content / Blocks
├── Links
├── Tags
└── Metadata
```

The application is NOT primarily:

```text
Folder
└── Page
    └── Text
```

Instead:

```text
Object
   │
   ├── Object Type
   ├── Properties
   ├── Blocks
   ├── Links
   ├── Tags
   └── References
```

A Page is one presentation/view of an Object.

---

# 2. Design Principles

## 2.1 Core Principles

* Object-first architecture
* Block-based editing
* Relational persistence
* Graph-like domain relationships
* Local-first-ready data model
* Deterministic behavior
* Explicit state transitions
* No unnecessary abstraction
* No vendor lock-in in the domain layer
* Progressive enhancement
* API-first backend
* UI independent from persistence

## 2.2 Engineering Principles

Follow:

```text
KISS
DRY
YAGNI
SOLID
Separation of Concerns
Dependency Inversion
Explicit Data Contracts
```

Avoid:

```text
Premature microservices
Premature CRDT
Premature Graph Database
Heavy ORM
Global mutable state
UI-driven database schema
Magic persistence
```

---

# 3. Architecture Overview

```text
┌──────────────────────────────────────────────────────────┐
│                         CLIENT                           │
│                                                          │
│  Alpine.js                                               │
│  ├── App Shell                                           │
│  ├── Router                                              │
│  ├── Page Renderer                                       │
│  ├── Block Editor                                        │
│  ├── Slash Command                                       │
│  ├── Object Search                                       │
│  └── UI State                                            │
│                                                          │
│  CodeMirror 6 ─── Code Blocks                            │
│  KaTeX ────────── Math                                   │
│  Mermaid ──────── Diagrams                               │
└────────────────────────┬─────────────────────────────────┘
                         │ HTTP / JSON
                         ▼
┌──────────────────────────────────────────────────────────┐
│                       BACKEND                            │
│                                                          │
│  Express.js                                               │
│                                                          │
│  Routes                                                  │
│     ↓                                                    │
│  Controllers                                             │
│     ↓                                                    │
│  Services                                                │
│     ↓                                                    │
│  Repositories                                            │
└────────────────────────┬─────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────┐
│                      SQLite                              │
│                                                          │
│  objects                                                 │
│  structures                                              │
│  properties                                              │
│  blocks                                                  │
│  links                                                   │
│  tags                                                    │
│  object_tags                                             │
│  collections                                             │
│  search_index (FTS5)                                     │
└──────────────────────────────────────────────────────────┘
```

Future:

```text
SQLite
   │
   ▼
Sync Layer
   │
   ▼
PostgreSQL
   │
   ├── Queue
   ├── Workers
   ├── Embeddings
   └── AI
```

---

# 4. Technology Stack

## 4.1 Frontend

### Primary

```text
Alpine.js
TypeScript
HTML
CSS
```

Alpine.js is responsible for:

* local UI state
* component behavior
* menus
* modals
* command palette
* property panels
* page navigation
* editor orchestration

Do not use Alpine.js as the domain model.

---

## 4.2 Backend

```text
Node.js
Express.js
TypeScript
```

Responsibilities:

* HTTP API
* authentication boundary
* validation
* business logic
* transaction handling
* persistence
* search
* object graph queries

---

## 4.3 Database

MVP:

```text
SQLite
```

Search:

```text
SQLite FTS5
```

Production migration target:

```text
PostgreSQL
```

Database access:

```text
Kysely
```

Do not introduce a heavy ORM unless there is a demonstrated requirement.

---

## 4.4 Editor Components

### Text

```text
contenteditable
```

### Code

```text
CodeMirror 6
```

### Mathematics

```text
KaTeX
```

### Diagrams

```text
Mermaid
```

### Fuzzy search

```text
Fuse.js
```

or a small custom scorer if the command set is small.

---

# 5. Repository Structure

```text
app/
│
├── architect.md
├── package.json
├── tsconfig.json
├── .env.example
├── README.md
│
├── src/
│   │
│   ├── server/
│   │   ├── app.ts
│   │   ├── server.ts
│   │   ├── middleware/
│   │   └── routes/
│   │
│   ├── api/
│   │   ├── controllers/
│   │   ├── validators/
│   │   └── serializers/
│   │
│   ├── domain/
│   │   │
│   │   ├── object/
│   │   ├── block/
│   │   ├── structure/
│   │   ├── property/
│   │   ├── link/
│   │   ├── tag/
│   │   └── collection/
│   │
│   ├── services/
│   │   ├── object-service.ts
│   │   ├── block-service.ts
│   │   ├── link-service.ts
│   │   ├── search-service.ts
│   │   ├── structure-service.ts
│   │   └── collection-service.ts
│   │
│   ├── repositories/
│   │   ├── object-repository.ts
│   │   ├── block-repository.ts
│   │   ├── link-repository.ts
│   │   ├── structure-repository.ts
│   │   └── search-repository.ts
│   │
│   ├── db/
│   │   ├── client.ts
│   │   ├── migrations/
│   │   └── seeds/
│   │
│   ├── editor/
│   │   │
│   │   ├── core/
│   │   ├── blocks/
│   │   ├── commands/
│   │   ├── linking/
│   │   ├── code/
│   │   ├── math/
│   │   └── diagrams/
│   │
│   ├── frontend/
│   │   ├── app/
│   │   ├── components/
│   │   ├── pages/
│   │   ├── stores/
│   │   └── styles/
│   │
│   └── shared/
│       ├── types/
│       ├── constants/
│       └── schemas/
│
├── public/
│   ├── index.html
│   ├── assets/
│   └── icons/
│
└── tests/
    ├── unit/
    ├── integration/
    └── e2e/
```

---

# 6. Domain Model

## 6.1 Object

Object is the fundamental content entity.

```typescript
interface ObjectEntity {
    id: string;
    structureId: string;
    title: string;
    description?: string;
    icon?: string;
    coverUrl?: string;

    createdAt: string;
    updatedAt: string;
}
```

Examples:

```text
Page
Book
Person
Topic
Project
Meeting
Resource
```

---

# 7. Structure / Object Type

A Structure defines the schema of an Object.

```typescript
interface Structure {
    id: string;
    name: string;
    slug: string;

    icon?: string;

    createdAt: string;
    updatedAt: string;
}
```

Example:

```text
Book
├── title
├── author
├── ISBN
├── year
├── rating
└── topics
```

Structure is analogous to a type/schema.

---

# 8. Property System

Properties are schema-defined metadata.

```typescript
interface PropertyDefinition {
    id: string;
    structureId: string;

    name: string;
    slug: string;

    type:
        | "text"
        | "number"
        | "boolean"
        | "date"
        | "datetime"
        | "select"
        | "multi_select"
        | "object"
        | "multi_object"
        | "url";
}
```

Property values:

```typescript
interface PropertyValue {
    objectId: string;
    propertyId: string;
    value: unknown;
}
```

Do not hard-code every property as a database column.

---

# 9. Page

Page is a specialized Object presentation.

```text
Page
│
├── Header
│   ├── Icon
│   ├── Cover
│   ├── Title
│   ├── Description
│   └── Properties
│
└── Content
    └── Block Tree
```

Page does NOT own a separate content database.

It references:

```text
objects.id
```

and renders:

```text
object.content
```

through the Block Engine.

---

# 10. Page View Modes

Support:

```typescript
type PageViewMode =
    | "full"
    | "preview"
    | "sidepanel";
```

### Full

Primary editing experience.

### Preview

Compact object inspection.

### Side panel

Object remains visible while another page is active.

---

# 11. Page Layout System

Layouts are presentation schemas.

```typescript
type PageLayout =
    | "standard"
    | "profile"
    | "index-card"
    | "encyclopedia";
```

Layout example:

```text
Profile

┌──────────────┬─────────────────────┐
│ Avatar       │ Title               │
│              │ Description         │
│              │ Properties          │
│              │                     │
│              │ Content             │
└──────────────┴─────────────────────┘
```

Do not duplicate domain data for different layouts.

---

# 12. Block System

Block is the atomic editable content unit.

```typescript
interface Block {
    id: string;
    objectId: string;

    parentId?: string;

    position: number;

    type: BlockType;

    content: unknown;

    createdAt: string;
    updatedAt: string;
}
```

---

# 13. Block Types

MVP:

```typescript
type BlockType =
    | "paragraph"
    | "heading"
    | "todo"
    | "quote"
    | "code"
    | "math"
    | "image"
    | "divider"
    | "object"
    | "bookmark"
    | "table";
```

Future:

```text
callout
toggle
file
audio
video
embed
database
column
synced-block
```

---

# 14. Block Tree

Blocks form a tree.

```text
Block A
├── Block B
│   ├── Block C
│   └── Block D
│
└── Block E
```

Persistence:

```text
blocks
--------------------------------
id
object_id
parent_id
position
type
content_json
```

Ordering is controlled by:

```text
parent_id
+
position
```

---

# 15. Block Position

MVP:

```text
integer position
```

Example:

```text
0
1
2
3
```

When inserting:

```text
insert at 1
```

shift:

```text
1 → 2
2 → 3
3 → 4
```

Future optimization:

```text
fractional indexing
LexoRank-like ordering
```

Do NOT implement fractional indexing until required.

---

# 16. Block Renderer

Use a registry.

```typescript
const blockRenderers = {
    paragraph: ParagraphBlock,
    heading: HeadingBlock,
    todo: TodoBlock,
    quote: QuoteBlock,
    code: CodeBlock,
    math: MathBlock,
    image: ImageBlock,
    object: ObjectBlock,
    table: TableBlock
};
```

Rendering:

```text
block.type
    ↓
renderer registry
    ↓
component
```

Do not implement:

```typescript
if (block.type === ...)
else if (...)
else if (...)
```

throughout the application.

---

# 17. Text Block

Use:

```text
contenteditable
```

for MVP.

Text is stored as structured JSON rather than raw HTML.

Example:

```json
{
    "type": "paragraph",
    "content": [
        {
            "text": "Hello "
        },
        {
            "text": "world",
            "marks": ["bold"]
        }
    ]
}
```

Supported marks:

```text
bold
italic
underline
strike
code
link
highlight
```

---

# 18. Slash Command System

Slash command is an editor-level command registry.

Trigger:

```text
/
```

Architecture:

```text
Keyboard Input
      ↓
Trigger Detector
      ↓
Slash Command Parser
      ↓
Command Registry
      ↓
Fuzzy Search
      ↓
Slash Menu
      ↓
Command Executor
      ↓
Block Mutation
```

---

# 19. Command Registry

```typescript
interface EditorCommand {
    id: string;
    label: string;

    aliases: string[];

    description?: string;

    execute(context: EditorContext): void;
}
```

Example:

```typescript
{
    id: "insert-code",
    label: "Code",
    aliases: ["code", "snippet"],
    execute: insertCodeBlock
}
```

Commands:

```text
/code
/heading
/todo
/quote
/math
/image
/table
/divider
```

---

# 20. Slash Menu Filtering

Input:

```text
/cod
```

Normalize:

```text
"cod"
```

Candidate matching:

```text
code
```

Ranking:

```text
exact prefix
>
prefix
>
substring
>
alias
>
fuzzy
```

For a small command set:

```typescript
commands.filter(...)
```

is sufficient.

For a larger command set:

```text
Fuse.js
```

may be introduced.

---

# 21. Markdown Shortcuts

Detect patterns before converting a paragraph.

Examples:

```text
# + Space
```

→ heading 1

```text
## + Space
```

→ heading 2

```text
- + Space
```

→ bullet/paragraph variant

```text
[] + Space
```

→ todo

Implementation:

```text
input
 ↓
pattern detector
 ↓
shortcut matcher
 ↓
block conversion
 ↓
cursor normalization
```

Do not run a complete Markdown parser on every keystroke.

---

# 21b. Data Entry Rules

Typing is the product: every keystroke and every clipboard has a defined result on
the block model. The rules are pure functions in `public/assets/entry-rules.js`
(`window.NTEntry`), pinned by `tests/entry-rules.test.ts`; `app.js` only performs
them, and the flows are covered end-to-end in `e2e/tests/entry.spec.ts`.

## Enter

```text
Enter
  ↓
split the line at the caret (text + marks)
  ↓
save the head back into the current block
  ↓
create the next block and fill it with the tail
```

The block's shape decides the next type (`enterContinue`):

```text
todo          -> todo
bulleted_list -> bulleted_list
numbered_list -> numbered_list
quote         -> quote
heading       -> paragraph
```

`enterAction` picks one of three outcomes before anything is written:

```text
exit    an empty list item or quote leaves the block (it becomes a paragraph)
insert  the line owns child blocks -> open a new line, never split
split   an ordinary line -> the text after the caret moves to the new line
```

- Enter on an empty list item or quote leaves the block (it becomes a paragraph).
- A hard-coded paragraph is wrong: typing a list and pressing Enter must continue the list.
- A block that **owns children** does not split: Enter only opens an empty line beneath
  its subtree, and the parent's text stays whole. Splitting there would cut the parent's
  sentence around its own children, which is the one thing a reader cannot repair.
- A split must write the head back into the element (`syncBlockElement`). The model
  changed while the DOM still held the whole line, and the blur-save would otherwise
  write the un-split text over the split.

## Backspace

```text
caret at offset 0, list item or quote -> drop the marker, keep the words
caret at offset 0, anything else      -> merge this line into the line above
```

- A line that owns child blocks is never merged away: the server cascades
  descendants, so merging would delete them (the UI says so instead).
- A merge joins the two inline models (`joinInline`), marks included, and writes the
  result back into the element before placing the caret.

## Delete

`Delete` at the end of a line appends the next block's text here and removes that
block. Rendered blocks (code/math/mermaid/plantuml/d2/whiteboard) and blocks with
children are skipped.

## Arrow keys

`ArrowUp` at the start of a line and `ArrowDown` at the end move the caret to the
neighbouring block in the **visual** order (`blockRows`, the flattened tree, so
nesting counts) and land at its edge — end for up, start for down. Inside a line the
browser keeps the key.

## Paste

```text
clipboard text/plain
  ↓
one line, no block marker   -> insert as text at the caret (never the clipboard HTML)
multi-line or block marker  -> build blocks
```

- Pasted blocks land at the caret: the line splits, the blocks sit between the two
  halves, and the text that followed the caret keeps its own line below.
- Pasting onto an empty line takes that line over instead of leaving a stray empty
  paragraph above the paste.
- Titles and descriptions are plain text (`onPlainPaste` flattens newlines).
- Shift+paste is left to the browser.
- Clipboard HTML never reaches the model: a line is inserted as text.

## Lists

- Every list item is its own block, so a numbered marker cannot come from an `<ol>`:
  `numberListRows` numbers a run of `numbered_list` rows in visual order (a nested
  item starts its own sublist, any other block restarts the count) and the marker is
  rendered from `data-number` in CSS.
- A todo block is not a `<label>`: a label hands the click's focus to the checkbox,
  which leaves the text uneditable.

## History

- `Ctrl+Z` / `Ctrl+Shift+Z` (also `Ctrl+Y`) run on the editor's own op stack
  (§46), never the browser's native history — the DOM is only a projection of the
  model. CodeMirror blocks and form fields keep their own history.
- A paste, a delete and a merge each leave undo entries; an undo of a delete
  re-creates the block, so the entry remembers the new id.

---

# 22. Code Block

Code block is an embedded editor.

```text
Block
└── CodeMirror 6
```

Code block data:

```typescript
interface CodeBlockContent {
    language: string;
    code: string;
}
```

Example:

```json
{
    "language": "rust",
    "code": "fn main() {}"
}
```

---

# 23. CodeMirror Configuration

Required:

```text
line numbers
syntax highlighting
bracket matching
history
selection
search
folding
autocomplete
indentation
multiple selections
```

Languages can be lazy-loaded.

Example:

```text
JavaScript
TypeScript
Python
Rust
Go
SQL
HTML
CSS
JSON
Markdown
YAML
Bash
```

Do not load every language at initial page load.

---

# 24. Code Block Lifecycle

```text
Block Renderer
      ↓
CodeBlock mounted
      ↓
CodeMirror created
      ↓
load block.content.code
      ↓
user edits
      ↓
debounced state update
      ↓
save block
      ↓
destroy on unmount
```

Never save every individual keystroke as an HTTP request.

Use:

```text
local mutation
+
debounce
+
batched persistence
```

---

# 25. Math Block

Math data:

```typescript
interface MathBlockContent {
    expression: string;
}
```

Pipeline:

```text
TeX input
   ↓
KaTeX
   ↓
HTML
```

Never execute arbitrary HTML from math input.

---

# 26. Mermaid Block

```typescript
interface MermaidBlockContent {
    source: string;
}
```

Pipeline:

```text
Mermaid source
     ↓
Mermaid parser
     ↓
SVG
```

Sanitize generated/rendered output where necessary.

---

# 27. Object Reference Block

An object reference is not a normal hyperlink.

```typescript
interface ObjectReference {
    objectId: string;
}
```

Rendering:

```text
[Book: The Selfish Gene]
```

instead of:

```html
<a href="/page/...">
```

This preserves object identity.

---

# 28. Inline Object Linking

Supported triggers:

```text
@
[[
```

Example:

```text
Read about [[Rust ownership
```

Pipeline:

```text
keyboard input
      ↓
trigger detector
      ↓
query extraction
      ↓
search service
      ↓
object results
      ↓
selection
      ↓
object reference insertion
```

---

# 29. Object Link Representation

Do not store only rendered HTML.

Store:

```json
{
    "type": "object_reference",
    "objectId": "object-uuid"
}
```

This means:

```text
title changes
```

do not break:

```text
references
backlinks
queries
graph
```

---

# 30. Link Graph

Links are directed edges.

```text
A → B
```

Database:

```text
links
--------------------------------
source_object_id
target_object_id
relation
created_at
```

Example:

```text
Book
 └──→ Author

Research
 └──→ Topic

Project
 └──→ Person
```

---

# 31. Backlinks

Backlinks are reverse graph traversal.

```sql
SELECT source_object_id
FROM links
WHERE target_object_id = ?;
```

Do not duplicate backlinks unless profiling proves that materialized backlinks are necessary.

---

# 32. Recursive Graph Queries

For traversal:

```sql
WITH RECURSIVE graph AS (
    SELECT
        source_object_id,
        target_object_id,
        1 AS depth
    FROM links
    WHERE source_object_id = ?

    UNION ALL

    SELECT
        l.source_object_id,
        l.target_object_id,
        g.depth + 1
    FROM links l
    JOIN graph g
        ON l.source_object_id = g.target_object_id
    WHERE g.depth < 5
)
SELECT *
FROM graph;
```

Always enforce a maximum traversal depth.

Never allow uncontrolled recursive traversal.

---

# 33. Search Architecture

Search consists of multiple mechanisms.

```text
                 SEARCH
                    │
        ┌───────────┼───────────┐
        ▼           ▼           ▼
     Exact       Full-text    Semantic
```

MVP:

```text
Exact
+
SQLite FTS5
```

Future:

```text
PostgreSQL
+
pgvector
```

---

# 34. FTS5 Search

Index:

```text
object title
object description
block text
tags
```

Conceptual schema:

```sql
CREATE VIRTUAL TABLE search_index
USING fts5(
    object_id,
    title,
    content
);
```

Search:

```text
query
 ↓
FTS5
 ↓
object IDs
 ↓
object hydration
 ↓
UI
```

---

# 35. Search Ranking

MVP ranking:

```text
title exact
>
title prefix
>
title substring
>
body match
>
tag match
```

Future:

```text
BM25
+
recency
+
object popularity
+
semantic similarity
```

Do not implement a custom search engine for MVP.

---

# 36. Tags

Tags are first-class entities.

```text
tags
-----
id
name
slug
```

Relation:

```text
object_tags
-----------
object_id
tag_id
```

Do not store:

```text
"#rust #programming #systems"
```

as one opaque string.

---

# 37. Collections

Collection is a saved grouping/query.

```typescript
interface Collection {
    id: string;
    name: string;

    filter: QueryDefinition;
}
```

Example:

```json
{
    "structure": "book",
    "filters": [
        {
            "property": "rating",
            "operator": ">=",
            "value": 4
        }
    ]
}
```

Collection does not duplicate objects.

---

# 38. Query Engine

Represent queries as AST/JSON.

```typescript
interface QueryDefinition {
    and?: QueryDefinition[];
    or?: QueryDefinition[];

    field?: string;
    operator?: string;
    value?: unknown;
}
```

Example:

```json
{
    "and": [
        {
            "field": "type",
            "operator": "=",
            "value": "book"
        },
        {
            "field": "rating",
            "operator": ">=",
            "value": 4
        }
    ]
}
```

Translate query definitions into parameterized SQL.

Never concatenate user input into SQL.

---

# 39. Database Schema

## spaces

```sql
CREATE TABLE spaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

A space is the outermost container. Object types, objects and tags belong to
exactly one space; blocks, properties and links inherit it through their object.
Every scoped query carries the space: without it nothing is ever returned by
accident. Databases that predate spaces are upgraded in place — the migration
creates one default space and hands every existing row to it (§39b).

## structures

```sql
CREATE TABLE structures (
    id TEXT PRIMARY KEY,
    space_id TEXT,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    icon TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,

    FOREIGN KEY (space_id)
        REFERENCES spaces(id)
);

CREATE UNIQUE INDEX idx_structures_space_slug ON structures(space_id, slug);
```

## objects

```sql
CREATE TABLE objects (
    id TEXT PRIMARY KEY,
    structure_id TEXT NOT NULL,
    space_id TEXT,
    title TEXT NOT NULL,
    description TEXT,
    icon TEXT,
    cover_url TEXT,

    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,

    FOREIGN KEY (structure_id)
        REFERENCES structures(id),
    FOREIGN KEY (space_id)
        REFERENCES spaces(id)
);
```

`space_id` is denormalized from the structure on purpose: every list, count and
search filter is a single indexed `WHERE space_id = ?`, never a join.

## property_definitions

```sql
CREATE TABLE property_definitions (
    id TEXT PRIMARY KEY,
    structure_id TEXT NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    type TEXT NOT NULL,

    FOREIGN KEY (structure_id)
        REFERENCES structures(id)
);
```

## object_properties

```sql
CREATE TABLE object_properties (
    object_id TEXT NOT NULL,
    property_id TEXT NOT NULL,
    value_json TEXT,

    PRIMARY KEY (object_id, property_id),

    FOREIGN KEY (object_id)
        REFERENCES objects(id),

    FOREIGN KEY (property_id)
        REFERENCES property_definitions(id)
);
```

## blocks

```sql
CREATE TABLE blocks (
    id TEXT PRIMARY KEY,

    object_id TEXT NOT NULL,

    parent_id TEXT,

    position INTEGER NOT NULL,

    type TEXT NOT NULL,

    content_json TEXT NOT NULL,

    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,

    FOREIGN KEY (object_id)
        REFERENCES objects(id),

    FOREIGN KEY (parent_id)
        REFERENCES blocks(id)
);
```

## links

```sql
CREATE TABLE links (
    source_object_id TEXT NOT NULL,
    target_object_id TEXT NOT NULL,

    relation TEXT,

    created_at TEXT NOT NULL,

    PRIMARY KEY (
        source_object_id,
        target_object_id,
        relation
    )
);
```

## tags

```sql
CREATE TABLE tags (
    id TEXT PRIMARY KEY,
    space_id TEXT,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,

    FOREIGN KEY (space_id)
        REFERENCES spaces(id)
);

CREATE UNIQUE INDEX idx_tags_space_name ON tags(space_id, name);
CREATE UNIQUE INDEX idx_tags_space_slug ON tags(space_id, slug);
```

Tag names are unique **per space**: the same word may exist in two spaces without
sharing a row, and deleting one space never touches another's tags.

## object_tags

```sql
CREATE TABLE object_tags (
    object_id TEXT NOT NULL,
    tag_id TEXT NOT NULL,

    PRIMARY KEY (
        object_id,
        tag_id
    )
);
```

---

# 39b. Space Scoping Rules

Invariants (enforced in services, not left to the caller):

```text
object.structure  must belong to object.space        (createObject)
links             never cross spaces                 (createLink)
structures.slug   unique per space, not globally     (unique index)
tags.name / slug  unique per space, not globally     (unique index)
space has ≥ 1 object type                            (createSpace seeds "Page")
the last space is never deleted                      (deleteSpace)
```

- The active space travels in the **`X-Space-Id` request header** (`?spaceId=` also
  works for curl). Without it the oldest space is used, which is where data
  written before spaces existed lives.
- A request naming an unknown space fails with `SPACE_NOT_FOUND` (404) instead of
  silently falling back.
- Deleting a space needs it to be empty unless `?force=1`; the service refuses the
  last remaining space (`LAST_SPACE_REMAINING`, 409).
- Client side: only "which space I am in" is remembered (localStorage
  `nt-space-id`); name, icon, counts and content always come from the server.
  Pins are per space (`nt-pinned:<spaceId>`), tabs/history are dropped on switch.
- Upgrading a pre-spaces database: add `space_id`, backfill the default space, and
  rebuild the two tables that carried global `UNIQUE` constraints (`structures`,
  `tags`) because SQLite cannot drop a table constraint in place. The migration is
  idempotent and covered by `tests/migration.test.ts`.

---

# 40. Database Indexes

Required:

```sql
CREATE INDEX idx_objects_structure
ON objects(structure_id);

CREATE INDEX idx_objects_updated
ON objects(updated_at);

CREATE INDEX idx_blocks_object
ON blocks(object_id);

CREATE INDEX idx_blocks_parent
ON blocks(parent_id);

CREATE INDEX idx_links_source
ON links(source_object_id);

CREATE INDEX idx_links_target
ON links(target_object_id);

CREATE INDEX idx_properties_object
ON object_properties(object_id);

CREATE INDEX idx_tags_slug
ON tags(slug);
```

Use query plans before adding additional indexes.

---

# 41. UUID Strategy

Use UUID/UUID-like opaque identifiers.

Example:

```text
550e8400-e29b-41d4-a716-446655440000
```

IDs must not encode:

```text
type
timestamp
title
username
```

Object identity must remain stable even when metadata changes.

---

# 42. Transactions

Object creation:

```text
BEGIN
 │
 ├── create object
 ├── create properties
 ├── create initial blocks
 ├── create tags
 └── update search index
 │
COMMIT
```

Failure:

```text
ROLLBACK
```

Do not allow partially-created objects.

---

# 43. Autosave

Do not:

```text
keypress
 ↓
HTTP POST
```

Instead:

```text
keypress
 ↓
local state mutation
 ↓
dirty = true
 ↓
debounce 300–1000 ms
 ↓
batch save
```

For heavy editing:

```text
save on idle
+
save on blur
+
save on navigation
```

---

# 44. Editor State

Separate:

```text
Persistent State
```

from:

```text
Ephemeral UI State
```

Persistent:

```text
object
blocks
properties
links
```

Ephemeral:

```text
selectedBlock
cursor
slashMenuOpen
slashQuery
modalOpen
sidebarOpen
dragState
```

Never persist UI state as domain data.

---

# 45. Editor Transactions

Every mutation should be representable as an operation.

Examples:

```typescript
type EditorOperation =
    | InsertBlock
    | DeleteBlock
    | UpdateBlock
    | MoveBlock
    | SetProperty
    | CreateLink
    | DeleteLink;
```

This creates a clean path toward:

```text
undo/redo
autosave
sync
audit/debugging
```

---

# 46. Undo / Redo

MVP:

```text
in-memory operation stack
```

```text
undoStack
redoStack
```

Operation:

```text
before
+
after
```

Example:

```text
UpdateBlock
{
    blockId,
    before,
    after
}
```

Future:

```text
operation log
```

Do not implement CRDT unless real-time multi-user collaboration becomes a requirement.

---

# 47. Offline-first Preparation

MVP does not need full offline sync.

However, domain APIs must be designed so that:

```text
saveObject()
saveBlock()
createLink()
deleteBlock()
```

are deterministic commands.

Future:

```text
Client
 │
 ├── local database
 ├── operation queue
 │
 ▼
Sync API
 │
 ▼
Server
```

---

# 48. Sync Model

Future synchronization model:

```text
Local Mutation
      ↓
Operation Queue
      ↓
Network
      ↓
Server
      ↓
Acknowledgement
      ↓
Mark operation synced
```

Conflict strategy for personal knowledge management:

```text
last-write-wins
```

unless a specific data type requires stronger conflict handling.

Do not implement distributed CRDT infrastructure for the demo.

---

# 49. AI Architecture

AI is not part of the core editor.

Separate:

```text
Core App
+
AI Layer
```

AI pipeline:

```text
Object / Block
      ↓
extract text
      ↓
embedding job
      ↓
embedding provider
      ↓
vector storage
```

Future:

```text
User Query
     ↓
Hybrid Search
     ├── FTS
     └── Vector
     ↓
Reranking
     ↓
Context Assembly
     ↓
LLM
     ↓
Answer + Object References
```

---

# 50. Embedding Storage

Future PostgreSQL:

```text
object_embeddings
-----------------
object_id
chunk_id
embedding
model
created_at
updated_at
```

For MVP, semantic search is optional.

Do not introduce vector databases before there is enough data to justify them.

---

# 51. Media Pipeline

Future:

```text
Upload
  ↓
Object/File
  ↓
Metadata extraction
  ↓
Text extraction
  ↓
Optional AI analysis
  ↓
Embedding
```

Workers should process expensive operations asynchronously.

---

# 52. Async Job Architecture

Future:

```text
API
 │
 ▼
Queue
 │
 ├── embedding
 ├── PDF extraction
 ├── image analysis
 ├── audio transcription
 └── AI generation
      │
      ▼
    Worker
      │
      ▼
 Database
```

The HTTP request must not wait for expensive AI operations.

---

# 53. API Architecture

REST API:

```text
/api/v1/spaces
/api/v1/spaces/:id            (PATCH rename/re-icon, DELETE only when empty or ?force=1)

/api/v1/objects
/api/v1/objects/:id
/api/v1/objects/:id/blocks
/api/v1/objects/:id/properties
/api/v1/objects/:id/links

/api/v1/structures
/api/v1/structures/:id
/api/v1/tags
/api/v1/search
/api/v1/collections
```

Every space-scoped route (`objects`, `structures`, `tags`, `search`) reads the
active space from the `X-Space-Id` header (§39b).

---

# 54. API Response Format

Success:

```json
{
    "data": {},
    "meta": {}
}
```

Error:

```json
{
    "error": {
        "code": "OBJECT_NOT_FOUND",
        "message": "Object not found"
    }
}
```

Never expose raw database errors to clients.

---

# 55. Validation

Validate at API boundary.

Recommended:

```text
Zod
```

Pipeline:

```text
HTTP
 ↓
Zod validation
 ↓
Controller
 ↓
Service
 ↓
Repository
```

Do not trust:

```text
browser
frontend
client-side validation
```

as a security boundary.

---

# 56. Service Layer

Example:

```typescript
class ObjectService {

    async createObject(input) {}

    async getObject(id) {}

    async updateObject(id, input) {}

    async deleteObject(id) {}

    async getBacklinks(id) {}

    async getLinkedObjects(id) {}
}
```

Services own business rules.

Repositories own persistence.

---

# 57. Repository Layer

Repository example:

```typescript
interface ObjectRepository {
    findById(id: string): Promise<ObjectEntity | null>;

    create(input: CreateObjectInput): Promise<ObjectEntity>;

    update(
        id: string,
        input: UpdateObjectInput
    ): Promise<ObjectEntity>;

    delete(id: string): Promise<void>;
}
```

Do not expose raw SQL to UI components.

---

# 58. Security

Required:

```text
parameterized SQL
input validation
HTML sanitization
XSS prevention
CSRF protection where applicable
secure cookies
content security policy
file upload validation
rate limiting
```

Never:

```typescript
innerHTML = userInput
```

without sanitization.

---

# 59. Content Security

User-generated content includes:

```text
HTML
Markdown-like text
links
code
SVG
Mermaid
images
files
```

Treat all as untrusted.

Code is displayed as text.

Do not execute code blocks.

Mermaid/SVG output must be sanitized appropriately.

---

# 60. Routing

MVP routes:

```text
/
 /inbox
 /daily
 /search
 /objects/:id
 /objects/:id?view=preview
 /objects/:id?view=sidepanel
 /settings
```

The canonical identity is:

```text
object ID
```

not:

```text
title
```

---

# 61. Daily Notes

Daily note is a special object generated from date.

Concept:

```text
2026-09-15
     ↓
deterministic daily-note identity
```

Example:

```text
structure = daily_note
date = 2026-09-15
```

Use a unique constraint:

```text
structure_id + date
```

to prevent duplicates.

---

# 62. Calendar

Calendar is a view over objects containing date properties.

Do not create a separate calendar database.

```text
Objects
   ↓
date property
   ↓
Calendar Query
   ↓
Calendar UI
```

---

# 63. Object Graph UI

Graph visualization is a derived view.

```text
Objects
+
Links
 ↓
Graph Query
 ↓
Nodes + Edges
 ↓
Graph renderer
```

Never make the visualization itself the source of truth.

---

# 64. Drag and Drop

Block movement:

```text
drag
 ↓
calculate target parent
 ↓
calculate target position
 ↓
EditorOperation.MoveBlock
 ↓
transaction
 ↓
render
```

Do not directly manipulate database rows from drag handlers.

---

# 65. Keyboard Architecture

Global shortcuts:

```text
Ctrl/Cmd + K
    Search

Ctrl/Cmd + P
    Command palette

Ctrl/Cmd + S
    Force save

Ctrl/Cmd + Z
    Undo

Ctrl/Cmd + Shift + Z
    Redo

@
    Object mention

[[
    Object link

/
    Block command
```

Editor-specific keyboard handling must not interfere with browser-native behavior unless explicitly required.

---

# 66. Command Palette

There are two distinct concepts:

```text
Slash Menu
```

for inserting content.

and:

```text
Global Command Palette
```

for application actions.

Example:

```text
Ctrl + K

Search pages
Create object
Open daily note
Toggle sidebar
Change theme
Export
Settings
```

Keep these systems separate.

---

# 67. UI Component Tree

```text
AppShell
│
├── TitleBar
│   ├── SpaceSwitcher        (space icon + name → panel: search, space list with ✓, create space)
│   ├── SidebarToggle
│   ├── HistoryNav           (back / forward over visited object ids)
│   ├── TabStrip             (one tab per open object, close per tab, "+" = type picker)
│   └── Actions              (search palette, theme toggle)
│
├── Sidebar
│   ├── PrimaryNav           (New, Search, Explore, Calendar, Pinned)
│   ├── TypeList             (one row per structure + live object count)
│   ├── PinnedList           (browser preference — localStorage, not an object property)
│   ├── RecentList
│   ├── TagChips
│   └── Footer               (settings, workspace, quick create)
│
├── MainView
│   ├── ListView             (Explore / Calendar / Pinned / one type / one tag)
│   └── PageShell
│       ├── PageHeader       (icon, title, description, properties, pin, info toggle)
│       ├── BlockEditor      (heading level badge, ＋/✕ gutter, slash menu, markdown shortcuts)
│       └── PageFooter
│
├── InfoPanel                (properties, tags, linked objects, backlinks)
│
├── OverlayLayer
│   ├── SearchPalette        (Ctrl+K)
│   ├── ObjectTypePicker     (Ctrl+N, "+", FAB; Shift+Enter opens the full form)
│   ├── SettingsModal        (Appearance, Space settings, Object types)
│   └── Modal                (new object with a markdown-lite body)
│
└── FloatingActionButton
```

Shell rules:

- The active space is server state: every request carries `X-Space-Id`, and switching drops tabs, history and the open object (§39b).
- Objects are fetched once per session; **Explore, type, tag, Pinned and Calendar views filter that list client-side**. Never re-query per view.
- Tabs and back/forward history are ephemeral UI state. They are not domain data and are not persisted.
- Pinned object ids and the theme mode are **browser preferences** (`localStorage`, `nt-*` keys); pins are keyed per space. Pinning must never write to the object row.
- Object-type tiles get a deterministic colour from the type slug — same slug, same colour, no persisted palette.
- Editing a type (name/icon) goes through `PATCH /api/v1/structures/:id`; the slug follows the name and collisions get an id suffix.

---

# 68. State Management

Use small stores.

```text
appStore
editorStore
searchStore
navigationStore
modalStore
```

Do not create one giant:

```text
globalStore
```

State should be scoped.

---

# 69. Persistence Contract

UI should only know:

```typescript
objectService
blockService
searchService
```

UI must not know:

```text
SQLite
PostgreSQL
SQL
Kysely
FTS5
```

This makes migration possible.

---

# 70. SQLite → PostgreSQL Migration

The following must remain database-independent:

```text
Object IDs
Structure IDs
Property schema
Block schema
Link schema
Query model
Service API
```

Only replace:

```text
repositories
database migrations
search implementation
```

---

# 71. Performance Targets

MVP target:

```text
Initial UI render       < 1s
Object open             < 100ms local
Block insertion         < 16ms perceived
Slash menu response     < 16ms
Local search            < 100ms
Autosave                 < 1s after idle
```

For large pages:

```text
100 blocks     normal
1,000 blocks   acceptable
10,000 blocks  require optimization
```

Do not optimize before profiling.

---

# 72. Large Page Strategy

If page becomes large:

```text
virtualized block rendering
```

can be introduced.

However, do not virtualize the editor in MVP if it complicates:

```text
selection
cursor
keyboard navigation
nested blocks
```

Correctness first.

---

# 73. Caching

MVP:

```text
browser memory
```

Future:

```text
IndexedDB
```

Cache:

```text
recent objects
recent searches
object metadata
```

Do not cache sensitive or mutable data without an invalidation strategy.

---

# 74. Seed Data

Do not use Faker for deterministic demo data.

Use:

```text
seed
+
PRNG
```

Example:

```text
mulberry32(seed)
```

This gives:

```text
same seed
    ↓
same demo dataset
```

Useful for:

```text
screenshots
testing
benchmarks
E2E tests
development
```

---

# 75. Demo Dataset

Seed:

```text
50 Pages
20 Books
20 People
30 Topics
10 Projects
100 Tags
500 Links
1,000 Blocks
```

Generate deterministic relationships.

Example:

```text
Book
 ├── authored_by → Person
 ├── discusses → Topic
 └── related_to → Book
```

---

# 76. Testing Strategy

## Unit

Test:

```text
block tree
position calculation
slash parser
markdown shortcuts
query parser
link creation
backlinks
property validation
```

## Integration

Test:

```text
ObjectService
BlockService
SearchService
SQLite repositories
transactions
```

## E2E

Test:

```text
create page
type content
slash command
insert code block
edit code
create object link
open backlink
search object
change property
delete block
undo
```

---

# 77. Critical Invariants

### Object

```text
Every object has exactly one structure.
```

### Block

```text
Every block belongs to exactly one object.
```

### Parent

```text
A block parent must belong to the same object.
```

### Link

```text
Source and target objects must exist.
```

### Property

```text
Property definition must belong to object's structure.
```

### Position

```text
Sibling ordering must be deterministic.
```

These invariants must be enforced at the service/database level.

---

# 78. Error Handling

Domain errors:

```text
ObjectNotFound
StructureNotFound
BlockNotFound
InvalidBlockParent
InvalidProperty
LinkTargetNotFound
DuplicateObject
InvalidQuery
```

API maps them to:

```text
404
400
409
422
500
```

Never return stack traces in production.

---

# 79. Logging

Structured logs:

```json
{
    "level": "info",
    "event": "block.updated",
    "objectId": "...",
    "blockId": "...",
    "timestamp": "..."
}
```

Avoid logging:

```text
password
tokens
OAuth secrets
private content
```

unless explicitly required and safely redacted.

---

# 80. Observability

Future:

```text
request latency
database latency
search latency
editor save latency
error rate
queue depth
embedding failures
```

Primary metrics:

```text
p50
p95
p99
```

---

# 81. Deployment

MVP:

```text
Docker
 ├── app
 └── sqlite volume
```

Production:

```text
Reverse Proxy
      │
      ▼
Node.js API
      │
      ├── PostgreSQL
      ├── Redis/Queue
      └── Object Storage
```

Do not introduce Kubernetes for the demo.

---

# 82. Production Architecture

Future:

```text
                    CDN
                     │
                     ▼
              Web Application
                     │
                     ▼
                API Gateway
                     │
              ┌──────┴──────┐
              ▼             ▼
          API Server      WebSocket
              │
       ┌──────┼───────────┐
       ▼      ▼           ▼
   PostgreSQL Queue   Object Storage
       │      │
       │      ▼
       │    Workers
       │      │
       │   ┌──┴─────┐
       │   ▼        ▼
       │ Embedding  AI
       │
       ▼
   Search / Graph
```

This architecture is intentionally deferred.

---

# 83. Explicit Non-Goals

MVP does NOT implement:

```text
real-time multiplayer editing
CRDT
Graph database
microservices
Kubernetes
custom vector database
custom programming language parser
custom LaTeX renderer
custom diagram renderer
full offline sync
complex permissions
enterprise RBAC
```

---

# 84. Implementation Phases

## Phase 0 — Foundation

```text
TypeScript
Express
Alpine.js
SQLite
Kysely
Zod
```

Deliver:

```text
app shell
database
API
seed system
```

---

## Phase 1 — Object System

Implement:

```text
spaces
structures
objects
properties
tags
```

Deliver:

```text
create/read/update/delete object
```

---

## Phase 2 — Page

Implement:

```text
PageShell
PageHeader
Title
Description
Properties
```

Deliver:

```text
open object as page
```

---

## Phase 3 — Block Engine

Implement:

```text
paragraph
heading
todo
quote
divider
```

Deliver:

```text
nested blocks
reorder
delete
insert
```

---

## Phase 4 — Editor Commands

Implement:

```text
/
markdown shortcuts
@
[[
```

Deliver:

```text
slash menu
object picker
link picker
```

---

## Phase 5 — Specialized Blocks

Implement:

```text
CodeMirror
KaTeX
Mermaid
image
table
```

---

## Phase 6 — Search

Implement:

```text
SQLite FTS5
exact matching
ranking
filters
```

---

## Phase 7 — Graph

Implement:

```text
links
backlinks
related objects
graph traversal
```

---

## Phase 8 — Collections

Implement:

```text
query AST
saved queries
collections
```

---

## Phase 9 — Polish

Implement:

```text
keyboard navigation
undo/redo
autosave
drag/drop
responsive layout
dark/light theme
loading states
error states
```

---

## Phase 10 — Offline

Replace:

```text
server-first persistence
```

with:

```text
local-first
+
sync queue
```

Use IndexedDB/local DB where justified.

---

## Phase 11 — AI

Add:

```text
embeddings
hybrid search
RAG
AI object creation
media analysis
```

Only after the core object/block system is stable.

---

# 85. Recommended MVP Stack

Final MVP stack:

```text
Frontend
────────
Alpine.js
TypeScript
HTML
CSS

Editor
──────
contenteditable
CodeMirror 6
KaTeX
Mermaid

Backend
───────
Node.js
Express.js
TypeScript
Zod
Kysely

Database
────────
SQLite
FTS5

Utilities
─────────
Fuse.js
UUID
mulberry32

Testing
───────
Vitest
Playwright

Deployment
──────────
Docker
```

---

# 86. Architectural Decision Records

## ADR-001 — Object-first model

Decision:

```text
Object is the primary domain entity.
```

Reason:

```text
Page
Book
Person
Topic
Project
```

can share:

```text
properties
links
tags
content
```

---

## ADR-002 — Relational database

Decision:

```text
SQLite → PostgreSQL
```

Reason:

```text
simple
portable
transactional
cheap
excellent indexing
recursive SQL
```

Do not introduce graph DB merely because the domain contains links.

---

## ADR-003 — Block-based content

Decision:

```text
Content = ordered tree of blocks
```

Reason:

```text
nested editing
reordering
specialized blocks
object references
future transformations
```

---

## ADR-004 — CodeMirror for code blocks

Decision:

```text
CodeMirror 6
```

Reason:

```text
modular
lightweight
extension architecture
syntax highlighting
autocomplete
embedded-editor friendly
```

Monaco is not required for this application.

---

## ADR-005 — Specialized rendering

Decision:

```text
Code → CodeMirror
Math → KaTeX
Diagram → Mermaid
```

Reason:

Do not reinvent mature language/rendering engines.

---

## ADR-006 — No CRDT in MVP

Decision:

```text
No CRDT
```

Reason:

Application is primarily personal/local knowledge management.

Use operation-based undo/redo and deterministic persistence first.

---

## ADR-007 — Deterministic demo data

Decision:

```text
seeded PRNG
```

Reason:

```text
reproducibility
testing
debugging
benchmarking
screenshots
```

---

# 87. Final Mental Model

The entire application can be reduced to:

```text
                 ┌──────────────┐
                 │    OBJECT    │
                 └──────┬───────┘
                        │
         ┌──────────────┼──────────────┐
         │              │              │
         ▼              ▼              ▼
    PROPERTIES       CONTENT         LINKS
         │              │              │
         │              ▼              │
         │         BLOCK TREE          │
         │              │              │
         │     ┌────────┼────────┐     │
         │     ▼        ▼        ▼     │
         │   TEXT      CODE     MATH   │
         │              │        │     │
         │             CM6     KaTeX   │
         │                              │
         └──────────────┬───────────────┘
                        │
                        ▼
                  SEARCH / QUERY
                        │
              ┌─────────┴─────────┐
              ▼                   ▼
             FTS              GRAPH
              │                   │
              └─────────┬─────────┘
                        ▼
                       AI
```

The key architectural rule is:

```text
OBJECT
    ↓
CONTENT
    ↓
BLOCKS
```

not:

```text
PAGE
    ↓
HTML
```

And:

```text
OBJECT
    ↓
LINKS
    ↓
GRAPH
```

not:

```text
FOLDER
    ↓
PAGE
```

The editor is therefore a **domain-specific block engine**, while CodeMirror/KaTeX/Mermaid are specialized engines embedded into individual block types.

This keeps the application small enough for a demo while preserving a credible migration path toward:

```text
SQLite
  ↓
PostgreSQL
  ↓
Offline-first
  ↓
Queue / Workers
  ↓
Embeddings
  ↓
Hybrid Search
  ↓
RAG / AI
```

without rewriting the Object, Property, Block, and Link domain model.
