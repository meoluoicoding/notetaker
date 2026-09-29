export interface SpaceRow {
  id: string;
  name: string;
  icon: string | null;
  created_at: string;
  updated_at: string;
}

export interface StructureRow {
  id: string;
  /** Every object type belongs to exactly one space. */
  space_id: string | null;
  name: string;
  slug: string;
  icon: string | null;
  created_at: string;
  updated_at: string;
}

export interface ObjectRow {
  id: string;
  structure_id: string;
  /** Denormalized from the structure: one space per object, queryable without a join. */
  space_id: string | null;
  title: string;
  description: string | null;
  icon: string | null;
  cover_url: string | null;
  created_at: string;
  updated_at: string;
}

export interface PropertyDefinitionRow {
  id: string;
  structure_id: string;
  name: string;
  slug: string;
  type: string;
}

export interface ObjectPropertyRow {
  object_id: string;
  property_id: string;
  value_json: string | null;
}

export interface BlockRow {
  id: string;
  object_id: string;
  parent_id: string | null;
  position: number;
  type: string;
  content_json: string;
  created_at: string;
  updated_at: string;
}

export interface LinkRow {
  source_object_id: string;
  target_object_id: string;
  relation: string | null;
  created_at: string;
}

export interface TagRow {
  id: string;
  /** Tag names are unique per space, not globally. */
  space_id: string | null;
  name: string;
  slug: string;
}

export interface ObjectTagRow {
  object_id: string;
  tag_id: string;
}

/** FTS5 virtual table: flattened searchable text per object (not a source of truth). */
export interface SearchIndexRow {
  object_id: string;
  title: string;
  body: string;
  tags: string;
}

export interface DB {
  spaces: SpaceRow;
  structures: StructureRow;
  objects: ObjectRow;
  property_definitions: PropertyDefinitionRow;
  object_properties: ObjectPropertyRow;
  blocks: BlockRow;
  links: LinkRow;
  tags: TagRow;
  object_tags: ObjectTagRow;
  search_index: SearchIndexRow;
}
