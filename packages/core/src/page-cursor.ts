import { createHash } from "node:crypto";
import { CatalogError } from "./catalog.js";

type Payload = {
  version: 1;
  scope: string;
  filters: string;
  position: unknown;
  integrity: string;
};

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === "bigint") return Number(item);
    return item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item;
  });
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function invalid(message = "Malformed or foreign page cursor"): never {
  throw new CatalogError("INVALID_PARAMS", message);
}

/** The filter set a continuation binds: key order and absent (undefined) fields don't count. */
function filterDigest(filters: Record<string, unknown>): string {
  return digest(canonical(filters));
}

/**
 * Opaque continuation tokens shared by every public paged operation. A token binds its operation
 * (scope) and the request's filter set; reusing it under another scope or filter set is
 * INVALID_PARAMS. Readers keep their own evidence pins and refuse a stale pin as ARTIFACT_CHANGED.
 */
export const pageCursor = {
  encode(scope: string, position: unknown, filters: Record<string, unknown>): string {
    if (typeof scope !== "string" || scope.length === 0) invalid();
    const unsigned = { version: 1 as const, scope, filters: filterDigest(filters), position };
    const payload: Payload = { ...unsigned, integrity: digest(canonical(unsigned)) };
    return Buffer.from(canonical(payload), "utf8").toString("base64url");
  },
  decode(scope: string, cursor: string, filters: Record<string, unknown>): unknown {
    if (typeof scope !== "string" || scope.length === 0 || typeof cursor !== "string") invalid();
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) invalid();
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    } catch {
      invalid();
    }
    if (!value || typeof value !== "object") invalid();
    const payload = value as Partial<Payload>;
    if (
      payload.version !== 1 ||
      payload.scope !== scope ||
      typeof payload.filters !== "string" ||
      !("position" in payload) ||
      typeof payload.integrity !== "string"
    )
      invalid();
    const { integrity, ...unsigned } = payload;
    if (digest(canonical(unsigned)) !== integrity) invalid();
    if (payload.filters !== filterDigest(filters))
      invalid("Page cursor belongs to another filter set");
    return payload.position;
  },
};

/** A paged request's filter set: every parameter except the continuation and page size. */
export function pageFilters(params: object): Record<string, unknown> {
  const { cursor: _cursor, limit: _limit, ...filters } = params as Record<string, unknown>;
  return filters;
}

type FilteredPosition = { pin: unknown; source: unknown; skip: number };

/**
 * Pages the rows `keep` selects from an ordered underlying reader, one underlying page per
 * request. The continuation names that page and how many of its kept rows were already returned,
 * and binds the request's filters (through the cursor) and the evidence pin (a changed pin is
 * ARTIFACT_CHANGED).
 */
export function filteredPage(
  scope: string,
  input: {
    cursor?: string | undefined;
    limit?: number | undefined;
    filters: Record<string, unknown>;
  },
) {
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new CatalogError("INVALID_PARAMS", "Page limit must be 1–1000");
  const position =
    input.cursor === undefined
      ? undefined
      : (pageCursor.decode(scope, input.cursor, input.filters) as Partial<FilteredPosition> | null);
  if (
    position !== undefined &&
    (!position ||
      typeof position !== "object" ||
      !("source" in position) ||
      !Number.isSafeInteger(position.skip) ||
      position.skip! < 0)
  )
    invalid();
  return {
    read<T>(
      pin: unknown,
      read: (source: unknown) => { rows: readonly T[]; nextCursor: unknown },
      keep: (row: T) => boolean = () => true,
    ): { rows: T[]; nextCursor: string | null } {
      if (position && canonical(position.pin) !== canonical(pin))
        throw new CatalogError("ARTIFACT_CHANGED", "Page evidence changed since the continuation");
      const source = position?.source ?? null,
        skip = position?.skip ?? 0;
      const page = read(source === null ? undefined : source);
      const kept = page.rows.filter(keep);
      if (skip > kept.length) invalid();
      const rows = kept.slice(skip, skip + limit);
      const next: FilteredPosition | null =
        skip + rows.length < kept.length
          ? { pin, source, skip: skip + rows.length }
          : page.nextCursor === null || page.nextCursor === undefined
            ? null
            : { pin, source: page.nextCursor, skip: 0 };
      return {
        rows,
        nextCursor: next === null ? null : pageCursor.encode(scope, next, input.filters),
      };
    },
  };
}

/** Moves a reader's internal continuation payload into the public page envelope. */
export function pageEnvelope<T>(value: T, scope: string, filters: Record<string, unknown>): T {
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (!("page" in record)) return value;
  const page = record.page;
  const { page: _page, ...rest } = record;
  if (!page || typeof page !== "object") return rest as T;
  const flattened = { ...rest, ...(page as Record<string, unknown>) } as Record<string, unknown>;
  if (flattened.nextCursor !== null && flattened.nextCursor !== undefined)
    flattened.nextCursor = pageCursor.encode(scope, flattened.nextCursor, filters);
  return flattened as T;
}

export type PageCursor = typeof pageCursor;
