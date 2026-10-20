import { expect, test } from "vitest";
import { publicationDeadlineMs } from "./publication.js";
import { renderWindowDeadlineMs, transcriptionDeadlineMs } from "./worker.js";

test("take work budgets scale bytes and selected duration with one process startup allowance and without timer clamping", () => {
  expect(publicationDeadlineMs(4_194_304)).toBe(36_000);
  expect(publicationDeadlineMs(0, 4_194_304)).toBe(34_000);
  expect(renderWindowDeadlineMs({ startUs: 7_000_000, endUs: 8_000_000 })).toBe(32_000);
  expect(transcriptionDeadlineMs([{ startUs: 7_000_000, endUs: 8_000_000 }])).toBe(632_000);
  expect(publicationDeadlineMs(4_194_304 * 1_000_000)).toBe(6_000_030_000);
});
