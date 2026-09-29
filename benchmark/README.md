# Benchmark

Đo hiệu năng **bằng stack thật** (Kysely + SQLite + services + native Tantivy nếu có)
trên một scratch database riêng — **không bao giờ đụng** `data/notetaker.db`.

## Chạy

```bash
npm run bench                # seed 300 objects trong benchmark/benchmark.db
BENCH_N=1000 npm run bench   # scale lên
BENCH_N=60 npm run bench     # nhanh, xác nhận harness chạy
```

- Lần đầu tự seed deterministic (mulberry32, giống `src/db/prng.ts`) bằng services thật
  (nên cả FTS5 + Tantivy đều được điền).
- Bật native search thì `npm run build:native` trước — các bench search sẽ có cột riêng.
- Kết quả: bảng console + `benchmark/results/<timestamp>.json` + `latest.json` (để so lần chạy sau).

## Các scenario đo

| Label | Ý nghĩa |
|---|---|
| `createObject` | POST 1 object + 3 blocks + tags + index (write path) |
| `updateBlock` | sửa content 1 block + re-index |
| `getFullObject` | **mở trang**: hydrate meta + properties + tags + blockCount + blocks |
| `listObjects space / structure` | list view: fetch 100 objects |
| `search exact/prefix` | pipeline FTS5 + LIKE (chính xác/prefix) |
| `search typo` | fuzzy Tantivy union vào pipeline (chữa typo) |
| `native indexSearch` | gọi thẳng Tantivy (không qua TS) |
| `reindexAll` | heal toàn bộ index |

## Đọc kết quả

- Mục tiêu khuôn khổ architect §71: object open < 100ms local, block insert < 16ms,
  local search < 100ms. Với N=300 bạn nên thấy `avgMs` ở hàng chục/từng ms.
- `commit` Tantivy của `index_add`/`index_delete` là synchronous — tùy query, nếu cần mượt
  hơn có thể tách commit (xem `src/search/native-search.ts`).
- So sánh: giữ `latest.json` rồi đối chiếu `avgMs` khi đổi code.

## Cảnh báo

- Không chạy 2 instance bench đồng thời (cùng 1 index Tantivy).
- `benchmark/*.db*` và `benchmark/results/` đã được gitignore — kết quả là artefact máy bạn.