import requirements from "./requirements.json" with { type: "json" };

export const MAXIMUM_TAKE_US = requirements.maximumTakeSeconds * 1_000_000;
export const MAXIMUM_STROKE_US = requirements.maximumStrokeSeconds * 1_000_000;

/** Growth per second × required seconds × stated margin, rounded up to whole units. */
export function derivedBound(perSecond: number, requirementUs: number, margin: number): number {
  return Math.ceil(perSecond * (requirementUs / 1_000_000) * margin);
}

const strokeBytesPerSecond = requirements.strokeBytesPerSecond;

// 60 points/s × 103 B/point (probe planning rate) × 5-minute stroke × 2× margin.
// Covers an unthinned schema-4 stroke, numeric widths and its window/envelope metadata.
export const JOURNAL_RECORD_BYTES = derivedBound(
  strokeBytesPerSecond,
  MAXIMUM_STROKE_US,
  requirements.journalRecordMargin,
);
