import { expect, test } from "vitest";
import { trackFaceObservations } from "./face-tracking.js";

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

test("face tracks preserve movement and explicit no-face gaps", () => {
  const tracks = trackFaceObservations([
    { atUs: 0, observations: observation([{ x: 10, y: 10, width: 20, height: 20 }]) },
    { atUs: 1000, observations: observation([]) },
    { atUs: 2000, observations: observation([{ x: 12, y: 10, width: 20, height: 20 }]) },
  ]);
  expect(tracks).toHaveLength(1);
  expect(tracks[0]!.samples.map((sample) => sample.status)).toEqual([
    "observed",
    "gap",
    "observed",
  ]);
});

test("face tracks retain landmark quality evidence for the selected observation", () => {
  const base = observation([{ x: 10, y: 10, width: 20, height: 20 }]);
  const tracks = trackFaceObservations([
    {
      atUs: 0,
      observations: {
        ...base,
        faces: [
          {
            ...base.faces[0]!,
            landmarkCoverage: "partial" as const,
            landmarkGroups: ["face_contour", "nose"] as const,
          },
        ],
      },
    },
  ]);

  expect(tracks[0]!.samples[0]).toMatchObject({
    status: "observed",
    landmarkCoverage: "partial",
    landmarkGroups: ["face_contour", "nose"],
  });
});

test("ambiguous adjacent candidates are retained as ambiguity instead of silently selecting identity", () => {
  const tracks = trackFaceObservations([
    { atUs: 0, observations: observation([{ x: 10, y: 10, width: 20, height: 20 }]) },
    {
      atUs: 1000,
      observations: observation([
        { x: 10, y: 10, width: 20, height: 20 },
        { x: 10, y: 10, width: 20, height: 20 },
      ]),
    },
  ]);
  expect(tracks[0]!.ambiguous).toBe(true);
  expect(tracks).toHaveLength(2);
});

test("an occlusion beyond the declared gap horizon cannot inherit the earlier face track", () => {
  const box = { x: 10, y: 10, width: 20, height: 20 };
  const tracks = trackFaceObservations([
    { atUs: 0, observations: observation([box]) },
    { atUs: 250000, observations: observation([]) },
    { atUs: 750000, observations: observation([]) },
    { atUs: 900000, observations: observation([box]) },
  ]);
  expect(tracks.map((track) => track.samples)).toEqual([
    [
      { atUs: 0, status: "observed", faceId: "face-0", boundingBox: box, confidence: 0.9 },
      { atUs: 250000, status: "gap", reason: "no_face" },
      { atUs: 750000, status: "gap", reason: "no_face" },
    ],
    [{ atUs: 900000, status: "observed", faceId: "face-0", boundingBox: box, confidence: 0.9 }],
  ]);
});

test("a caller-declared scene reset refuses association even when the next face occupies the same box", () => {
  const box = { x: 10, y: 10, width: 20, height: 20 };
  const tracks = trackFaceObservations([
    { atUs: 0, observations: observation([box]) },
    { atUs: 40000, reset: "scene_change", observations: observation([box]) },
  ]);
  expect(tracks.map((track) => track.samples)).toEqual([
    [
      { atUs: 0, status: "observed", faceId: "face-0", boundingBox: box, confidence: 0.9 },
      { atUs: 40000, status: "gap", reason: "scene_change" },
    ],
    [{ atUs: 40000, status: "observed", faceId: "face-0", boundingBox: box, confidence: 0.9 }],
  ]);
});

test("provider or raster changes close tracks instead of mixing observation domains", () => {
  const box = { x: 10, y: 10, width: 20, height: 20 };
  for (const changed of [
    { ...observation([box]), width: 101 },
    { ...observation([box]), implementationId: "vision-face-rectangles-v1:revision-4:fixture-OS" },
  ]) {
    const tracks = trackFaceObservations([
      { atUs: 0, observations: observation([box]) },
      { atUs: 1000, observations: changed },
    ]);
    expect(
      tracks.map((track) =>
        track.samples.map((sample) =>
          sample.status === "gap" ? sample.reason : sample.boundingBox,
        ),
      ),
    ).toEqual([[box, "observation_domain_changed"], [box]]);
  }
});

test("a detector failure closes association and keeps its native reason", () => {
  const box = { x: 10, y: 10, width: 20, height: 20 };
  const tracks = trackFaceObservations([
    { atUs: 0, observations: observation([box]) },
    {
      atUs: 1000,
      observations: { ...observation([]), status: "error", reason: "fixture detector refused" },
    },
    { atUs: 2000, observations: observation([box]) },
  ]);
  expect(
    tracks.map((track) =>
      track.samples.map((sample) => (sample.status === "gap" ? sample.reason : sample.boundingBox)),
    ),
  ).toEqual([[box, "fixture detector refused"], [box]]);
});
