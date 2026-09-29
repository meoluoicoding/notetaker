# 03 — Frontend

Kho: `public/` được serve nguyên trạng — **không có build step**. Alpine lấy mã nguồn từ
`public/assets/app.js` (một component `app()` duy nhất, kiểu văn phòng phẩm của Alpine).

## File chính

| File | Vai trò |
|---|---|
| `assets/app.js` | Toàn bộ logic: state, views, editor, renderers, overlays, theme |
| `assets/block-registry.js` | `window.NTBlocks` — registry block (id, type, label, icon, defaults). Slash menu + toolbar "＋" đọc chung registry này |
| `assets/inline-marks.js` | `window.NTMarks` — quy đổi model `{text, marks}` ↔ contenteditable DOM |
| `assets/entry-rules.js` | `window.NTEntry` — luật nhập liệu thuần hàm (Enter/Backspace/Delete/paste/markdown) + `markdownToBlocks` |
| `assets/app.css` | Theme light/dark + mã màu code snippet |
| `index.html` | HTML + Alpine directives |

## App shell

- **Title bar**: nút space (mở space switcher), sidebar toggle, Settings, back/forward,
  tab strip, search (Ctrl+K), theme toggle.
- **Sidebar**: New/Search/Explore/Calendar/Pinned, danh sách object types, tags, recent, pinned.
- **Main**: list view (cards) ↔ page view (editor).
- **Right info panel**: meta + **properties editable theo loại** (status/due…) + tags + links/backlinks.
- **Overlays**: space switcher, search palette, object-type picker (`Ctrl+N`), new-object form,
  settings (Appearance / Space / Object types).
- Điều hướng bằng **tabs + back/forward history** (ephemeral — nằm trên component Alpine, không persisted).

## Block editor

- Content là **cây block** (`parent_id` + `position`), render phẳng theo `blockRows()` với độ sâu indentation.
- Block văn bản dùng contenteditable; mọi edit đọc lại thành model `{text, marks}` và autosave **debounce 500ms** (`queueBlockSave`) — không POST từng phím; blur/navigation gọi `flushBlockSaves`.
- Slash `/` mở inserter (pattern detection), chọn = **convert block in place** (PATCH type+content).
- Markdown shortcuts: `# `, `## `, `- `, `- [ ] `, `1. `, `> `, `---`, fences — qua `entry-rules.js` (1 grammar, 2 caller: paste + new-object form).
- Enter **split** block; Backspace merge; Delete kéo dòng sau lên; ArrowUp/Down nhảy block liền kề.
- Renderer blocks (code/math/mermaid/… ) mount qua `mountBlockRenderer` từ registry; CodeMirror/KaTeX/Mermaid dùng vendor local, CDN chỉ là fallback.
- **Undo/redo**: op-stack trong bộ nhớ (`undoStack`) — không dùng native browser undo cho text block.

## Theme & colorscheme code

- `data-theme` = `light` | `dark`; `data-theme-mode` = `light`|`dark`|`system` (hệ thống theo dõi `prefers-color-scheme`).
- Palette app qua CSS variables (`--bg`, `--text`, `--accent`, `--code-*`…).
- Code snippet dùng colorscheme riêng **`cm-s-nt`**: token + chrome đọc từ `--code-*` vars →
  đổi theme app là đổi màu tự động (không cần remount CodeMirror; giữ nguyên undo/scroll).
- Nút **"Aa"** trên toolbar code block: cycle `auto → dark → light → auto` cho **từng snippet**
  (lưu vào `content.snippetTheme` — persist sau reload, tương thích undo/redo).

## Chi tiết hơn

Entry rules (`architect.md §21b`), renderer & addon CM, tất cả quy tắc behavior — xem `skill.md §5`–`§5d`
và `architect.md` tương ứng.