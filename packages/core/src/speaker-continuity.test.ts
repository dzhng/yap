import { expect, test } from "vitest";
import { evaluateSpeakerContinuity, speakerContinuityMetricsSchema } from "./speaker-continuity.js";

const passing = {
  inputFrames: 9_600_000,
  scoredFrames: 9_600_000,
  durationUs: 600_000_000,
  inferenceUs: 9_000_000,
  peakRssBytes: 2_900_000_000,
  expectedSpeakerCount: 3,
  observedSpeakerCount: 3,
  der: 0.048,
  identityConfusion: 0.002,
  overlapRequired: true,
  overlapRecall: 0.89,
  stateContinuity: true,
};

test("continuity gate admits only a complete finite profile", () => {
  expect(evaluateSpeakerContinuity(passing)).toEqual({
    status: "accepted",
    profile: "speaker-continuity-v1",
    metrics: speakerContinuityMetricsSchema.parse(passing),
  });
});

test("continuity gate refuses the retained four-speaker overlap failure", () => {
  const result = evaluateSpeakerContinuity({
    ...passing,
    expectedSpeakerCount: 4,
    observedSpeakerCount: 4,
    der: 0.2,
    overlapRecall: 0.5749,
  });
  expect(result).toMatchObject({
    status: "refused",
    profile: "speaker-continuity-v1",
    failedGates: ["overlap_recall"],
    metrics: { overlapRecall: 0.5749 },
  });
});

test("continuity receipt keeps identity and frozen controls beside accepted metrics", () => {
  const result = evaluateSpeakerContinuity({
    identity: {
      generation: "attempt-1",
      sourceDigest: "a".repeat(64),
      modelId: "speaker-v1",
      modelDigest: "b".repeat(64),
      runtimeDigest: "c".repeat(64),
    },
    metrics: passing,
    controls: {
      shortWindow: true,
      transport: true,
      threeSpeaker: true,
      fourSpeakerOverlap: true,
    },
  });
  expect(result).toMatchObject({
    status: "accepted",
    identity: { generation: "attempt-1", modelId: "speaker-v1" },
    controls: { transport: true, fourSpeakerOverlap: true },
  });
});

test("continuity refuses a candidate when a control or identity-bound score is missing", () => {
  const result = evaluateSpeakerContinuity({
    identity: {
      generation: "attempt-2",
      sourceDigest: "a".repeat(64),
      modelId: "speaker-v1",
      modelDigest: "b".repeat(64),
      runtimeDigest: "c".repeat(64),
    },
    metrics: { ...passing, scoredFrames: passing.inputFrames - 1280 },
    controls: {
      shortWindow: true,
      transport: true,
      threeSpeaker: true,
      fourSpeakerOverlap: false,
    },
  });
  expect(result).toMatchObject({
    status: "refused",
    failedGates: ["complete_input", "four_speaker_overlap_control"],
    identity: { generation: "attempt-2" },
    metrics: { scoredFrames: 9_598_720 },
  });
});

test("continuity refuses an edited duration receipt instead of promoting its metrics", () => {
  const result = evaluateSpeakerContinuity({
    identity: {
      generation: "attempt-3",
      sourceDigest: "a".repeat(64),
      modelId: "speaker-v1",
      modelDigest: "b".repeat(64),
      runtimeDigest: "c".repeat(64),
    },
    metrics: { ...passing, durationUs: 601_000_000 },
    controls: {
      shortWindow: true,
      transport: true,
      threeSpeaker: true,
      fourSpeakerOverlap: true,
    },
  });
  expect(result).toMatchObject({ status: "refused", failedGates: ["duration_extent"] });
});
