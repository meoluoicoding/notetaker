import { db } from "../db/client";

export interface TagWithCount {
  id: string;
  name: string;
  slug: string;
  count: number;
}

export class TagService {
  /** Tags are per space: the same tag name can exist in two spaces independently. */
  async listTags(spaceId: string): Promise<TagWithCount[]> {
    const rows = await db
      .selectFrom("tags")
      .leftJoin("object_tags", "object_tags.tag_id", "tags.id")
      .select((eb) => [
        "tags.id",
        "tags.name",
        "tags.slug",
        eb.fn.count("object_tags.object_id").as("count"),
      ])
      .where("tags.space_id", "=", spaceId)
      .groupBy("tags.id")
      .orderBy("tags.name", "asc")
      .execute();
    return rows.map((r) => ({ id: r.id, name: r.name, slug: r.slug, count: Number(r.count) }));
  }
}

export const tagService = new TagService();
