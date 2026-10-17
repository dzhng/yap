import { expect, it } from "vitest";
import { pageParams, pageResult, hasPageParams } from "./paging.js";
import { z } from "zod";

it("declares shared page bounds and the top-level result envelope", () => {
  expect(pageParams().parse({})).toEqual({ limit: 100 });
  expect(pageParams().safeParse({ limit: 0 }).success).toBe(false);
  expect(pageParams().safeParse({ limit: 1001 }).success).toBe(false);
  expect(
    pageResult("projects", z.object({ projectId: z.string() })).parse({
      projects: [{ projectId: "p" }],
      nextCursor: null,
    }),
  ).toEqual({ projects: [{ projectId: "p" }], nextCursor: null });
});

it("detects page parameter objects for schema-driven conformance", () => {
  expect(hasPageParams(pageParams())).toBe(true);
  expect(hasPageParams(z.object({ cursor: z.string(), limit: z.number() }))).toBe(true);
  expect(hasPageParams(z.object({ cursor: z.string() }))).toBe(false);
});
