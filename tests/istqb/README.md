# ISTQB-style tests

Bộ test áp **kỹ thuật thiết kế test chuẩn ISTQB** lên logic thật của app
(entry-rules, search-service, Zod schema, block), bổ trợ cho `entry-rules.test.ts`
và `search-service.test.ts` (không lặp case — làm đầy các kỹ thuật thay vì phủ lại).

| File | Kỹ thuật ISTQB | Đối tượng |
|---|---|---|
| `equivalence-partitioning.test.ts` | **Equivalence partitioning** — 1 đại diện mỗi lớp tương đương | `toTerms`, `toFtsQuery`, `enterAction`, `pasteHasBlocks`, `safeHref` |
| `boundary-value.test.ts` | **Boundary value analysis** — min/max/±1 | Zod schemas (title 500, description 2000, icon 32, tags 100, q 200, limit 1–50, position ≥0…) |
| `decision-table.test.ts` | **Decision table** — ma trận điều kiện → hành động | `enterAction` (8 tổ hợp), `markdownToBlocks` (bảng diễn giải marker) |
| `state-transition.test.ts` | **State transition** — sự kiện ↔ trạng thái | `numberListRows` (run/sublist/restart), `splitAt`/`joinInline` (marks qua biên), fence mở/đóng |
| `error-guessing.test.ts` | **Error guessing** — lỗi điển hình & bảo mật | injection query, javascript:/data: URL, offset NaN, input rỗng/lớn, fence không đóng |

## Ghi chú

- Hàm của `search-service` được import **dynamic sau khi set `DB_PATH` temp** (giống
  `search-service.test.ts`) — không bao giờ chạm `data/notetaker.db`.
- `entry-rules.js` được load qua sandbox (`new Function("window", …)`) như test cũ.
- Nếu thêm kỹ thuật/case quan trọng mới: thêm vào đúng file kỹ thuật, giữ 1 case trả lời
  1 lớp/miền (đừng đổ từng giá trị).