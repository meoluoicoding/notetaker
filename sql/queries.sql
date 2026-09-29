-- =========================================================
-- Notetaker — SQL query inventory (mapping sang các service/Kysely)
-- Chạy thủ công trong bất kỳ sqlite client nào, hoặc:
--   npm run sql:check   (chạy EXPLAIN QUERY PLAN cho từng query)
-- =========================================================

-- Không tồn tại file SQL "chuẩn" chạy chính thức: app truy vấn qua Kysely
-- (src/services/*). Đây là bản dịch để review/kiểm tra index & plan.

-- ---------- 1. listObjects by space (search-index/list view) ----------
-- service: objectService.listObjects
SELECT * FROM objects
WHERE  space_id = :spaceId
ORDER  BY updated_at DESC
LIMIT   :limit;

-- ---------- 2. listObjects by structure (sidebar filter) ----------
SELECT * FROM objects
WHERE  structure_id = :structureId
ORDER  BY updated_at DESC
LIMIT  :limit;

-- ---------- 3. listObjects by tag slug (sidebar "Tags") ----------
SELECT objects.*
FROM   objects
       JOIN object_tags ON object_tags.object_id = objects.id
       JOIN tags        ON tags.id = object_tags.tag_id
WHERE  tags.slug = :tagSlug
  AND  objects.space_id = :spaceId
ORDER  BY objects.updated_at DESC
LIMIT  :limit;

-- ---------- 4. hydrate object meta (open page) ----------
-- service: objectService.hydrate — object + structure + property rows + tags + count
SELECT * FROM objects WHERE id = :objectId;                       -- structure join:
SELECT * FROM structures WHERE id = :structureId;
SELECT property_definitions.name, property_definitions.slug, object_properties.value_json
FROM   object_properties
       JOIN property_definitions ON property_definitions.id = object_properties.property_id
WHERE  object_properties.object_id = :objectId;
SELECT tags.name FROM object_tags JOIN tags ON tags.id = object_tags.tag_id
WHERE object_tags.object_id = :objectId;
SELECT count(*) AS count FROM blocks WHERE object_id = :objectId;

-- ---------- 5. blocks of an object (tree) ----------
SELECT * FROM blocks WHERE object_id = :objectId ORDER BY position ASC;

-- ---------- 6. backlinks / linked ----------
-- service: objectService.getBacklinks / getLinkedObjects
SELECT source_object_id FROM links WHERE target_object_id = :objectId;   -- rồi hydrate từng object
SELECT target_object_id FROM links WHERE source_object_id = :objectId;

-- ---------- 7. FTS5 candidates (search-service.ftsCandidates) ----------
SELECT search_index.object_id AS objectId
FROM   search_index
       JOIN objects ON objects.id = search_index.object_id
WHERE  search_index MATCH :ftsQuery          -- e.g. "rust"* AND "own"*
  AND  objects.space_id = :spaceId;

-- ---------- 8. LIKE fallbacks (substring/accents FTS5 không với tới) ----------
SELECT * FROM objects
WHERE space_id = :spaceId
  AND (lower(title) LIKE :pattern ESCAPE '\' OR lower(coalesce(description,'')) LIKE :pattern ESCACE '\');

SELECT tags.name FROM tags
WHERE tags.space_id = :spaceId AND lower(tags.name) LIKE :pattern ESCAPE '\';

SELECT search_index.object_id AS objectId
FROM search_index
     JOIN objects ON objects.id = search_index.object_id
WHERE lower(search_index.body) LIKE :pattern ESCAPE '\'
  AND objects.space_id = :spaceId;

-- ---------- 9. tags listing with counts (sidebar/settings) ----------
SELECT tags.id, tags.name, tags.slug, count(object_tags.object_id) AS count
FROM   tags
       LEFT JOIN object_tags ON object_tags.tag_id = tags.id
WHERE  tags.space_id = :spaceId
GROUP  BY tags.id
ORDER  BY tags.name ASC;

-- ---------- 10. daily note lookup (openToday — unique per structure+date) ----------
SELECT * FROM objects WHERE structure_id = :dailyStructureId AND title = :title;

-- ---------- 11. space listing with counts ----------
-- service: spaceService.listSpaces
SELECT objects.space_id AS space_id, count(*) AS count FROM objects GROUP BY space_id;
SELECT structures.space_id AS space_id, count(*) AS count FROM structures GROUP BY space_id;

-- ---------- 12. blocks by parent (blockRows load) ----------
SELECT * FROM blocks WHERE object_id = :objectId AND parent_id = :parentId ORDER BY position ASC;