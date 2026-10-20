import { expect, it } from "vitest";
import { derivedBound, JOURNAL_RECORD_BYTES, MAXIMUM_STROKE_US, MAXIMUM_TAKE_US } from "./index.js";
import requirements from "./requirements.json" with { type: "json" };

it("exports the shared take and stroke requirements in microseconds", () => {
  expect(requirements).toEqual({ maximumTakeSeconds: 43200, maximumStrokeSeconds: 300 });
  expect(MAXIMUM_TAKE_US).toBe(requirements.maximumTakeSeconds * 1_000_000);
  expect(MAXIMUM_STROKE_US).toBe(requirements.maximumStrokeSeconds * 1_000_000);
});

it("derives whole-unit bounds from growth per second, required duration and margin", () => {
  expect(derivedBound(60, MAXIMUM_STROKE_US, 2)).toBe(36_000);
  expect(derivedBound(48_000, MAXIMUM_TAKE_US, 1)).toBe(2_073_600_000);
  expect(derivedBound(3, 500_000, 1.5)).toBe(3);
  expect(JOURNAL_RECORD_BYTES).toBe(derivedBound(60 * 103, MAXIMUM_STROKE_US, 2));
  expect(JOURNAL_RECORD_BYTES).toBe(3_708_000);
});
