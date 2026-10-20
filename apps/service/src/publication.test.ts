import { expect, test } from "vitest";
import { publicationDeadlineMs } from "./publication.js";
import { MAX_MEDIA_TIMEOUT_MS } from "./worker.js";

test("publication budgets scale with known bytes and stay representable by the worker", () => {
  const empty = publicationDeadlineMs(0),
    small = publicationDeadlineMs(4 * 1024 * 1024);
  const large = publicationDeadlineMs(1024 * 1024 * 1024);
  expect(empty).toBeGreaterThan(0);
  expect(small).toBeGreaterThan(empty);
  expect(large).toBeGreaterThan(small);
  expect(large).toBeLessThan(MAX_MEDIA_TIMEOUT_MS);
  expect(publicationDeadlineMs(Number.MAX_SAFE_INTEGER)).toBeGreaterThan(MAX_MEDIA_TIMEOUT_MS);
  for (const bytes of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1])
    expect(() => publicationDeadlineMs(bytes)).toThrow("byte count is invalid");
});

test("replacement deadline includes the pinned previous destination bytes", () => {
  const small = publicationDeadlineMs(1024);
  expect(publicationDeadlineMs(1024, 1024 * 1024 * 1024)).toBeGreaterThan(small);
  expect(publicationDeadlineMs(1024, Number.MAX_SAFE_INTEGER)).toBeGreaterThan(
    MAX_MEDIA_TIMEOUT_MS,
  );
});
