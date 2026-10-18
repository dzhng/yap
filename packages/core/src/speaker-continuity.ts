import { z } from "zod";

/** Frozen acceptance envelope for one finite continuous speaker invocation. */
export const speakerContinuityThresholds = Object.freeze({
  maxDer: 0.2,
  maxIdentityConfusion: 0.05,
  minOverlapRecall: 0.8,
  maxInferenceFactor: 2,
  maxPeakRssBytes: 4 * 1024 * 1024 * 1024,
});

const ratio = z.number().finite().min(0).max(1);
const positiveFinite = z.number().finite().positive();
const digest = z.string().regex(/^[a-f0-9]{64}$/);

/** Identity that makes a continuity receipt replayable and mutation-safe. */
export const speakerContinuityIdentitySchema = z.strictObject({
  generation: z.string().min(1).max(256),
  sourceDigest: digest,
  modelId: z.string().min(1),
  modelDigest: digest,
  runtimeDigest: digest,
});
export type SpeakerContinuityIdentity = z.infer<typeof speakerContinuityIdentitySchema>;

/**
 * Metrics are retained even when a candidate is refused. They describe one
 * complete invocation and never identify a known person.
 */
const speakerContinuityMetricShape = z.strictObject({
  inputFrames: z.int().positive(),
  scoredFrames: z.int().nonnegative(),
  durationUs: positiveFinite,
  inferenceUs: z.number().finite().nonnegative(),
  peakRssBytes: z.int().nonnegative(),
  expectedSpeakerCount: z.int().positive().max(8),
  observedSpeakerCount: z.int().nonnegative().max(8),
  der: ratio,
  identityConfusion: ratio,
  overlapRequired: z.boolean(),
  overlapRecall: ratio.nullable(),
  stateContinuity: z.boolean(),
});
export const speakerContinuityMetricsSchema = speakerContinuityMetricShape.superRefine(
  (metrics, context) => {
    if (metrics.scoredFrames !== metrics.inputFrames)
      context.addIssue({
        code: "custom",
        path: ["scoredFrames"],
        message: "score extent is incomplete",
      });
    if (metrics.overlapRequired && metrics.overlapRecall === null)
      context.addIssue({
        code: "custom",
        path: ["overlapRecall"],
        message: "overlap recall is required",
      });
    const expectedDuration = (metrics.inputFrames / 16000) * 1_000_000;
    if (Math.abs(metrics.durationUs - expectedDuration) > 1e-9)
      context.addIssue({
        code: "custom",
        path: ["durationUs"],
        message: "duration differs from the admitted PCM extent",
      });
  },
);
export type SpeakerContinuityMetrics = z.infer<typeof speakerContinuityMetricsSchema>;

/** Measured control runs required before a long-form envelope can be promoted. */
export const speakerContinuityControlsSchema = z.strictObject({
  shortWindow: z.boolean(),
  transport: z.boolean(),
  threeSpeaker: z.boolean(),
  fourSpeakerOverlap: z.boolean(),
});
export type SpeakerContinuityControls = z.infer<typeof speakerContinuityControlsSchema>;

/** Complete candidate operands retained for both acceptance and refusal. */
export const speakerContinuityCandidateSchema = z.strictObject({
  identity: speakerContinuityIdentitySchema,
  // Candidate metrics are structurally admitted so incomplete score extent can
  // be returned as a refusal rather than rejected before its receipt exists.
  metrics: speakerContinuityMetricShape,
  controls: speakerContinuityControlsSchema,
});
export type SpeakerContinuityCandidate = z.infer<typeof speakerContinuityCandidateSchema>;

export const speakerContinuityReceiptSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("accepted"),
    profile: z.literal("speaker-continuity-v1"),
    identity: speakerContinuityIdentitySchema.optional(),
    metrics: speakerContinuityMetricsSchema,
    controls: speakerContinuityControlsSchema.optional(),
  }),
  z.strictObject({
    status: z.literal("refused"),
    profile: z.literal("speaker-continuity-v1"),
    failedGates: z.array(z.string().min(1)).min(1),
    identity: speakerContinuityIdentitySchema.optional(),
    metrics: speakerContinuityMetricsSchema,
    controls: speakerContinuityControlsSchema.optional(),
  }),
]);
export type SpeakerContinuityReceipt = z.infer<typeof speakerContinuityReceiptSchema>;

/**
 * Evaluate a measured candidate without changing provider readiness or
 * publishing a speaker generation. Every failed gate and every measured
 * operand survives a refusal, so transport success cannot be mistaken for
 * quality. Passing only metrics is retained for small deterministic controls;
 * production promotion should always provide identity and controls.
 */
export function evaluateSpeakerContinuity(input: unknown): SpeakerContinuityReceipt {
  const candidate = speakerContinuityCandidateSchema.safeParse(input);
  const metrics = speakerContinuityMetricShape.parse(
    candidate.success ? candidate.data.metrics : input,
  );
  const identity = candidate.success ? { identity: candidate.data.identity } : {};
  const controls = candidate.success ? { controls: candidate.data.controls } : {};
  const failedGates: string[] = [];
  if (metrics.scoredFrames !== metrics.inputFrames) failedGates.push("complete_input");
  if (Math.abs(metrics.durationUs - (metrics.inputFrames / 16000) * 1_000_000) > 1e-9)
    failedGates.push("duration_extent");
  if (metrics.overlapRequired && metrics.overlapRecall === null)
    failedGates.push("overlap_measurement");
  if (!metrics.stateContinuity) failedGates.push("state_continuity");
  if (metrics.observedSpeakerCount !== metrics.expectedSpeakerCount)
    failedGates.push("speaker_count");
  if (metrics.der > speakerContinuityThresholds.maxDer) failedGates.push("der");
  if (metrics.identityConfusion > speakerContinuityThresholds.maxIdentityConfusion)
    failedGates.push("identity_confusion");
  if (
    metrics.overlapRequired &&
    (metrics.overlapRecall === null ||
      metrics.overlapRecall < speakerContinuityThresholds.minOverlapRecall)
  )
    failedGates.push("overlap_recall");
  if (metrics.inferenceUs > metrics.durationUs * speakerContinuityThresholds.maxInferenceFactor)
    failedGates.push("inference_factor");
  if (metrics.peakRssBytes > speakerContinuityThresholds.maxPeakRssBytes)
    failedGates.push("peak_rss");
  if (candidate.success) {
    if (!candidate.data.controls.shortWindow) failedGates.push("short_window_control");
    if (!candidate.data.controls.transport) failedGates.push("transport_control");
    if (!candidate.data.controls.threeSpeaker) failedGates.push("three_speaker_control");
    if (!candidate.data.controls.fourSpeakerOverlap)
      failedGates.push("four_speaker_overlap_control");
  }
  return failedGates.length
    ? {
        status: "refused",
        profile: "speaker-continuity-v1",
        failedGates,
        metrics,
        ...identity,
        ...controls,
      }
    : { status: "accepted", profile: "speaker-continuity-v1", metrics, ...identity, ...controls };
}
