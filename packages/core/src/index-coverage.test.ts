import { expect, test } from "vitest";
import { CoverageTracker } from "./index-coverage.js";

const longEdgePx = 1000;

test("coverage needs a changed picture and thirty quiet seconds after the last choice", () => {
  const coverage = new CoverageTracker();
  coverage.chosen(0);
  coverage.advance(0);
  coverage.shown(1);
  coverage.advance(29_999_999);
  expect(coverage.due(2, longEdgePx)).toBe(false);
  coverage.advance(30_000_000);
  expect(coverage.due(1, longEdgePx)).toBe(false);
  expect(coverage.due(2, longEdgePx)).toBe(true);
});

test("a choice reported ahead of the scan counts once the scan reaches it", () => {
  const coverage = new CoverageTracker();
  coverage.chosen(0);
  coverage.chosen(20_000_000);
  coverage.advance(0);
  coverage.shown(1);
  coverage.advance(31_000_000);
  expect(coverage.due(2, longEdgePx)).toBe(false);
  coverage.advance(50_000_000);
  expect(coverage.due(2, longEdgePx)).toBe(true);
});

test("one picture long edge of pointer travel since the last choice makes a changed picture due", () => {
  const pointer = [0, 400, 800, 1000].map((x, index) => ({ sourceUs: index * 100, x, y: 0 }));
  const coverage = new CoverageTracker(pointer);
  coverage.chosen(0);
  coverage.advance(0);
  coverage.shown(1);
  coverage.advance(200);
  expect(coverage.due(2, longEdgePx)).toBe(false);
  coverage.advance(300);
  expect(coverage.due(2, longEdgePx)).toBe(true);
  // A choice restarts travel.
  coverage.chosen(300);
  expect(coverage.due(2, longEdgePx)).toBe(false);
});
