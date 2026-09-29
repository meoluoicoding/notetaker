# 06 — Hiệu năng & native layer (phản hồi nhanh, tìm kiếm typo)

> Nguyên tắc từ architect §71: *"Do not optimize before profiling."* Các thay đổi dưới đây là những
> chỗ có chi phí đo được / dễ nhận thấy, không phải tối ưu sớm.

## 1. Memoize các phép tính "nóng" trong Alpine (`app.js`)

- `blockRows()` (dựng cây block + đánh số list) và `viewObjects()` (lọc danh sách) được Alpine
  đánh giá **nhiều lần mỗi flush**. Trước đây mỗi lần gõ phím rồi autosave flush là duyệt lại cả cây.
- Cache đặt **ngoài** reactive component (module-level plain object, giống `whiteboardRuntimes`)
  để tránh ghi vào proxy tự kích hoạt re-render:
  - `rowsCache` key theo reference của mảng `blocks` (load nguyên mảng → tự invalidate);
  - `viewCache` key theo `view|objects|pinnedIds|structures`;
  - `invalidateRows()` được gọi tại **mọi mutation in-place**: add/delete block, chuyển loại (slash/convert), undo/restore, lưu nội dung.
- Lợi ích: giảm số lần duyệt O(n)/flush; bớt write `_depth`/`_number` lên proxy.

## 2. Đổi theme không remount CodeMirror

- Trước: `remountRenderedBlocks()` destroy + dựng lại **toàn bộ** rendered block khi đổi theme
  (mất undo history/scroll của editor, giật màn hình).
- Sau: chỉ remount renderer **nhúng màu sinh ra từ nội dung** — Mermaid/PlantUML/D2 + whiteboard (tldraw).
  Code block & KaTeX giữ nguyên vì màu theo CSS vars (`cm-s-nt` đọc `--code-*`).

## 3. List dài

- `.object-card` thêm `content-visibility: auto` + `contain-intrinsic-size` → card ngoài viewport bỏ qua layout/paint (list ~200 objects).
- Autosave đã debounce 500ms sẵn (không POST từng phím) — giữ nguyên.

## 4. Native search (Tantivy) — chỉ thêm khi cần

- FTS5 + LIKE là pipeline chính, đủ nhanh cho local.
- `search-native/` (Rust + Tantivy, napi-rs) chạy **song song**, chỉ thêm candidate typo/prefix
  khi đã `npm run build:native`. Tắt bằng `NT_NATIVE_SEARCH=0`. Không đổi schema/API/DB.
- Nhớ: Rust build không nằm trong `npm i` — cần chạy `build:native` một lần (network + vài phút đầu tiên).

## 5. Nguyên tắc chung để giữ mượt

- UI state (tabs, drag, slash, undo) không bao giờ lưu vào domain data.
- Renderer mount một lần; đừng thêm x-text/x-effect nặng vào block-list.
- Khi thấy lag ở chỗ mới: **đo trước** (DevTools Performance / Playwright trace), rồi mới tối ưu.
- Thêm method Alpine thì phải thêm cùng lúc markup (ui-wiring test sẽ bắt).