# Notetaker — Tài liệu

Ứng dụng ghi chú dạng **block-based / object-oriented** (inspiration: Capacities, AppFlowy).
Toàn bộ spec chi tiết nằm ở [`architect.md`](../architect.md) (source of truth), hướng dẫn cho agent ở
[`skill.md`](../skill.md). Các file trong `docs/` là bản tóm tắt dành cho người mới/team.

## Mục lục

| File | Nội dung |
|---|---|
| [`01-architecture.md`](./01-architecture.md) | Mô hình dữ liệu & kiến trúc tổng quan |
| [`02-backend.md`](./02-backend.md) | Backend: API, services, DB (SQLite/FTS5), migration |
| [`03-frontend.md`](./03-frontend.md) | Frontend: shell, block editor, theme & colorscheme |
| [`04-search.md`](./04-search.md) | Tìm kiếm: pipeline FTS5 + lớp native Tantivy (napi-rs) |
| [`05-development.md`](./05-development.md) | Quy trình dev: lệnh, test, build |
| [`06-performance.md`](./06-performance.md) | Các cải thiện hiệu năng & nguyên tắc |

## Bức tranh 30 giây

```text
SPACE → OBJECT → CONTENT → BLOCKS     (KHÔNG phải: PAGE → HTML)
SPACE → OBJECT → LINKS → GRAPH        (KHÔNG phải: FOLDER → PAGE)
```

- **Frontend**: Alpine.js + contenteditable (+ CodeMirror 5, KaTeX, Mermaid, PlantUML, D2, tldraw 5).
- **Backend**: Express + TypeScript + Kysely trên SQLite (better-sqlite3) + FTS5.
- **Search**: FTS5 là nguồn chính; có lớp **native Tantivy** (Rust qua napi-rs) **tuỳ chọn** — SQLite vẫn là source of truth.
- **Not build step** cho frontend: `public/` được serve nguyên trạng.