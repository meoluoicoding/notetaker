# Feature / function specs (for agents)

Folder này chứa các spec **Playwright ngắn** để kiểm tra từng chức năng của app —
khác với `e2e/tests` (suite 62 test đầy đủ về editor), ở đây đúng nghĩa "feature
và function": mỗi spec một chức năng, chạy nhanh, agent nào cũng chạy được.

## Chạy

```bash
npm run e2e:features          # headless
npx playwright test --config=playwright.features.config.ts --ui   # xem thị giác
```

- **Cô lập hoàn toàn**: port `3457`, DB riêng `data/features.db` (tự seed demo lần đầu),
  index Tantivy riêng (`data/tantivy-features`). Không đụng `data/notetaker.db` / `e2e.db`.
- Mỗi test tự dọn dữ liệu tạo ra (xóa object/space qua API) — chạy lặp được.

## Các feature được phủ

| Spec | Chức năng |
|---|---|
| `search-native.spec.ts` | Search đúng/prefix; **typo "notetakr" → "Notetaker MVP"** (chỉ khi native Tantivy đã build — tự skip nếu chưa); palette Ctrl+K |
| `snippet-theme.spec.ts` | Nút "Aa" code block: xoay `auto → dark → light → auto` + persist; **đổi theme app không remount CodeMirror** (giữ editor/undo) |
| `properties.spec.ts` | Right panel: sửa `status`/`due` của Project, API lưu đúng, giá trị còn lại không đổi |
| `spaces.spec.ts` | Tạo space (seed tự type "Page"), switcher lọc/chuyển space, xoá space (force) |
| `settings.spec.ts` | Appearance (light/dark/system + persist qua reload), rename space qua Space settings, tạo object type mới + tạo object của type đó |

## Ghi chú cho agent

- **Native search phụ thuộc build**: chạy `npm run build:native` trước nếu muốn spec typo chạy.
  Không build → spec vẫn pass (test.skip qua `meta.native` của `/api/v1/search`).
- Nếu `npm run e2e:features` báo "PORT already in use 3457" → có server cũ đang chạy, kill trước.
- API helpers dùng chung với suite chính: `e2e/tests/api.ts`.