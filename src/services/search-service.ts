import { sql } from "kysely";
import { db } from "../db/client";
import type { ObjectRow } from "../db/schema";
import { slugify } from "../shared/schemas";
import { getNativeSearch } from "../search/native-search";
import { objectService } from "./object-service";
import type { ObjectWithMeta } from "./object-service";

export type SearchMatchType = "title_exact" | "title_prefix" | "title_substring" | "body" | "tag";

export interface SearchHit {
  object: ObjectWithMeta;
  matchType: SearchMatchType;
  /** Excerpt of the matching body text (description or block content) for `body` hits. */
  snippet: string | null;
}

export interface SearchOptions {
  /** Restrict hits to one space. Omitted = search every space. */
  spaceId?: string;
  /** Restrict hits to one structure (object type). */
  structureId?: string;
  /** Restrict hits to objects carrying this tag slug (as used by `/tags` and `?tag=`). */
  tag?: string;
  limit?: number;
}

export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 50;

/** Ranking per architect.md §35: exact > prefix > substring > body > tag. */
const RANK: Record<SearchMatchType, number> = {
  title_exact: 0,
  title_prefix: 1,
  title_substring: 2,
  body: 3,
  tag: 4,
};

const SNIPPET_RADIUS = 48;

/** Split a query into normalized terms (unicode-aware, keeps Vietnamese diacritics). */
export function toTerms(query: string): string[] {
  return query.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
}

/** FTS5 expression requiring every term as a prefix match: `"rust"* AND "own"*`. */
export function toFtsQuery(query: string): string | null {
  const terms = toTerms(query);
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t}"*`).join(" AND ");
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function covers(text: string, terms: string[]): boolean {
  const lower = text.toLowerCase();
  return terms.length > 0 && terms.every((t) => lower.includes(t));
}

/** Mark the first matching term inside a window of `text` — plain markers, never HTML. */
export function buildSnippet(text: string, terms: string[], radius = SNIPPET_RADIUS): string | null {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  const lower = flat.toLowerCase();
  const at = terms.reduce((best, term) => {
    const i = lower.indexOf(term);
    return i >= 0 && (best < 0 || i < best) ? i : best;
  }, -1);
  if (at < 0) {
    // Matched through FTS5 diacritic folding ("bo nho" → "bộ nhớ"): no literal term to mark.
    return flat.length > radius * 2 ? `${flat.slice(0, radius * 2)}…` : flat;
  }
  const term = terms.find((t) => lower.indexOf(t) === at) ?? "";
  const start = Math.max(0, at - radius);
  const end = Math.min(flat.length, at + term.length + radius);
  const head = start > 0 ? "…" : "";
  const tail = end < flat.length ? "…" : "";
  return `${head}${flat.slice(start, at)}[${flat.slice(at, at + term.length)}]${flat.slice(at + term.length, end)}${tail}`;
}

export class SearchService {
  async search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const terms = toTerms(q);
    const limit = Math.min(Math.max(options.limit ?? SEARCH_DEFAULT_LIMIT, 1), SEARCH_MAX_LIMIT);
    const pattern = `%${escapeLike(q)}%`;

    // Candidate gathering: FTS5 prefix matching (title/body/tags columns) + LIKE
    // fallbacks for substrings the tokenizer cannot reach (mid-word, accents).
    // Every gatherer is scoped to the space so ids from other spaces never surface.
    // The optional Tantivy index adds typo/prefix-tolerant ids; space/type/tag
    // filtering still happens below on the union.
    const native = getNativeSearch();
    const nativeIds = native ? native.search(q, SEARCH_MAX_LIMIT).map((h) => h.id) : [];
    const [ftsIds, bodySubstringIds, tagIds, likeRows] = await Promise.all([
      this.ftsCandidates(q, options.spaceId),
      this.bodySubstringCandidates(pattern, options.spaceId),
      this.tagCandidates(pattern, options.spaceId),
      this.likeCandidates(pattern, options.spaceId),
    ]);

    const ids = Array.from(
      new Set([...ftsIds, ...bodySubstringIds, ...tagIds, ...likeRows.map((r) => r.id), ...nativeIds])
    );
    if (ids.length === 0) return [];

    const [rows, tagMap] = await Promise.all([this.fetchRows(ids, options.spaceId), this.tagsOf(ids)]);
    const matching = rows.filter(
      (row) =>
        (!options.spaceId || row.space_id === options.spaceId) &&
        (!options.structureId || row.structure_id === options.structureId) &&
        (!options.tag || (tagMap.get(row.id) ?? []).some((t) => this.matchesTag(t, options.tag!)))
    );

