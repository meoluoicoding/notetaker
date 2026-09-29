# SQL query check

Bộ query "sự thật" của app + harness kiểm tra kế hoạch thực thi (EXPLAIN QUERY PLAN).

## Chạy

```bash
npm run sql:check                              # mặc định: benchmark/benchmark.db (cần npm run bench 1 lần)
SQL_DB=data/notetaker.db npm run sql:check     # check thẳng DB thật (readonly)
```

- **Read-only** (mở SQLite ở chế độ readonly).
- In số dòng từng bảng + plan của từng query hot; **⚠️** = có khả năng full-table scan
  (trừ các query được chú chú `expectedScan`: FTS5 MATCH, LIKE fallback — bản chất là scan/sẽ xảy ra).

## Files

| File | Nội dung |
|---|---|
| `queries.sql` | Inventory SQL (bản dịch các query Kysely trong `src/services/*`) kèm chú thích — đọc/chấm mắt được |
| `check.ts` | Harness: chạy EXPLAIN QUERY PLAN, đối chiếu với chỉ mục (`idx_objects_space`, `idx_objects_structure`, `idx_objects_updated`, `idx_blocks_object`, `idx_blocks_parent`, `idx_links_*`, `idx_properties_object`, FTS5 …) |

## Cách đọc plan

- `SEARCH ... USING INDEX idx_objects_space` → dùng chỉ mục, tốt.
- `SCAN objects` trên bảng lớn → nghi check (add index hay đổi query).
- FTS5 `SCAN ... USING VIRTUAL TABLE search_index ... MATCH` là chuẩn (FTS không phải bảng thường).
- LIKE `%…%` không dùng chỉ mục được — đây là fallback có chủ đích (accent/mid-word) cho FTS5.

## Khi nào thêm query mới

Thêm vào cả 2 nơi: service (`src/services/*`) + `queries.sql`/`QUERIES` trong `check.ts`,
rồi `npm run sql:check` để xác nhận plan dùng đúng index.