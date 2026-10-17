import { z } from "zod";

/** Shared request paging fields. Parsing an omitted limit yields the contract default. */
export function pageParams<T extends z.ZodRawShape = {}>(fields?: T) {
  return z
    .strictObject({
      ...(fields ?? ({} as T)),
      cursor: z.string().min(1).optional(),
      limit: z.int().min(1).max(1000).default(100),
    })
    .describe(
      "Opaque cursor continuation with a page limit from 1 through 1000 (default 100). A cursor continues only the request that produced it: repeat every other parameter (limit may change). A cursor from another operation or filter set refuses with INVALID_PARAMS; evidence republished since the first page refuses with ARTIFACT_CHANGED.",
    );
}

/** Detects page parameter objects (including objects extended from pageParams) for conformance tooling. */
export function hasPageParams(schema: z.ZodType): boolean {
  const definition = (
    schema as z.ZodType & {
      _def?: {
        type?: string;
        shape?: (() => Record<string, z.ZodType>) | Record<string, z.ZodType>;
        options?: z.ZodType[];
      };
    }
  )._def;
  if (!definition) return false;
  if (definition.type === "object" && definition.shape) {
    const shape = typeof definition.shape === "function" ? definition.shape() : definition.shape;
    return "cursor" in shape && "limit" in shape;
  }
  return definition.type === "union" && (definition.options ?? []).some(hasPageParams);
}

/** Shared top-level response envelope for one plural collection. */
export function pageResult<T extends z.ZodType>(
  plural: string,
  item: T = z.unknown() as unknown as T,
) {
  if (!/^[a-z][A-Za-z0-9]*$/.test(plural)) throw new Error("Invalid page result collection name");
  const collection = item instanceof z.ZodArray ? item : z.array(item);
  return z
    .strictObject({ [plural]: collection, nextCursor: z.string().nullable() })
    .passthrough()
    .describe(`pageResult:${plural}`);
}
