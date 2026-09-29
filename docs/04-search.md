# 04 — Tìm kiếm (FTS5 + lớp native Tantivy)

## Pipeline chính (luôn chạy): SQLite FTS5

- `search_index` là **projection** (không phải nguồn): title + description + block text + tags.
- `search-index-service.ts`: mọi write tới object/block/tag → `indexObject()`; boot server chạy `reindexAll()` để heal.
- `search-service.ts` — gatherer kết hợp:
  1. **FTS5 prefix** (`"rust"* AND "own"*` — mọi term bắt buộc, prefix match) trên search_index.
  2. **LIKE fallback** 3 nhánh: title/description, tags, body — bắt substring giữa từ & chữ có dấu mà tokenizer FTS5 không với tới.
  - Tất cả gatherer đều scoped theo space.
- **Ranking** (§35 architect): `title_exact > title_prefix > title_substring > body > tag`, kèm snippet `[marker]` quanh term trúng.

## Lớp native (tuỳ chọn, mặc định bật nếu đã build): Rust + Tantivy qua napi-rs

**Nguồn gốc**: `rust-lib/` (AppFlowy core) không được dùng như backend (xem `01-architecture.md`), nhưng `flowy-search` bên trong nó **wrap Tantivy**. Thay vì kéo nguyên core, `search-native/` là crate napi-rs mới **wrap Tantivy — cùng phiên bản mà rust-lib pin (0.24.x)**.

**Vai trò**: index **phụ**. SQLite vẫn là source of truth; lớp native chỉ thêm **object id** chịu typo/prefix vào danh sách ứng viên. Phân loại match, filter space/structure/tag, ranking, snippet — tất cả vẫn ở TS nên **API & schema không đổi**.

- Crate: `search-native/` — `#[napi]` `init_index`, `index_add` (upsert), `index_delete`, `index_search` (prefix **OR** fuzzy ≤1 edit, title boost 5×, tags 2.5×, body 1×), `index_count`.
- Build: `npm run build:native` (`cd search-native && cargo build --release` + copy → `search-native/search-native.node`).
- Loader: `src/search/native-search.ts` — chạy qua `createRequire`; **tự tắt** nếu: file `.node` không tồn tại hoặc `NT_NATIVE_SEARCH=0`.
- Dữ liệu index: `data/tantivy/` (overridable `NT_TANTIVY_DIR`).
- Wiring:
  - `search-index-service` → mirror upsert/delete vào Tantivy (no-op khi thiếu `.node`).
  - `search-service` → union id từ native vào candidate pool (FTS5 vẫn là chính).
  - `server.ts` → init native trước `reindexAll()` và log "native search: enabled (tantivy)".
- Query typo thật: tìm `notetakr` vẫn ra "Notetaker" (FTS5 prefix `notetakr*` sẽ trượt, LIKE cũng trượt).

## Toolchain Rust — lưu ý

- **rustup chọn toolchain theo cwd**, không theo `--manifest-path`. Vì vậy `build:native` phải chạy từ bên trong thư mục crate.
- `rust-toolchain.toml` ở root pin **1.85** (cho rust-lib); `search-native/rust-toolchain.toml` pin **1.96** — crate này resolve dependency mới (napi, tantivy) cần rustc ≥ 1.88.

## Test

- `tests/search-service.test.ts` — FTS5 pipeline, không phụ thuộc native.
- `tests/native-search.test.ts` — smoke Tantivy; **tự skip** nếu chưa build `.node` (suite luôn xanh dù có hay không có native).