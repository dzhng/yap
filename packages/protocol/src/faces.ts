import { z } from "zod";

export const faceObservationRequestSchema = z.strictObject({
  recipe: z.literal("vision-face-rectangles-v1").default("vision-face-rectangles-v1"),
});
const faceBoxSchema = z.strictObject({
  x: z.int().min(0).max(8192),
  y: z.int().min(0).max(8192),
  width: z.int().min(1).max(8192),
  height: z.int().min(1).max(8192),
});
const landmarkGroupSchema = z.enum([
  "face_contour",
  "left_eye",
  "right_eye",
  "left_eyebrow",
  "right_eyebrow",
  "nose",
  "nose_crest",
  "median_line",
  "outer_lips",
  "inner_lips",
  "left_pupil",
  "right_pupil",
]);
const landmarkCoverageSchema = z.enum(["core", "partial", "unavailable"]);
export const faceObservationsSchema = z
  .strictObject({
    recipe: z.literal("vision-face-rectangles-v1"),
    implementationId: z
      .string()
      .max(512)
      .regex(/^vision-face-rectangles-v1:revision-[1-9][0-9]*:.+$/),
    coordinateSpace: z.literal("delivered-top-left-pixels"),
    width: z.int().min(1).max(8192),
    height: z.int().min(1).max(8192),
    status: z.enum(["available", "no_face", "error"]),
    faces: z
      .array(
        z.strictObject({
          id: z.string().regex(/^face-[0-9]+$/),
          boundingBox: faceBoxSchema,
          confidence: z.number().finite().min(0).max(1),
          landmarkCoverage: landmarkCoverageSchema.optional(),
          landmarkGroups: z.array(landmarkGroupSchema).max(12).optional(),
        }),
      )
      .max(64),
    reason: z.string().min(1).max(4096).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.status === "available" && v.faces.length === 0)
      ctx.addIssue({ code: "custom", message: "available requires faces" });
    if (v.status === "no_face" && (v.faces.length !== 0 || v.reason !== "no_face"))
      ctx.addIssue({ code: "custom", message: "no_face requires an empty result" });
    if (v.status === "error" && !v.reason)
      ctx.addIssue({ code: "custom", message: "error requires a reason" });
    if (v.status === "available" && v.reason !== undefined)
      ctx.addIssue({ code: "custom", message: "available has no reason" });
    for (const face of v.faces) {
      const b = face.boundingBox;
      if (b.x + b.width > v.width || b.y + b.height > v.height)
        ctx.addIssue({ code: "custom", message: "face box outside delivered raster" });
      if ((face.landmarkCoverage === undefined) !== (face.landmarkGroups === undefined))
        ctx.addIssue({
          code: "custom",
          message: "landmark coverage and groups must be reported together",
        });
      if (face.landmarkGroups && new Set(face.landmarkGroups).size !== face.landmarkGroups.length)
        ctx.addIssue({ code: "custom", message: "landmark groups must be unique" });
      if (face.landmarkCoverage === "unavailable" && face.landmarkGroups?.length)
        ctx.addIssue({ code: "custom", message: "unavailable landmarks cannot report groups" });
      if (face.landmarkCoverage === "partial" && !face.landmarkGroups?.length)
        ctx.addIssue({ code: "custom", message: "partial landmarks require at least one group" });
      if (face.landmarkCoverage === "core") {
        const groups = new Set(face.landmarkGroups ?? []);
        for (const required of ["face_contour", "left_eye", "right_eye", "nose", "outer_lips"])
          if (!groups.has(required as z.infer<typeof landmarkGroupSchema>))
            ctx.addIssue({
              code: "custom",
              message: "core landmarks are missing a required group",
            });
      }
    }
  });
export type FaceObservationRequest = z.input<typeof faceObservationRequestSchema>;
export type FaceObservations = z.infer<typeof faceObservationsSchema>;
