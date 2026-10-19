import { expect, test } from "vitest";
import { buildFaceTrajectory } from "./face-trajectory.js";

const observation = (faces: Array<{ x: number; y: number; width: number; height: number }>) => ({
  recipe: "vision-face-rectangles-v1" as const,
  implementationId: "vision-face-rectangles-v1:revision-3:fixture-OS",
  coordinateSpace: "delivered-top-left-pixels" as const,
  width: 100,
  height: 100,
  status: faces.length ? ("available" as const) : ("no_face" as const),
  faces: faces.map((boundingBox, index) => ({
    id: `face-${index}`,
    boundingBox,
    confidence: 0.9,
  })),
  ...(faces.length ? {} : { reason: "no_face" as const }),
});

test("builds a source-bound trajectory without filling an observed gap", () => {
  const trajectory = buildFaceTrajectory({
    source: {
      assetId: "asset-a",
      streamId: "track:1",
      generation: "generation-a",
      supportDigest: "support-a",
    },
    samples: [
      { ordinal: 0, atUs: 0, observations: observation([{ x: 10, y: 10, width: 20, height: 20 }]) },
      { ordinal: 1, atUs: 1000, observations: observation([]) },
      {
        ordinal: 2,
        atUs: 2000,
        observations: observation([{ x: 12, y: 10, width: 20, height: 20 }]),
      },
    ],
  });

  expect(trajectory).toMatchObject({
    schema: "face-trajectory-v1",
    prediction: { method: "none", state: "disabled" },
    clock: "source",
    source: { assetId: "asset-a", streamId: "track:1", supportDigest: "support-a" },
    maxGapUs: 500_000,
  });
  expect(trajectory.samples.map((sample) => sample.ordinal)).toEqual([0, 1, 2]);
  expect(trajectory.tracks).toHaveLength(1);
  expect(trajectory.tracks[0]!.samples.map((sample) => sample.status)).toEqual([
    "observed",
    "gap",
    "observed",
  ]);
});

test("labels ambiguous matches and refuses unimplemented prediction", () => {
  const trajectory = buildFaceTrajectory({
    source: {
      assetId: "asset-a",
      streamId: "track:1",
      generation: "generation-a",
      supportDigest: "support-a",
    },
    prediction: "linear",
    samples: [
      { ordinal: 0, atUs: 0, observations: observation([{ x: 10, y: 10, width: 20, height: 20 }]) },
      {
        ordinal: 1,
        atUs: 1000,
        observations: observation([
          { x: 10, y: 10, width: 20, height: 20 },
          { x: 10, y: 10, width: 20, height: 20 },
        ]),
      },
    ],
  });
  expect(trajectory.prediction).toEqual({
    method: "linear",
    state: "unavailable",
    reason: "prediction_not_implemented",
  });
  expect(trajectory.tracks[0]!.samples[1]).toMatchObject({
    status: "ambiguous",
    sourceObservationId: "face-0",
  });
});

test("retains the full-face occlusion refusal operand", () => {
  const noFace = observation([]);
  const trajectory = buildFaceTrajectory({
    source: {
      assetId: "asset-a",
      streamId: "track:1",
      generation: "generation-a",
      supportDigest: "support-a",
    },
    samples: Array.from({ length: 27 }, (_, ordinal) => ({
      ordinal,
      atUs: ordinal * 1000,
      observations: noFace,
    })),
  });
  expect(trajectory.refusals).toEqual([
    {
      code: "full_face_occlusion",
      startOrdinal: 0,
      endOrdinal: 26,
      sampleCount: 27,
      reason: "detector_no_face",
    },
  ]);
});
