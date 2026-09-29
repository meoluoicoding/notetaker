export class DomainError extends Error {
  constructor(
    public readonly code:
      | "OBJECT_NOT_FOUND"
      | "STRUCTURE_NOT_FOUND"
      | "BLOCK_NOT_FOUND"
      | "INVALID_BLOCK_PARENT"
      | "INVALID_PROPERTY"
      | "LINK_TARGET_NOT_FOUND"
      | "DUPLICATE_OBJECT"
      | "SPACE_NOT_FOUND"
      | "SPACE_NOT_EMPTY"
      | "LAST_SPACE_REMAINING"
      | "INVALID_QUERY",
    message: string
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export const ERROR_STATUS: Record<DomainError["code"], number> = {
  OBJECT_NOT_FOUND: 404,
  STRUCTURE_NOT_FOUND: 404,
  BLOCK_NOT_FOUND: 404,
  INVALID_BLOCK_PARENT: 400,
  INVALID_PROPERTY: 422,
  LINK_TARGET_NOT_FOUND: 400,
  DUPLICATE_OBJECT: 409,
  SPACE_NOT_FOUND: 404,
  SPACE_NOT_EMPTY: 409,
  LAST_SPACE_REMAINING: 409,
  INVALID_QUERY: 400,
};
