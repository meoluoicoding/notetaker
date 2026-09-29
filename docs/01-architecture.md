# 01 — Kiến trúc & Mô hình dữ liệu

## Mental model (không được quên)

```text
SPACE → OBJECT → CONTENT → BLOCKS      (note là object, không phải page/HTML)
SPACE → OBJECT → LINKS → GRAPH         (link là quan hệ, không phải folder)
```

- **Space**: container ngoài cùng (workspace). Object types, objects, tags đều thuộc đúng **một** space.
- **Object**: thực thể cơ bản (Page, Book, Person, Topic, Project…). Có đúng một **Structure** (kiểu/schema).
- **Page** chỉ là góc nhìn của một Object — không sở hữu content riêng.
- **Block**: cây có thứ tự → `parent_id + position` (integer position, MVP không dùng fractional indexing).

## Tech stack (đã đóng băng — không đổi nếu không được yêu cầu)

| Tầng | Lựa chọn |
|---|---|
| Frontend | Alpine.js + JS thuần + HTML/CSS (`public/assets/*.js`) |
| Editor | contenteditable + CodeMirror 5, KaTeX, Mermaid, PlantUML, D2, tldraw 5 (whiteboard) |
| Backend | Node.js + Express 5 + TypeScript |
| Validation | Zod (chỉ ở biên API) |
| DB access | Kysely (không ORM nặng) trên better-sqlite3 |
| Database | SQLite + FTS5 (lộ trình: PostgreSQL + pgvector, xem architect §70) |
| Test | Vitest (unit/integration), Playwright (e2e) |

> Chú thích: repo có `rust-lib/` — đây là **AppFlowy core** (workspace Cargo ~30 crates, pinned Rust 1.85)
> mang tính **tham khảo**, chưa được dùng làm backend. Lớp Rust *thực sự đang được dùng* là
> `search-native/` (napi-rs + Tantivy, xem [`04-search.md`](./04-search.md)).

## Sơ đồ thư mục

```text
src/
├── server/      app.ts (express + static/vendor), server.ts (boot: migrate → seed → reindex → listen)
├── api/         routes.ts, error-handler.ts, serializers.ts
├── services/    object, block, structure, space, tag, search, search-index
├── db/          client.ts (migrate + DDL), schema.ts (Kysely types), seed.ts, prng.ts
├── search/      native-search.ts (loader napi-rs Tantivy, optional)
└── shared/      schemas.ts (Zod), errors.ts

public/          serve nguyên trạng (không build): assets/app.js, block-registry.js, inline-marks.js, entry-rules.js, index.html, vendor/*
search-native/   crate napi-rs (Rust) — index Tantivy tuỳ chọn
docs/            tài liệu này
```

## Bảng dữ liệu chính

```text
spaces(id, name, icon, …)
structures(id, space_id, name, slug, icon)            slug unique PER SPACE
objects(id, space_id, structure_id, title, description, icon, …)
property_definitions(id, structure_id, name, slug, type)
object_properties(object_id, property_id, value_json)  PK (object_id, property_id)
blocks(id, object_id, parent_id, position, type, content_json)
links(source_object_id, target_object_id, relation)    PK 3 cột
tags(id, space_id, name, slug)
object_tags(object_id, tag_id)                         PK 2 cột
search_index(object_id, title, body, tags)             FTS5 — chỉ là projection (projection, không phải nguồn)
```

## Invariant quan trọng

1. Mỗi object có đúng 1 structure; structure phải thuộc space của object.
2. Mỗi block thuộc đúng 1 object; parent phải cùng object.
3. Link source/target phải tồn tại **và cùng space**.
4. Property value phải khớp property definition của structure.
5. Mỗi object property `value_json` là sự thật duy nhất — tách biệt khỏi UI state.
6. Space cuối cùng không thể xoá; tạo space mới sẽ seed sẵn 1 type "Page".

## Chú ý về UI state

- **Ephemeral, không bao giờ persisted như domain data**: tabs, history back/forward, drag state,
  slash menu, undo stack, right-panel open… chỉ sống trên component Alpine.
- **Browser preference (localStorage)**: `nt-theme-mode`, `nt-space-id`, `nt-pinned:<spaceId>`.