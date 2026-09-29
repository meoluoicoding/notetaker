# 02 — Backend

## Khởi động (`src/server/server.ts`)

1. `migrate()` — tạo/upgrade schema (DDL + migration nằm trong `src/db/client.ts`).
2. Nếu chưa có structure nào → `seedDatabase()` (dữ liệu demo deterministic, mulberry32).
3. (Optional) Init native Tantivy index nếu `.node` tồn tại — xem [`04-search.md`](./04-search.md).
4. `reindexAll()` — chữa lành FTS5 (và mirror vào Tantivy nếu có).
5. `app.listen(3000)`.

## API — tất cả dưới `/api/v1`

```
GET/POST            /spaces                     PATCH/DELETE /spaces/:id
GET/POST            /structures                 GET/PATCH /structures/:id
GET/POST            /objects                    GET/PATCH/DELETE /objects/:id
PATCH               /objects/:id/properties     (set/remove property values theo definition)
POST/DELETE         /objects/:id/links          GET /objects/:id/backlinks | /linked
GET/POST            /objects/:id/blocks         PATCH /blocks/:blockId, POST .../move, DELETE ...
GET                 /tags
GET                 /search?q=&spaceId=&structureId=&tag=&limit=
```

- **Space scoping**: header `X-Space-Id` (hoặc `?spaceId=`); không có thì dùng space cũ nhất.
  Mọi query list/count/search đều filter theo space.
- **Shape**: thành công `{ "data": …, "meta": … }`; lỗi `{ "error": { "code": …, "message": … } }`
  — không bao giờ log raw DB error/stack.
- **Mapping lỗi**: NotFound→404, Invalid→400/422, Duplicate→409 (`src/shared/errors.ts`).
- **Row shape**: trả về đúng tên cột DB (`structure_id`, `space_id`, `parent_id`…) — không remap camelCase
  (test `tests/object-shape.test.ts` pin điều này).

## Layering

```text
Routes → Services → Repos → DB
```

- `src/api/routes.ts` chỉ parse (Zod) + gọi service + serialize.
- Service giữ business rules; `block-service`, `object-service` dùng transaction để tạo atomic
  (object + properties + tags + blocks + search index, ROLLBACK nếu lỗi).
- Property validate theo `property_definitions` của structure; null/"" = xoá value.

## DB & migration

- **better-sqlite3** (đồng bộ, nhúng), **Kysely** query builder, Zod ở biên API.
- Migration thủ công trong `src/db/client.ts` (pattern: kiểm tra cột/bảng cũ → rebuild khi cần,
  e.g. đổi `tags`/`structures.slug` thành unique per space). Đã có backup `data/backup-pre-spaces/`.
- **FTS5**: bảng `search_index` là projection (title + description + block text + tags).
  Mọi write vào object/block/tag phải gọi `searchIndexService.indexObject` để heal.

## Seed

`npm run seed` → xoá sạch + seed deterministic bằng `mulberry32(42)`:
Page, Book (author/year/rating), Person, Topic, Project (status/due + links owner), Weekly notes…
`src/db/prng.ts` → cùng seed = cùng dữ liệu (phục vụ e2e/demo lặp lại).