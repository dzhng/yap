import { processingTapSchema, selectionRangeSchema, signedTimeValueSchema } from "@yap/composition";
import { z } from "zod";
import { pageParams } from "./paging.js";

const id = z.string().min(1);
const sourceEndpointSchema = z.strictObject({
  kind: z.literal("source"),
  assetId: id,
  streamId: id,
  acquisitionId: id.optional(),
  channel: z.int().nonnegative(),
  sourceRange: selectionRangeSchema,
});
const projectEndpointSchema = z.strictObject({
  kind: z.literal("project"),
  id: id,
  revisionId: id,
  preparedResourceId: id,
  tap: processingTapSchema,
  channel: z.int().nonnegative(),
  sourceRange: selectionRangeSchema,
});
export const correspondenceEndpointSchema = z.discriminatedUnion("kind", [
  sourceEndpointSchema,
  projectEndpointSchema,
]);
export type CorrespondenceEndpoint = z.infer<typeof correspondenceEndpointSchema>;

export const correspondenceCandidateSchema = z.strictObject({
  offsetUs: signedTimeValueSchema,
  residualUs: z.number().finite().nonnegative(),
  coverage: z.number().finite().min(0).max(1),
  driftPpm: z.number().finite(),
  score: z.number().finite(),
  selected: z.boolean(),
});
export type CorrespondenceCandidate = z.infer<typeof correspondenceCandidateSchema>;

export const correspondenceAnchorSchema = z
  .strictObject({
    leftRange: selectionRangeSchema,
    rightRange: selectionRangeSchema,
    candidates: z.array(correspondenceCandidateSchema).min(1).max(8),
    selected: z.int().nonnegative().nullable(),
    reason: z.string().min(1).max(512).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.selected !== null && value.selected >= value.candidates.length)
      ctx.addIssue({
        code: "custom",
        path: ["selected"],
        message: "Selected candidate is missing",
      });
    const selected = value.candidates.filter((candidate) => candidate.selected);
    if (selected.length > 1)
      ctx.addIssue({
        code: "custom",
        path: ["candidates"],
        message: "Only one candidate may be selected",
      });
    if (value.selected !== null && !value.candidates[value.selected]?.selected)
      ctx.addIssue({
        code: "custom",
        path: ["selected"],
        message: "Selected candidate must be marked selected",
      });
  });
export type CorrespondenceAnchor = z.infer<typeof correspondenceAnchorSchema>;

export const correspondenceMeasurementSchema = z
  .strictObject({
    verdict: z.enum(["accepted", "refused", "insufficient_evidence"]),
    reason: z.string().min(1).max(1024),
    anchors: z.array(correspondenceAnchorSchema).min(1).max(128),
    candidates: z.array(correspondenceCandidateSchema).min(1).max(128),
    offsetUs: signedTimeValueSchema.nullable(),
    residualUs: z.number().finite().nonnegative().nullable(),
    coverage: z.number().finite().min(0).max(1),
    driftPpm: z.number().finite().nullable(),
    policy: z
      .strictObject({
        minimumCoverage: z.number().finite().min(0).max(1),
        maximumResidualUs: z.number().finite().nonnegative(),
        maximumDriftPpm: z.number().finite().nonnegative(),
        minimumAnchors: z.int().positive().max(128),
      })
      .strict(),
  })
  .superRefine((value, ctx) => {
    const accepted = value.verdict === "accepted";
    if (
      accepted &&
      (value.offsetUs === null || value.residualUs === null || value.driftPpm === null)
    )
      ctx.addIssue({
        code: "custom",
        message: "Accepted correspondence requires a complete mapping",
      });
    if (!accepted && value.offsetUs !== null)
      ctx.addIssue({
        code: "custom",
        path: ["offsetUs"],
        message: "Refused correspondence has no mapping",
      });
    if (accepted && value.anchors.length < value.policy.minimumAnchors)
      ctx.addIssue({
        code: "custom",
        path: ["anchors"],
        message: "Accepted correspondence lacks required anchors",
      });
    if (accepted && value.coverage < value.policy.minimumCoverage)
      ctx.addIssue({
        code: "custom",
        path: ["coverage"],
        message: "Accepted correspondence lacks required coverage",
      });
    if (accepted && value.residualUs! > value.policy.maximumResidualUs)
      ctx.addIssue({
        code: "custom",
        path: ["residualUs"],
        message: "Accepted correspondence residual exceeds policy",
      });
    if (accepted && Math.abs(value.driftPpm!) > value.policy.maximumDriftPpm)
      ctx.addIssue({
        code: "custom",
        path: ["driftPpm"],
        message: "Accepted correspondence drift exceeds policy",
      });
  });
export type CorrespondenceMeasurement = z.infer<typeof correspondenceMeasurementSchema>;

export const correspondenceReceiptSchema = z
  .strictObject({
    id,
    generation: id,
    recipe: z.literal("temporal-correspondence-v1"),
    left: correspondenceEndpointSchema,
    right: correspondenceEndpointSchema,
    measurement: correspondenceMeasurementSchema,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .superRefine((value, ctx) => {
    const left = JSON.stringify(value.left);
    const right = JSON.stringify(value.right);
    if (left === right)
      ctx.addIssue({ code: "custom", path: ["right"], message: "Endpoints must be distinct" });
  });
export type CorrespondenceReceipt = z.infer<typeof correspondenceReceiptSchema>;

export const correspondencePrepareParamsSchema = z.strictObject({
  evidenceId: id,
  generation: id,
  recipe: z.literal("temporal-correspondence-v1").default("temporal-correspondence-v1"),
  left: correspondenceEndpointSchema,
  right: correspondenceEndpointSchema,
  measurement: correspondenceMeasurementSchema,
});
export const correspondenceGetParamsSchema = pageParams({
  evidenceId: id,
  generation: id,
  packageHandle: id.optional(),
});
