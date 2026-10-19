import { expect, test } from "vitest";
import { faceObservationsSchema } from "./faces.js";

test("face observations retain all boxes in delivered top-left coordinates", () => {
  expect(
    faceObservationsSchema.safeParse({
      recipe: "vision-face-rectangles-v1",
      implementationId: "vision-face-rectangles-v1:revision-3:fixture-OS",
      coordinateSpace: "delivered-top-left-pixels",
      width: 100,
      height: 80,
      status: "available",
      reason: undefined,
      faces: [
        { id: "face-0", boundingBox: { x: 10, y: 20, width: 30, height: 40 }, confidence: 0.9 },
      ],
    }).success,
  ).toBe(true);
});

test("face states refuse contradictory boxes", () => {
  expect(
    faceObservationsSchema.safeParse({
      recipe: "vision-face-rectangles-v1",
      implementationId: "vision-face-rectangles-v1:revision-3:fixture-OS",
      coordinateSpace: "delivered-top-left-pixels",
      width: 10,
      height: 10,
      status: "no_face",
      reason: "no_face",
      faces: [{ id: "face-0", boundingBox: { x: 0, y: 0, width: 1, height: 1 }, confidence: 0.5 }],
    }).success,
  ).toBe(false);
});

test("face observations retain landmark coverage evidence separately from detector confidence", () => {
  const result = faceObservationsSchema.safeParse({
    recipe: "vision-face-rectangles-v1",
    implementationId: "vision-face-rectangles-v1:revision-3:fixture-OS",
    coordinateSpace: "delivered-top-left-pixels",
    width: 100,
    height: 80,
    status: "available",
    faces: [
      {
        id: "face-0",
        boundingBox: { x: 10, y: 20, width: 30, height: 40 },
        confidence: 0.99,
        landmarkCoverage: "partial",
        landmarkGroups: ["face_contour", "nose", "outer_lips"],
      },
    ],
  });

  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.faces[0]).toMatchObject({
      confidence: 0.99,
      landmarkCoverage: "partial",
      landmarkGroups: ["face_contour", "nose", "outer_lips"],
    });
  }
});
