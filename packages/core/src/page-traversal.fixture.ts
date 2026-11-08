import { expect } from "vitest";

type Read<C> = (
  limit: number,
  cursor: C | undefined,
) => { items: readonly unknown[]; nextCursor: C | null };

/**
 * The reader half of the paging conformance check: limits outside 1–1000 refuse, and following
 * limit-1 continuations to the end yields exactly one limit-1000 read, in order, without
 * duplicates or skips. Returns the first continuation so callers can reuse it under other filters.
 */
export function expectPageTraversal<C>(
  read: Read<C>,
  id: (item: unknown) => string = (item) => JSON.stringify(item),
  minimum = 3,
): { expected: string[]; firstCursor: C } {
  for (const limit of [0, 1001])
    expect(() => read(limit, undefined)).toThrow(
      expect.objectContaining({ code: "INVALID_PARAMS" }),
    );
  const all = read(1000, undefined);
  expect(all.nextCursor).toBeNull();
  const expected = all.items.map(id);
  expect(expected.length).toBeGreaterThanOrEqual(minimum);
  const traversed: string[] = [];
  let cursor: C | undefined, firstCursor: C | undefined;
  for (let pages = 0; ; pages++) {
    expect(pages, "limit-1 traversal must end").toBeLessThanOrEqual(expected.length * 2 + 2);
    const page = read(1, cursor);
    expect(page.items.length).toBeLessThanOrEqual(1);
    traversed.push(...page.items.map(id));
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
    firstCursor ??= cursor;
  }
  expect(traversed).toEqual(expected);
  expect(new Set(traversed).size).toBe(traversed.length);
  expect(firstCursor).toBeDefined();
  return { expected, firstCursor: firstCursor! };
}
