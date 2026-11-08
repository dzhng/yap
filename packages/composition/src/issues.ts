import { z } from "zod";
import { fontReferenceSchema, selectionRangeSchema, timeValueSchema } from "./schema.js";

/**
 * Output by default: an operation that can produce its output does, and reports each problem as an
 * issue on that output. This module is the only issue vocabulary; every code and its evidence shape
 * is registered here. Codes are kebab-case so they never collide with UPPER_SNAKE refusal codes.
 */

export const issueLimit = 1000;

const subjectSchema = z.union([
  z.object({ range: selectionRangeSchema }).strict(),
  z.object({ word: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict(),
  z.object({ step: z.string().min(1) }).strict(),
  z.object({ channel: z.int().nonnegative().max(1024) }).strict(),
]);

function issue<const Code extends string, Evidence extends z.ZodType>(
  code: Code,
  evidence: Evidence,
) {
  return z
    .object({
      code: z.literal(code),
      message: z.string().min(1),
      at: subjectSchema.optional(),
      evidence,
    })
    .strict();
}

export const framingConstraintSchema = z.enum([
  "zoom_cap",
  "zoom_floor",
  "source_bounds",
  "margins_unreachable",
  "target_unreachable",
  "subject_landmarks_partial",
  "subject_landmarks_unavailable",
]);

const boundsSchema = z.object({ startUs: timeValueSchema, endUs: timeValueSchema }).strict();
const domainIndexSchema = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const finite = z.number().finite();

/** One requested normalization target the published signal misses beyond its tolerance. */
export const normalizationTargetMissSchema = z
  .object({
    target: z.enum(["integrated-loudness", "loudness-range", "true-peak"]),
    requested: finite,
    /** Null when the published signal has no measurable value for this target. */
    achieved: finite.nullable(),
    /** How far past the requested value the published signal lands; null when unmeasured. */
    excess: finite.nonnegative().nullable(),
  })
  .strict();

/** Why a dynamic correction loop stopped at the candidate it measured last. */
export const normalizationStopReasonSchema = z.enum([
  "constraints",
  "target-reached",
  "no-progress",
  "budget-exhausted",
  "offset-unavailable",
]);

const index = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/**
 * An engine value exactly as reported; a nonfinite one is spelled out, since JSON has no NaN.
 * Literals, not `z.enum`: declaration emit turns an enum key "-Infinity" into `[-Infinity]` and
 * drops it from the built type.
 */
const engineValueSchema = z.union([
  z.number().finite(),
  z.literal("NaN"),
  z.literal("Infinity"),
  z.literal("-Infinity"),
]);

/**
 * A text clip drawn partly in a face other than its pinned one. `used` is the PostScript name the
 * platform drew with, `codePoints` the Unicode scalars it drew, in first-occurrence order.
 */
const textFallbackSchema = z
  .object({
    clipId: z.string().min(1),
    requested: fontReferenceSchema,
    used: z.string().min(1),
    codePoints: z.array(z.int().nonnegative().max(0x10ffff)).min(1).max(8192),
  })
  .strict();

const rowIndexSchema = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const rectSchema = z
  .object({ x: finite, y: finite, width: finite.positive(), height: finite.positive() })
  .strict();
/** A caption draft's project interval as the word evidence gave it; an instant word's is a point. */
const cueSchema = z.object({ startUs: timeValueSchema, endUs: timeValueSchema }).strict();
const requestedCount = z.int().positive().max(Number.MAX_SAFE_INTEGER);

/**
 * A caption draft misses a caller constraint. `constraint` is the request's own key; `requested` is
 * its value and `measured` what the draft reached. Dwell keeps the exact cue interval instead of a
 * difference, which a fractional interval can't always represent.
 */
const captionConstraintMissSchema = z.discriminatedUnion("constraint", [
  z
    .object({ constraint: z.literal("widthGraphemes"), requested: requestedCount, measured: index })
    .strict(),
  z
    .object({ constraint: z.literal("maxLines"), requested: requestedCount, measured: index })
    .strict(),
  z
    .object({ constraint: z.literal("minDwellUs"), requested: requestedCount, cue: cueSchema })
    .strict(),
  z
    .object({ constraint: z.literal("maxDwellUs"), requested: requestedCount, cue: cueSchema })
    .strict(),
  z
    .object({
      constraint: z.literal("maxCps"),
      requested: requestedCount,
      measured: finite.nonnegative(),
    })
    .strict(),
  z
    .object({
      constraint: z.literal("safeArea"),
      requested: rectSchema,
      measured: rectSchema,
      canvas: z.object({ width: requestedCount, height: requestedCount }).strict(),
    })
    .strict(),
]);

export const issueSchema = z.discriminatedUnion("code", [
  issue(
    "issues-truncated",
    z.object({ omitted: z.int().positive().max(Number.MAX_SAFE_INTEGER) }).strict(),
  ),
  issue(
    "synchronization-evidence-refused",
    z
      .object({
        angleGroupId: z.string().min(1),
        evidenceId: z.string().min(1),
        generation: z.string().min(1),
        method: z.enum(["waveform", "lexical-anchor", "mixed-reference"]),
        fingerprint: z.string().min(1),
        operationIndex: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
  ),
  issue(
    "gain-constrained",
    z
      .object({
        limit: z.enum(["true-peak-ceiling", "gain-minimum", "gain-maximum"]),
        requestedGainDb: z.number().finite(),
        gainDb: z.number().finite(),
      })
      .strict(),
  ),
  issue(
    "gain-bound-breached",
    z
      .object({
        bound: z.literal("gain-minimum"),
        boundDb: z.number().finite(),
        gainDb: z.number().finite(),
      })
      .strict(),
  ),
  issue(
    "proposal-unavailable",
    z
      .object({
        reason: z.enum(["missing-support", "too-short", "unmeasurable", "gain-unrepresentable"]),
      })
      .strict(),
  ),
  issue(
    "derived-stale-skipped",
    z.object({ kind: z.literal("transcript-generation"), id: z.string().min(1) }).strict(),
  ),
  issue(
    "caption-omitted",
    z
      .object({
        placementId: z.string().min(1),
        reason: z.enum(["no-display-support", "empty-text"]),
      })
      .strict(),
  ),
  issue(
    "caption-overlap-added",
    z
      .object({
        left: z
          .object({ placementId: z.string().min(1), fragment: z.int().nonnegative() })
          .strict(),
        right: z
          .object({ placementId: z.string().min(1), fragment: z.int().nonnegative() })
          .strict(),
        startMs: z.int().nonnegative(),
        endMs: z.int().nonnegative(),
      })
      .strict(),
  ),
  issue(
    "srt-literal-markup",
    z.object({ placementId: z.string().min(1), alternative: z.literal("vtt") }).strict(),
  ),
  issue("framing-constraint-unmet", z.object({ constraint: framingConstraintSchema }).strict()),
  // Speech inference (helpers/mac/Sources/YapSpeech). `window` is the decoded window's ordinal and
  // `observation` its index in that window's raw observations; raw evidence keeps every candidate.
  issue(
    "boundary-unresolved",
    z
      .object({
        boundaryUs: timeValueSchema,
        window: index,
        observation: index,
        text: z.string().min(1).max(1024),
        published: z.boolean(),
      })
      .strict(),
  ),
  issue(
    "timing-clamped",
    z
      .object({
        window: index,
        observation: index,
        decoded: selectionRangeSchema,
        startUs: z.number().int().nonnegative().optional(),
        endUs: z.number().int().nonnegative().optional(),
        startSeconds: z.number().finite().optional(),
        endSeconds: z.number().finite().optional(),
      })
      .refine(
        (value) =>
          (value.startUs !== undefined && value.endUs !== undefined) ||
          (value.startSeconds !== undefined && value.endSeconds !== undefined),
      )
      .strict(),
  ),
  issue(
    "word-dropped",
    z
      .object({
        window: index,
        token: index,
        text: z.string().max(1024),
        startSeconds: engineValueSchema.optional(),
        endSeconds: engineValueSchema.optional(),
        startUs: z.number().int().nonnegative().optional(),
        endUs: z.number().int().nonnegative().optional(),
        confidence: engineValueSchema,
      })
      .refine(
        (value) =>
          (value.startSeconds !== undefined && value.endSeconds !== undefined) ||
          value.endUs !== undefined,
      )
      .strict(),
  ),
  issue(
    "range-clamped",
    z
      .object({
        requested: boundsSchema,
        applied: selectionRangeSchema,
        bounds: boundsSchema,
        operationIndex: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
      })
      .strict(),
  ),
  issue(
    "normalization-target-unmet",
    z.discriminatedUnion("mode", [
      z
        .object({
          mode: z.literal("gain-only"),
          domainIndex: domainIndexSchema,
          missed: z.array(normalizationTargetMissSchema).min(1).max(3),
          /** The gain the loudness target asked for, and the gain applied once the peak ceiling won. */
          requestedGainDb: finite,
          gainDb: finite,
          /** The input's true peak minus its integrated loudness. */
          peakToLoudnessDb: finite,
          /** The loudest integrated target a gain could reach without passing the peak ceiling. */
          maximumFeasibleTargetLufs: finite,
        })
        .strict(),
      z
        .object({
          mode: z.literal("dynamic"),
          domainIndex: domainIndexSchema,
          missed: z.array(normalizationTargetMissSchema).min(1).max(3),
          attempts: z.int().positive().max(Number.MAX_SAFE_INTEGER),
          selectedAttempt: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
          stopReason: normalizationStopReasonSchema,
        })
        .strict(),
    ]),
  ),
  issue(
    "normalization-unmeasurable",
    z
      .object({
        domainIndex: domainIndexSchema,
        measurement: z.enum([
          "integrated-loudness",
          "loudness-range",
          "true-peak",
          "dynamic-first-pass",
        ]),
        reason: z.enum(["insufficient-duration", "below-gate", "silent", "non-finite"]),
      })
      .strict(),
  ),
  // A stateful processor's input had no source support here. Its state was split at the gap: each
  // available run was processed as its own state domain, and the gap stays unavailable (never silence).
  issue(
    "support-gap",
    z
      .object({
        clipId: z.string().min(1),
        unavailable: selectionRangeSchema,
        stepIds: z.array(z.string().min(1)).min(1),
      })
      .strict(),
  ),
  issue(
    "limiter-ceiling-unmet",
    z
      .object({
        domainIndex: domainIndexSchema,
        ceilingDbfs: finite,
        samplePeakDbfs: finite,
      })
      .strict(),
  ),
  // Text rendering (helpers/mac/Sources/YapFrames/TextRaster.swift). Another installed face drew
  // these code points; the pinned face has no glyph for them.
  issue("font-substituted", textFallbackSchema),
  // No installed face has a glyph for these code points; `used` drew a placeholder box.
  issue("glyph-missing", textFallbackSchema),
  // Caption drafts (skills/yap/scripts/caption-proposals.mjs). `rowIndex` is the request's row.
  // A request constraint the helper doesn't know was ignored.
  issue("caption-constraint-unsupported", z.object({ constraint: z.string() }).strict()),
  // A cue reached the seed's word-pin limit, so a new cue starts at `rowIndex`.
  issue(
    "caption-cue-split",
    z.object({ maximumWords: z.literal(1000), rowIndex: rowIndexSchema }).strict(),
  ),
  issue("caption-constraint-unmet", captionConstraintMissSchema),
  // The draft's text breaks across lines while the style turns wrapping off.
  issue("caption-wrap-disabled", z.object({ lines: z.int().min(2).max(8192) }).strict()),
  issue("caption-text-empty", z.object({}).strict()),
  // Longer than a text clip admits, so applying the draft is refused.
  issue(
    "caption-text-too-long",
    z
      .object({
        maximumUTF16Units: z.literal(8192),
        utf16Units: z
          .int()
          .min(8193)
          .max(1 << 30),
      })
      .strict(),
  ),
  // A point word: no dwell, no reading speed and no placeable clip (`clip: null`).
  issue("caption-instant-word", z.object({ rowIndex: rowIndexSchema }).strict()),
  // The clip trims part of the spoken word away.
  issue("caption-word-partial", z.object({ rowIndex: rowIndexSchema }).strict()),
  // The word plays in more than one project fragment.
  issue(
    "caption-word-discontinuous",
    z.object({ rowIndex: rowIndexSchema, fragments: z.int().min(2).max(8192) }).strict(),
  ),
]);

export type Issue = z.infer<typeof issueSchema>;
export type IssueCode = Issue["code"];

export const issueCodes: readonly IssueCode[] = issueSchema.options.map(
  (option) => option.shape.code.value,
);

/** At most `issueLimit` issues, optionally followed by one final `issues-truncated`. */
export const issuesSchema = z
  .array(issueSchema)
  .max(issueLimit + 1)
  .refine(
    (issues) => issues.length <= issueLimit || issues.at(-1)?.code === "issues-truncated",
    "Only a final issues-truncated entry may follow the issue limit",
  );

/** The one marker that stands for issues left out of a bounded list. */
export function truncatedIssue(omitted: number): Issue {
  return {
    code: "issues-truncated",
    message: omitted === 1 ? "1 more issue was omitted" : `${omitted} more issues were omitted`,
    evidence: { omitted },
  };
}

/** How many issues a list stands for: a truncation marker counts as the issues it omitted. */
export function issueCount(issues: readonly Issue[]): number {
  return issues.reduce(
    (count, issue) => count + (issue.code === "issues-truncated" ? issue.evidence.omitted : 1),
    0,
  );
}

/**
 * The first `issueLimit` issues, then one `issues-truncated` counting every issue left out —
 * including those an earlier bound already folded into a marker. Bounding is idempotent, so lists
 * bounded at their source can be combined and bounded again without losing count.
 */
export function boundedIssues(issues: readonly Issue[]): Issue[] {
  let omitted = 0;
  const kept: Issue[] = [];
  for (const issue of issues) {
    if (issue.code === "issues-truncated") omitted += issue.evidence.omitted;
    else if (kept.length < issueLimit) kept.push(issue);
    else omitted++;
  }
  return omitted ? [...kept, truncatedIssue(omitted)] : kept;
}