    const scored = matching.map((row) => ({
      row,
      matchType: this.classify(row, tagMap.get(row.id) ?? [], terms, q),
    }));
    scored.sort(
      (a, b) =>
        RANK[a.matchType] - RANK[b.matchType] ||
        b.row.updated_at.localeCompare(a.row.updated_at) ||
        a.row.title.localeCompare(b.row.title)
    );

    const top = scored.slice(0, limit);
    const bodies = await this.bodiesOf(top.filter((h) => h.matchType === "body").map((h) => h.row.id));

    const hits: SearchHit[] = [];
    for (const hit of top) {
      const object = await objectService.getObject(hit.row.id);
      if (!object) continue;
      hits.push({
        object,
        matchType: hit.matchType,
        snippet: hit.matchType === "body" ? buildSnippet(bodies.get(hit.row.id) ?? "", terms) : null,
      });
    }
    return hits;
  }

  /** Prefix/whole-term matches through FTS5 (title, body or tags column). */
  private async ftsCandidates(query: string, spaceId?: string): Promise<string[]> {
    const ftsQuery = toFtsQuery(query);
    if (!ftsQuery) return [];
    let q = db
      .selectFrom("search_index")
      .innerJoin("objects", "objects.id", "search_index.object_id")
      .select(["search_index.object_id as objectId"])
      .where(sql<boolean>`search_index match ${ftsQuery}`);
    if (spaceId) q = q.where("objects.space_id", "=", spaceId);
    const rows = await q.execute();
    return rows.map((r) => r.objectId);
  }

  /** Substring matches on title/description — covers queries FTS5 tokenization misses. */
  private async likeCandidates(pattern: string, spaceId?: string): Promise<ObjectRow[]> {
    let q = db
      .selectFrom("objects")
      .selectAll("objects")
      .where((eb) =>
        eb.or([
          sql<boolean>`lower(objects.title) like ${pattern} escape '\\'`,
          sql<boolean>`lower(coalesce(objects.description, '')) like ${pattern} escape '\\'`,
        ])
      );
    if (spaceId) q = q.where("objects.space_id", "=", spaceId);
    return q.execute();
  }

  private async tagCandidates(pattern: string, spaceId?: string): Promise<string[]> {
    let q = db
      .selectFrom("object_tags")
      .innerJoin("tags", "tags.id", "object_tags.tag_id")
      .select(["object_tags.object_id as objectId"])
      .where(sql<boolean>`lower(tags.name) like ${pattern} escape '\\'`);
    if (spaceId) q = q.where("tags.space_id", "=", spaceId);
    const rows = await q.execute();
    return rows.map((r) => r.objectId);
  }

  /** Mid-word text matches (`check` inside `checker`) that FTS5 prefix search cannot find. */
  private async bodySubstringCandidates(pattern: string, spaceId?: string): Promise<string[]> {
    let q = db
      .selectFrom("search_index")
      .innerJoin("objects", "objects.id", "search_index.object_id")
      .select(["search_index.object_id as objectId"])
      .where(sql<boolean>`lower(search_index.body) like ${pattern} escape '\\'`);
    if (spaceId) q = q.where("objects.space_id", "=", spaceId);
    const rows = await q.execute();
    return rows.map((r) => r.objectId);
  }

  private matchesTag(tagName: string, slug: string): boolean {
    return slugify(tagName) === slug || tagName.toLowerCase() === slug.toLowerCase();
  }

  private classify(row: ObjectRow, tags: string[], terms: string[], q: string): SearchMatchType {
    const title = row.title.toLowerCase();
    if (title === q) return "title_exact";
    if (title.startsWith(q)) return "title_prefix";
    if (title.includes(q) || covers(title, terms)) return "title_substring";
    if (covers(row.description ?? "", terms)) return "body";
    if (tags.some((t) => covers(t, terms))) return "tag";
    return "body";
  }

  private async fetchRows(ids: string[], spaceId?: string): Promise<ObjectRow[]> {
    let q = db.selectFrom("objects").selectAll().where("id", "in", ids);
    if (spaceId) q = q.where("space_id", "=", spaceId);
    return q.execute();
  }

  private async tagsOf(ids: string[]): Promise<Map<string, string[]>> {
    const rows = await db
      .selectFrom("object_tags")
      .innerJoin("tags", "tags.id", "object_tags.tag_id")
      .select(["object_tags.object_id", "tags.name"])
      .where("object_tags.object_id", "in", ids)
      .execute();
    const map = new Map<string, string[]>();
    for (const row of rows) {
      map.set(row.object_id, [...(map.get(row.object_id) ?? []), row.name]);
    }
    return map;
  }

  private async bodiesOf(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await db
      .selectFrom("search_index")
      .select(["object_id", "body"])
      .where("object_id", "in", ids)
      .execute();
    return new Map(rows.map((r) => [r.object_id, r.body]));
  }
}

export const searchService = new SearchService();
