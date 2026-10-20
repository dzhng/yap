import requirements from "./requirements.json" with { type: "json" };

export const MAXIMUM_TAKE_US = requirements.maximumTakeSeconds * 1_000_000;
export const MAXIMUM_STROKE_US = requirements.maximumStrokeSeconds * 1_000_000;

/** Growth per second × required seconds × stated margin, rounded up to whole units. */
export function derivedBound(perSecond: number, requirementUs: number, margin: number): number {
  return Math.ceil(perSecond * (requirementUs / 1_000_000) * margin);
}
