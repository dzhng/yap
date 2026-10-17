import { test } from "node:test";
import assert from "node:assert/strict";
import { pacingOf } from "./pacing.mjs";

// Words every 0.5 s (0.4 s long), with one 1 s pause after the fourth word.
const word = (startS) => ({ startUs: startS * 1e6, endUs: (startS + 0.4) * 1e6 });
const ranges = [0, 0.5, 1, 1.5, 2.9, 3.4, 3.9].map(word);

test("pacing separates phrases at pauses and reports rate and pause length", () => {
  const p = pacingOf(ranges);
  assert.equal(p.words, 7);
  assert.equal(p.spanSeconds, 4.3);
  assert.equal(p.wordsPerMinute, Math.round((7 / 4.3) * 60));
  assert.deepEqual(p.pauseSeconds, { p50: 1, p90: 1 });
  assert.deepEqual(p.wordsPerPhrase, { p50: 4, p90: 4 });
});

test("a single word has no pacing to report", () => {
  assert.equal(pacingOf([word(0)]), null);
});
