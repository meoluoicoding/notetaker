# 05 — Quy trình phát triển

## Yêu cầu

- Node.js ≥ 20 (máy hiện tại: 24), npm 11.
- Rust: **1.96 (stable)** cho `search-native/`; `rust-lib/` cần 1.85 (đã pin trong `rust-toolchain.toml` root).
- Native search cần network lần đầu (cargo fetch từ crates.io).

## Lệnh thường dùng

```bash
npm run dev            # tsx src/server/server.ts — http://localhost:3000
npm run seed           # reset + seed deterministic
npm run test           # vitest run (unit/integration) — ~122 test
npm run typecheck      # tsc --noEmit (chỉ src/, frontend public/ không có typecheck)
npm run e2e            # playwright test (cấu hình playwright.e2e.config.ts)
npm run e2e:ui         # playwright --ui
npm run build:vendor   # bundle tldraw vendor (chỉ khi đổi tldraw)
npm run build:native   # build Rust search-native -> search-native/search-native.node (tuỳ chọn)
npm run build:ts       # esbuild bundle src/server/server.ts -> dist/index.mjs (artefact production)
npm run start          # build:ts rồi chạy node dist/index.mjs
```

> Không tồn tại build step cho frontend: `public/` serve nguyên trạng. Sửa `app.js/css` là đổi ngay sau refresh.
> `start` dùng esbuild (`--packages=external` giữ native module better-sqlite3), bundle thành `dist/index.mjs`
> — static serving vẫn resolve theo `process.cwd()` nên chạy từ thư mục gốc repo.

## Test

- Unit/integration (`tests/`) chạy với DB temp riêng (`process.env.DB_PATH` set trong từng test file) — không đụng `data/notetaker.db`.
- `tests/ui-wiring.test.ts` **quét index.html ↔ app.js**: method dùng trong Alpine directive mà thiếu trong `app()` → fail suite. Thêm method + markup cùng lúc.
- Search native: `tests/native-search.test.ts` tự skip nếu chưa build — giữ suite xanh trong cả 2 trạng thái.

## Dữ liệu

| Vị trí | Nội dung |
|---|---|
| `data/notetaker.db` | DB chính (dev/server) |
| `data/e2e.db` | DB e2e |
| `data/tantivy/` | index native Tantivy (tái tạo được từ DB) |
| `data/backup-pre-spaces/` | backup trước migration spaces |
| `data/*.bak-pre-spaces*` | snapshots cũ |

## Gotchas

1. **rustup toolchain theo cwd** — chạy `cargo` từ đúng thư mục (xem [`04-search.md`](./04-search.md)).
2. **Đừng thay stack** khi chưa được yêu cầu: architect §4 đóng băng Node/Express/Alpine/SQLite; lộ trình dài hạn là PostgreSQL + pgvector (§70).
3. **Không commit** trừ khi được yêu cầu (repo hiện chưa là git).
4. E2E cần server? `playwright.e2e.config.ts` tự quản lý (webServer) — xem cấu hình.
5. `npm run seed` xoá sạch DB — không chạy khi đang cần dữ liệu thật.