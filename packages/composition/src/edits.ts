import { omit } from "./omit.js";
import { hasStatefulProcessing, normalizeStateEdit } from "./processing-state.js";
import { clipGraph } from "./clip-graph.js";
import { placementForRange, resolveComposition, resolvePlacement } from "./model.js";
import { getProcessing, processingKey } from "./processing.js";
import { CompositionError } from "./errors.js";
import { z } from "zod";
import {
  anchorSchema,
  mediaClipSchema,
  silenceClipSchema,
  textClipSchema,
  textSourceSchema,
  compositionSchema,
  isMediaClip,
  isStatefulProcessor,
  rangeSchema,
  selectionRangeSchema,
  routingNodeSchema,
  processingTargetSchema,
  processingStepSchema,
  processingTapSchema,
  processorRegistry,
  interpolationSchema,
  signedTimeValueSchema,
  synchronizationEvidenceSchema,
  type Anchor,
  type MediaClip,
  type TimeValue,
} from "./schema.js";
import { validateComposition, type ValidatedComposition, type ExactRange } from "./model.js";

import { partitionClips } from "./partition.js";
import { add, subtract, compare, fromTime, rational, toFraction, toTime } from "./rational.js";
import {
  admitRange,
  interval,
  keepSameFraction,
  rangeClampedIssue,
  wire,
  type Interval,
} from "./range-admission.js";
import { boundedIssues, type Issue } from "./issues.js";
import { rippleTimeline, insertGap } from "./ripple.js";
import { transformSelection } from "./transform.js";
import { duplicateClips } from "./duplicate.js";
import { rippleMove } from "./move.js";
import { replaceClip } from "./replace.js";
import { retimeClips } from "./retime.js";

type Document = ValidatedComposition["document"];
type EntityKind = "clip" | "track" | "group" | "syncGroup" | "angleGroup" | "processingStep";
const reference = z.union([z.string().min(1), z.object({ label: z.string().min(1) }).strict()]);
const label = z.string().min(1).optional();
function greatestCommonDivisor(a: bigint, b: bigint): bigint {
  return b === 0n ? a : greatestCommonDivisor(b, a % b);
}
const routingTarget = z.object({ kind: z.enum(["track", "group"]), id: reference }).strict();
const processingTarget = z.union([
  processingTargetSchema.options[0].extend({ id: reference }),
  processingTargetSchema.options[1],
]);
const exactAnchor = z.discriminatedUnion("kind", [
  anchorSchema.options[0],
  z.object({ ...anchorSchema.options[1].shape, clipId: reference }).strict(),
  z.object({ ...anchorSchema.options[2].shape, clipId: reference }).strict(),
]);
const authoredCompressor = processorRegistry.compressor.schema.extend({
  detector: z.discriminatedUnion("kind", [
    processorRegistry.compressor.schema.shape.detector.options[0],
    z
      .object({
        kind: z.literal("tap"),
        tap: processingTapSchema.extend({
          target: processingTarget,
          point: z.discriminatedUnion("kind", [
            processingTapSchema.shape.point.options[0],
            processingTapSchema.shape.point.options[1],
            processingTapSchema.shape.point.options[2].extend({ stepId: reference }),
          ]),
        }),
      })
      .strict(),
  ]),
});
const authoredStep = processingStepSchema.extend({
  processor: z.union([processingStepSchema.shape.processor, authoredCompressor]),
  window: exactAnchor.optional(),
  id: reference.optional(),
  enabled: z.boolean().default(true),
  label,
});
const routedNode = routingNodeSchema.omit({ id: true }).extend({ parentId: reference.optional() });
const ripple = z.union([
  z.literal("none"),
  z.object({ trackIds: z.array(reference).min(1) }).strict(),
]);
const placedMedia = mediaClipSchema.omit({ id: true }).extend({
  trackId: reference,
  placement: exactAnchor,
});
const placedClip = z.union([
  placedMedia,
  textClipSchema.omit({ id: true }).extend({ trackId: reference, placement: exactAnchor }),
  silenceClipSchema.omit({ id: true }).extend({ trackId: reference, placement: exactAnchor }),
]);
const transition = {
  target: processingTarget,
  window: authoredStep.shape.window.unwrap(),
  from: z.number().finite(),
  to: z.number().finite(),
  interpolation: interpolationSchema.default("linear"),
  label,
};
const transitionRecipe = z
  .object({
    operation: z.literal("transition"),
    kind: z.enum(["crossfade", "dip", "flash", "zoom", "whip"]),
    targets: z.array(processingTarget).min(1).max(2),
    mediaKind: z.enum(["audio", "video"]),
    window: exactAnchor,
    interpolation: interpolationSchema.default("linear"),
    from: z.number().finite().optional(),
    to: z.number().finite().optional(),
    geometry: processorRegistry.geometry.schema.omit({ type: true, scale: true }).optional(),
    direction: z.enum(["left", "right", "up", "down"]).optional(),
    distance: z.number().finite().positive().optional(),
    overscan: z.number().finite().min(1).max(16).optional(),
    label,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === "crossfade" && value.targets.length !== 2)
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Crossfade requires two targets" });
    if (value.kind !== "crossfade" && value.targets.length !== 1)
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Transition requires one target" });
    if (value.kind === "zoom") {
      if (
        value.mediaKind !== "video" ||
        value.from === undefined ||
        value.to === undefined ||
        value.from < 1 ||
        value.to < 1
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Zoom requires video from/to scales at least 1",
        });
    }
    if (value.kind === "whip") {
      if (
        value.mediaKind !== "video" ||
        value.direction === undefined ||
        value.distance === undefined ||
        value.overscan === undefined
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Whip requires video direction, distance and overscan",
        });
    }
  });
const angleMember = z
  .object({
    clipId: reference,
    offsetUs: signedTimeValueSchema.optional(),
    validRange: selectionRangeSchema.optional(),
    segments: z
      .array(
        z.object({ offsetUs: signedTimeValueSchema, validRange: selectionRangeSchema }).strict(),
      )
      .min(1)
      .optional(),
  })
  .strict()
  .superRefine((member, context) => {
    const piecewise = member.segments !== undefined;
    if (piecewise && (member.offsetUs !== undefined || member.validRange !== undefined))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Piecewise angle member cannot also set offsetUs/validRange",
      });
    if (!piecewise && (member.offsetUs === undefined || member.validRange === undefined))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Angle member requires offsetUs and validRange",
      });
  });
export const editOperationSchema = z.discriminatedUnion("operation", [
  z
    .object({ operation: z.literal("text.set"), clipId: reference, source: textSourceSchema })
    .strict(),
  z
    .object({ operation: z.literal("fade"), ...transition, mediaKind: z.enum(["audio", "video"]) })
    .strict(),
  z
    .object({
      operation: z.literal("zoom"),
      ...transition,
      geometry: processorRegistry.geometry.schema.omit({ type: true, scale: true }).optional(),
    })
    .strict(),
  transitionRecipe,
  z
    .object({
      operation: z.literal("angle.declare"),
      sessionId: z.string().min(1),
      mapping: z.literal("piecewise-local").optional(),
      originClipId: reference,
      evidence: synchronizationEvidenceSchema,
      members: z.array(angleMember).min(2),
      label,
    })
    .strict()
    .superRefine((operation, context) => {
      const hasSegments = operation.members.some((member) => member.segments !== undefined);
      if (hasSegments && operation.mapping !== "piecewise-local")
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Piecewise angle declaration must declare mapping",
        });
      if (operation.mapping === "piecewise-local" && !hasSegments)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Piecewise angle declaration requires segments",
        });
      if (
        operation.mapping === "piecewise-local" &&
        operation.members.some((member) => member.segments === undefined)
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Piecewise angle declaration requires segments for every member",
        });
    }),
  z.object({ operation: z.literal("angle.remove"), angleGroupId: reference }).strict(),
  z
    .object({
      operation: z.literal("processing.set"),
      target: processingTarget,
      steps: z.array(authoredStep),
    })
    .strict(),
  z
    .object({
      operation: z.literal("replace"),
      clipId: reference,
      kind: z.enum(["audio", "video"]),
      media: placedMedia.pick({ assetId: true, streamId: true, acquisitionId: true, source: true }),
      fit: z.enum(["exact", "trim", "stretch", "ripple", "hold", "silence"]).default("exact"),
      ripple: z
        .object({ trackIds: z.array(reference).min(1) })
        .strict()
        .optional(),
      pitch: z.enum(["preserve", "follow"]).optional(),
      processing: z.enum(["keep", "reset"]).default("keep"),
    })
    .strict()
    .refine(
      (value) => (value.fit === "ripple") === (value.ripple !== undefined),
      "Ripple replacement requires named tracks; other fits do not take ripple",
    ),
  z
    .object({
      operation: z.literal("insert"),
      atUs: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      durationUs: z.int().positive().max(Number.MAX_SAFE_INTEGER),
      ripple: z.object({ trackIds: z.array(reference).min(1) }).strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("retime"),
      clipIds: z.array(reference).min(1),
      durationUs: z.int().positive().max(Number.MAX_SAFE_INTEGER),
      scope: z.enum(["linked", "selected"]).default("linked"),
      pitch: z.enum(["preserve", "follow"]).default("preserve"),
      ripple,
    })
    .strict(),
  z
    .object({
      operation: z.literal("duplicate"),
      clipIds: z.array(reference).min(1),
      atUs: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      scope: z.enum(["linked", "selected"]).default("selected"),
      tracks: z.array(z.object({ clipId: reference, trackId: reference }).strict()).default([]),
      copyLabels: z
        .array(z.object({ clipId: reference, label: z.string().min(1) }).strict())
        .default([]),
    })
    .strict(),
  z.object({ operation: z.literal("detach"), clipIds: z.array(reference).min(1) }).strict(),
  z
    .object({ operation: z.literal("reanchor"), clipId: reference, placement: exactAnchor })
    .strict(),
  z
    .object({
      operation: z.literal("move"),
      clipIds: z.array(reference).min(1),
      atUs: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      scope: z.enum(["linked", "selected"]).default("linked"),
      ripple,
      tracks: z.array(z.object({ clipId: reference, trackId: reference }).strict()).default([]),
    })
    .strict(),
  z
    .object({
      operation: z.literal("trim"),
      clipId: reference,
      range: rangeSchema,
      scope: z.enum(["linked", "selected"]).default("linked"),
      ripple,
    })
    .strict(),
  z
    .object({
      operation: z.literal("remove"),
      clipIds: z.array(reference).min(1),
      ranges: z.array(selectionRangeSchema).min(1).max(1000).optional(),
      scope: z.enum(["linked", "selected"]).default("linked"),
      ripple,
    })
    .strict(),
  z
    .object({
      operation: z.literal("split"),
      clipIds: z.array(reference).min(1),
      atUs: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      scope: z.enum(["linked", "selected"]).default("linked"),
      rightLabels: z
        .array(z.object({ clipId: reference, label: z.string().min(1) }).strict())
        .default([]),
    })
    .strict(),
  z
    .object({
      operation: z.literal("track.add"),
      track: routedNode,
      label,
    })
    .strict(),
  z.object({ operation: z.literal("track.remove"), trackId: reference }).strict(),
  z.object({ operation: z.literal("group.add"), group: routedNode, label }).strict(),
  z.object({ operation: z.literal("group.remove"), groupId: reference }).strict(),
  z
    .object({
      operation: z.literal("routing.set"),
      target: routingTarget,
      parentId: reference.optional(),
      order: routingNodeSchema.shape.order,
    })
    .strict(),
  z
    .object({
      operation: z.literal("layers.reorder"),
      parentId: reference.optional(),
      targets: z.array(routingTarget),
    })
    .strict(),
  z
    .object({
      operation: z.literal("canvas.set"),
      canvas: compositionSchema.shape.canvas.partial(),
    })
    .strict(),
  z.object({ operation: z.literal("place"), clip: placedClip, label }).strict(),
  z.object({ operation: z.literal("link"), clipIds: z.array(reference).min(2), label }).strict(),
  z.object({ operation: z.literal("unlink"), clipIds: z.array(reference).min(1) }).strict(),
]);
export type EditOperation = z.infer<typeof editOperationSchema>;
export type EditChange =
  | {
      kind: "processing";
      target: Document["processing"][number]["target"];
      steps: Document["processing"][number]["steps"];
    }
  | { kind: "canvas"; value: Document["canvas"] }
  | { kind: "track"; id: string; value: Document["tracks"][number] | null }
  | { kind: "group"; id: string; value: Document["groups"][number] | null }
  | { kind: "clip"; id: string; value: Document["clips"][number] | null }
  | { kind: "syncGroup"; id: string; value: Document["syncGroups"][number] | null }
  | {
      kind: "angleGroup";
      id: string;
      value: NonNullable<Document["angleGroups"]>[number] | null;
    };
export type EditBatchResult = {
  document: Document;
  changed: boolean;
  issues: Issue[];
  createdIds: { kind: EntityKind; id: string }[];
  labels: Record<string, string>;
  normalized: { operationIndex: number; changes: EditChange[] }[];
  clipLineage: { originalId: string; clipIds: string[] }[];
  removedAttachments: string[];
  processingLineage: { originalId: string; stepId: string }[];
  touchedFixedAnchors: { kind: "clip"; id: string }[];
  linkChanges: Extract<EditChange, { kind: "syncGroup" }>[];
};
function invalid(message: string, details: Record<string, unknown> = {}): never {
  throw new CompositionError("INVALID_EDIT", message, details);
}
function difference<T extends { id: string }>(
  before: readonly T[],
  after: readonly T[],
): { id: string; value: T | null }[] {
  const previous = new Map(before.map((value) => [value.id, JSON.stringify(value)]));
  const result: { id: string; value: T | null }[] = [];
  for (const value of after) {
    if (previous.get(value.id) !== JSON.stringify(value)) result.push({ id: value.id, value });
    previous.delete(value.id);
  }
  for (const id of previous.keys()) result.push({ id, value: null });
  return result;
}
function changes(before: Document, after: Document): EditChange[] {
  const result: EditChange[] = [
    ...difference(before.tracks, after.tracks).map((change) => ({
      kind: "track" as const,
      ...change,
    })),
    ...difference(before.groups, after.groups).map((change) => ({
      kind: "group" as const,
      ...change,
    })),
    ...difference(before.clips, after.clips).map((change) => ({
      kind: "clip" as const,
      ...change,
    })),
    ...difference(before.syncGroups, after.syncGroups).map((change) => ({
      kind: "syncGroup" as const,
      ...change,
    })),
    ...difference(before.angleGroups ?? [], after.angleGroups ?? []).map((change) => ({
      kind: "angleGroup" as const,
      ...change,
    })),
  ];
  const previous = new Map(before.processing.map((stack) => [processingKey(stack.target), stack]));
  for (const stack of after.processing) {
    const key = processingKey(stack.target);
    if (JSON.stringify(previous.get(key)) !== JSON.stringify(stack))
      result.push({ kind: "processing", ...stack });
    previous.delete(key);
  }
  for (const stack of previous.values())
    result.push({ kind: "processing", target: stack.target, steps: [] });
  if (JSON.stringify(before.canvas) !== JSON.stringify(after.canvas))
    result.unshift({ kind: "canvas", value: after.canvas });
  return result;
}

/** Identity namespace is supplied by the transaction owner and reused on replay. */
export function applyBatch(
  input: unknown,
  operations: unknown,
  identityContext: { assets: unknown; acquisitions?: unknown; namespace: string },
): EditBatchResult {
  if (
    typeof identityContext.namespace !== "string" ||
    !identityContext.namespace ||
    identityContext.namespace.length > 256
  )
    invalid("Expected a nonempty identity namespace up to 256 characters");
  const parsed = z.array(editOperationSchema).max(1000).safeParse(operations);
  if (!parsed.success) invalid(parsed.error.message);
  let model = validateComposition(input, identityContext.assets, identityContext.acquisitions);
  const initial = model.document;
  const identities = {
    clip: new Set(initial.clips.map((value) => value.id)),
    track: new Set(initial.tracks.map((value) => value.id)),
    processingStep: new Set(
      initial.processing.flatMap((stack) =>
        stack.steps.flatMap((step) =>
          step.stateKey === undefined ? [step.id] : [step.id, step.stateKey],
        ),
      ),
    ),
    group: new Set(initial.groups.map((value) => value.id)),
    syncGroup: new Set(initial.syncGroups.map((value) => value.id)),
    angleGroup: new Set((initial.angleGroups ?? []).map((value) => value.id)),
  };
  const createdIds: EditBatchResult["createdIds"] = [];
  const issues: Issue[] = [];
  const bindings = new Map<string, { kind: EntityKind; id: string }>();
  const normalized: EditBatchResult["normalized"] = [];
  const clipLineage: EditBatchResult["clipLineage"] = [];
  const removedAttachments: string[] = [];
  const processingLineage: EditBatchResult["processingLineage"] = [];
  const touchedFixedAnchors = new Map<string, { kind: "clip"; id: string }>();
  let ordinal = 0;
  const resolve = (value: z.infer<typeof reference>, kind: EntityKind): string => {
    if (typeof value === "string") return value;
    const bound = bindings.get(value.label);
    if (!bound || bound.kind !== kind)
      invalid("Operation label does not name the requested entity kind", {
        label: value.label,
        kind,
      });
    return bound.id;
  };
  const bind = (name: string | undefined, kind: EntityKind, id: string) => {
    if (name === undefined) return;
    if (bindings.has(name)) invalid("Operation label was already bound", { label: name });
    bindings.set(name, { kind, id });
  };
  const allocate = (kind: EntityKind, copiedFrom?: string): string => {
    const id = `${kind}:${identityContext.namespace}:${ordinal++}`;
    if (identities[kind].has(id))
      invalid("Identity namespace collides with an existing entity", { kind, id });
    identities[kind].add(id);
    createdIds.push({ kind, id });
    if (kind === "processingStep" && copiedFrom !== undefined)
      processingLineage.push({ originalId: copiedFrom, stepId: id });
    return id;
  };
  const clips = (refs: z.infer<typeof reference>[], allowMissing = false) => {
    const ids = refs.map((value) => resolve(value, "clip"));
    if (new Set(ids).size !== ids.length) invalid("Repeated clip reference");
    const known = new Set(model.document.clips.map((clip) => clip.id));
    for (const id of ids)
      if (!allowMissing && !known.has(id)) invalid("Unknown clip", { clipId: id });
    return ids;
  };
  const placeClip = (
    operation: Extract<z.infer<typeof editOperationSchema>, { operation: "place" }>,
    operationIndex: number,
  ) => {
    const id = allocate("clip");
    bind(operation.label, "clip", id);
    const anchor = operation.clip.placement;
    const placed = {
      ...operation.clip,
      id,
      trackId: resolve(operation.clip.trackId, "track"),
      placement:
        anchor.kind === "project" ? anchor : { ...anchor, clipId: resolve(anchor.clipId, "clip") },
    };
    return fitClip(placed, operationIndex).clip;
  };
  const unit: Interval = { start: rational(0n), end: rational(1n) };
  const sourceDomain = (clip: object) => {
    if (!("assetId" in clip)) return null;
    const media = clip as Pick<MediaClip, "assetId" | "streamId" | "source">;
    const stream = model.assets
      .find((asset) => asset.id === media.assetId)
      ?.streams.find((value) => value.id === media.streamId);
    if (!stream || stream.kind === "image" || media.source.kind !== "range") return null;
    return { requested: interval(media.source.range), bounds: interval(stream.bounds) };
  };
  const contentDomain = (anchor: Anchor) => {
    if (anchor.kind !== "content") return null;
    const parent = model.clips.find((value) => value.clip.id === anchor.clipId)?.clip;
    if (parent?.source.kind !== "range") return null;
    return { requested: interval(anchor.sourceRange), bounds: interval(parent.source.range) };
  };
  /**
   * Authored selections past their domain are shortened to it, never extended or held. A
   * placement maps linearly onto its source, so each domain a clip must fit (a media source within
   * its stream, a content anchor within its parent's selected source) keeps a fraction of it. The
   * clip keeps the overlap of those fractions, and each range that overran reports range-clamped.
   * Replacement media has no placement yet; only its source is fitted.
   */
  const fitClip = <T extends { placement?: Anchor; source: unknown }>(
    clip: T,
    operationIndex: number,
  ) => {
    const media = sourceDomain(clip),
      content = clip.placement ? contentDomain(clip.placement) : null;
    const domains = [media, content].flatMap((domain) =>
      domain ? [{ ...domain, ...admitRange(domain.requested, domain.bounds) }] : [],
    );
    let kept = unit;
    for (const domain of domains) {
      const fraction = keepSameFraction(domain.requested, domain.range, unit);
      kept = {
        start: compare(fraction.start, kept.start) > 0 ? fraction.start : kept.start,
        end: compare(fraction.end, kept.end) < 0 ? fraction.end : kept.end,
      };
    }
    // Each domain alone keeps a nonempty part, so only both together can keep nothing.
    if (compare(kept.start, kept.end) >= 0)
      throw new CompositionError(
        "INVALID_RANGE",
        "The source and the content anchor keep no common part of the placement",
        {
          source: { requested: wire(media!.requested), bounds: wire(media!.bounds) },
          anchor: { requested: wire(content!.requested), bounds: wire(content!.bounds) },
        },
      );
    if (!domains.some((domain) => domain.clamped)) return { clip, kept };
    const keep = (range: Interval) => keepSameFraction(unit, kept, range);
    for (const domain of domains)
      if (domain.clamped)
        issues.push(
          rangeClampedIssue(
            domain.requested,
            keep(domain.requested),
            domain.bounds,
            operationIndex,
          ),
        );
    const placement = clip.placement;
    const fitted =
      placement?.kind === "project"
        ? { ...placement, range: wire(keep(interval(placement.range))) }
        : placement?.kind === "content"
          ? { ...placement, sourceRange: wire(keep(interval(placement.sourceRange))) }
          : placement && {
              ...placement,
              ...(() => {
                const span = keep({
                  start: fromTime(placement.start),
                  end: fromTime(placement.end),
                });
                return { start: toFraction(span.start), end: toFraction(span.end) };
              })(),
            };
    return {
      kept,
      clip: {
        ...clip,
        ...(media
          ? { source: { ...(clip.source as object), range: wire(keep(media.requested)) } }
          : {}),
        ...(fitted ? { placement: fitted } : {}),
      } as T,
    };
  };
  const addTrack = (
    operation: Extract<z.infer<typeof editOperationSchema>, { operation: "track.add" }>,
  ) => {
    const id = allocate("track");
    bind(operation.label, "track", id);
    const { parentId, ...track } = operation.track;
    return {
      ...track,
      id,
      ...(parentId === undefined ? {} : { parentId: resolve(parentId, "group") }),
    };
  };
  const processingStack = (
    operation: Extract<z.infer<typeof editOperationSchema>, { operation: "processing.set" }>,
  ) => {
    const target =
      operation.target.kind === "output"
        ? operation.target
        : {
            kind: operation.target.kind,
            id: resolve(operation.target.id, operation.target.kind),
          };
    const previousSteps = new Map(getProcessing(model, target).map((step) => [step.id, step]));
    const existing = new Set(previousSteps.keys());
    const used = new Set<string>();
    const steps = operation.steps.map((step) => {
      const id =
        step.id === undefined ? allocate("processingStep") : resolve(step.id, "processingStep");
      if (step.id !== undefined && !existing.has(id))
        invalid(
          "Processing step id names no existing step on this target; omit id to add a new step",
          { target, stepId: id },
        );
      if (used.has(id)) invalid("Repeated processing step ID", { stepId: id });
      used.add(id);
      bind(step.label, "processingStep", id);
      const prior = previousSteps.get(id);
      const processor = ((): z.infer<typeof processingStepSchema>["processor"] => {
        const authored = step.processor;
        if (authored.type !== "compressor") return authored;
        const { detector, ...parameters } = authored;
        if (detector.kind === "input") return { ...parameters, detector };
        const { target, point } = detector.tap;
        return {
          ...parameters,
          detector: {
            kind: "tap",
            tap: {
              target:
                target.kind === "output"
                  ? target
                  : { ...target, id: resolve(target.id, target.kind) },
              point:
                point.kind === "after-step"
                  ? { ...point, stepId: resolve(point.stepId, "processingStep") }
                  : point,
            },
          },
        };
      })();
      if (
        step.stateKey !== undefined &&
        (!isStatefulProcessor(step.processor) || prior?.stateKey !== step.stateKey)
      )
        invalid("State continuity metadata may only preserve the existing instance", {
          target,
          stepId: id,
        });
      return {
        ...(isStatefulProcessor(step.processor) && prior?.stateKey !== undefined
          ? { stateKey: prior.stateKey }
          : {}),
        id,
        enabled: step.enabled,
        processor,
        ...(step.window
          ? {
              window:
                step.window.kind === "project"
                  ? step.window
                  : { ...step.window, clipId: resolve(step.window.clipId, "clip") },
            }
          : {}),
        ...(step.evaluationRange ? { evaluationRange: step.evaluationRange } : {}),
      };
    });
    return { target, steps };
  };
  const replaceProcessing = (
    before: Document,
    updates: ReturnType<typeof processingStack>[],
  ): Document => {
    const stacks = new Map(before.processing.map((stack) => [processingKey(stack.target), stack]));
    for (const stack of updates) {
      const key = processingKey(stack.target);
      if (stack.steps.length) stacks.set(key, stack);
      else stacks.delete(key);
    }
    return {
      ...before,
      processing: [...stacks.values()].sort((a, b) =>
        processingKey(a.target) < processingKey(b.target)
          ? -1
          : processingKey(a.target) > processingKey(b.target)
            ? 1
            : 0,
      ),
    };
  };
  const resolveIndependent = (
    document: (count: number) => Document,
    count: number,
    start: number,
  ) => {
    const prefix = (length: number) =>
      resolveComposition(document(length), model.assets, model.acquisitions);
    try {
      return { model: prefix(count) };
    } catch (error) {
      if (!(error instanceof CompositionError)) throw error;
      let first = 1,
        last = count,
        failure = error;
      while (first < last) {
        const middle = Math.floor((first + last) / 2);
        try {
          prefix(middle);
          first = middle + 1;
        } catch (error) {
          if (!(error instanceof CompositionError)) throw error;
          last = middle;
          failure = error;
        }
      }
      return { failure, operationIndex: start + first - 1 };
    }
  };
  for (let operationIndex = 0; operationIndex < parsed.data.length; operationIndex++) {
    const authored = parsed.data[operationIndex]!;
    const before = model.document;
    let next: Document = before;
    try {
      if (
        authored.operation === "move" &&
        authored.ripple === "none" &&
        authored.clipIds.length === 1 &&
        authored.tracks.length === 0 &&
        before.processing.length === 0
      ) {
        const graph = clipGraph(model);
        const linked = new Set(before.syncGroups.flatMap((group) => group.clipIds));
        const known = new Map(model.clips.map((clip) => [clip.clip.id, clip]));
        const ranges = new Map(model.clips.map((clip) => [clip.clip.id, clip.range]));
        const neighbors = new Map<string, { previous?: string; next?: string }>();
        const last = new Map<string, string>();
        for (const value of model.clips) {
          const previous = last.get(value.track.id);
          neighbors.set(value.clip.id, previous === undefined ? {} : { previous });
          if (previous !== undefined) neighbors.get(previous)!.next = value.clip.id;
          last.set(value.track.id, value.clip.id);
        }
        const updates = new Map<string, Document["clips"][number]>();
        const start = operationIndex;
        let end = start;
        for (; end < parsed.data.length; end++) {
          const item = parsed.data[end]!;
          if (
            item.operation !== "move" ||
            item.ripple !== "none" ||
            item.clipIds.length !== 1 ||
            item.tracks.length !== 0
          )
            break;
          const id = item.clipIds[0]!;
          if (typeof id !== "string" || updates.has(id) || linked.has(id)) break;
          const value = known.get(id);
          if (!value || value.clip.placement.kind !== "project" || graph.children.has(id)) break;
          const first = fromTime(item.atUs);
          const range = {
            start: first,
            end: add(first, subtract(value.range.end, value.range.start)),
          };
          const adjacent = neighbors.get(id)!;
          // Preserve order and every intermediate prefix, not merely the final arrangement.
          // A crossing/overlap is left to scalar semantics: a later move could otherwise repair it.
          if (
            (adjacent.previous && compare(ranges.get(adjacent.previous)!.end, range.start) > 0) ||
            (adjacent.next && compare(range.end, ranges.get(adjacent.next)!.start) > 0)
          )
            break;
          let placement;
          try {
            placement = placementForRange(value.clip, range);
          } catch {
            break;
          } // The ordinary operation below owns the exact refusal and error index.
          updates.set(id, { ...value.clip, placement });
          ranges.set(id, range);
        }
        if (updates.size) {
          const entries = [...updates];
          const resolved = resolveIndependent(
            (count) => {
              const prefix = new Map(entries.slice(0, count));
              return { ...before, clips: before.clips.map((clip) => prefix.get(clip.id) ?? clip) };
            },
            updates.size,
            start,
          );
          if (resolved.failure) {
            operationIndex = resolved.operationIndex;
            throw resolved.failure;
          }
          model = resolved.model;
          const frozen = new Map(model.document.clips.map((clip) => [clip.id, clip]));
          for (const [offset, [id]] of entries.entries()) {
            const value = frozen.get(id)!;
            normalized.push({
              operationIndex: start + offset,
              changes:
                JSON.stringify(known.get(id)!.clip) === JSON.stringify(value)
                  ? []
                  : [{ kind: "clip", id, value }],
            });
          }
          operationIndex = end - 1;
          continue;
        }
      }
      if (authored.operation === "processing.set" && !hasStatefulProcessing(before)) {
        const known = new Set([
          processingKey({ kind: "output" }),
          ...before.tracks.map((node) => processingKey({ kind: "track", id: node.id })),
          ...before.groups.map((node) => processingKey({ kind: "group", id: node.id })),
          ...before.clips.map((clip) => processingKey({ kind: "clip", id: clip.id })),
        ]);
        const selected = new Set<string>();
        const updates: ReturnType<typeof processingStack>[] = [];
        const start = operationIndex;
        let end = start;
        let constructionFailure: { index: number; error: unknown } | undefined;
        for (; end < parsed.data.length; end++) {
          const item = parsed.data[end]!;
          if (item.operation !== "processing.set") break;
          const target = item.target;
          let key: string;
          if (target.kind === "output") key = processingKey(target);
          else {
            const id = target.id;
            if (typeof id !== "string") break;
            key = processingKey({ kind: target.kind, id });
          }
          if (
            item.steps.some(
              (step) =>
                isStatefulProcessor(step.processor) ||
                (step.id !== undefined && typeof step.id !== "string") ||
                (step.window &&
                  step.window.kind !== "project" &&
                  typeof step.window.clipId !== "string"),
            )
          )
            break;
          if (!known.has(key) || selected.has(key)) break;
          selected.add(key);
          try {
            updates.push(processingStack(item));
          } catch (error) {
            constructionFailure = { index: end, error };
            break;
          }
        }
        if (updates.length) {
          // Fixed structure and distinct stateless targets cannot repair an invalid prefix.
          const resolved = resolveIndependent(
            (count) => replaceProcessing(before, updates.slice(0, count)),
            updates.length,
            start,
          );
          if (resolved.failure) {
            operationIndex = resolved.operationIndex;
            throw resolved.failure;
          }
          model = resolved.model;
        }
        if (constructionFailure) {
          operationIndex = constructionFailure.index;
          throw constructionFailure.error;
        }
        if (updates.length) {
          const previous = new Map(
            before.processing.map((stack) => [processingKey(stack.target), stack]),
          );
          const current = new Map(
            model.document.processing.map((stack) => [processingKey(stack.target), stack]),
          );
          for (const [offset, update] of updates.entries()) {
            const key = processingKey(update.target),
              stack = current.get(key);
            normalized.push({
              operationIndex: start + offset,
              changes:
                JSON.stringify(previous.get(key)) === JSON.stringify(stack)
                  ? []
                  : [
                      {
                        kind: "processing",
                        ...(stack ?? { target: previous.get(key)!.target, steps: [] }),
                      },
                    ],
            });
          }
          operationIndex = end - 1;
          continue;
        }
      }
      // Appends preserve stateless receipts. A place naming an unknown literal track
      // stays scalar: a later track addition could repair that invalid prefix.
      if (
        !hasStatefulProcessing(before) &&
        (authored.operation === "track.add" ||
          (authored.operation === "place" &&
            authored.clip.placement.kind === "project" &&
            (typeof authored.clip.trackId !== "string" ||
              before.tracks.some((track) => track.id === authored.clip.trackId))))
      ) {
        const start = operationIndex;
        const appended: (
          | { kind: "track"; value: ReturnType<typeof addTrack> }
          | { kind: "clip"; value: ReturnType<typeof placeClip> }
        )[] = [];
        const knownTracks = new Set(before.tracks.map((track) => track.id));
        let constructionFailure: { index: number; error: unknown } | undefined;
        let end = start;
        for (; end < parsed.data.length; end++) {
          const item = parsed.data[end]!;
          if (
            item.operation !== "track.add" &&
            (item.operation !== "place" ||
              item.clip.placement.kind !== "project" ||
              (typeof item.clip.trackId === "string" && !knownTracks.has(item.clip.trackId)))
          )
            break;
          try {
            if (item.operation === "track.add") {
              const track = addTrack(item);
              appended.push({ kind: "track", value: track });
              knownTracks.add(track.id);
            } else {
              appended.push({ kind: "clip", value: placeClip(item, end) });
            }
          } catch (error) {
            constructionFailure = { index: end, error };
            break;
          }
        }
        if (appended.length) {
          const resolved = resolveIndependent(
            (count) => {
              const prefix = appended.slice(0, count);
              return {
                ...before,
                tracks: [
                  ...before.tracks,
                  ...prefix.flatMap((item) => (item.kind === "track" ? [item.value] : [])),
                ],
                clips: [
                  ...before.clips,
                  ...prefix.flatMap((item) => (item.kind === "clip" ? [item.value] : [])),
                ],
              };
            },
            appended.length,
            start,
          );
          if (resolved.failure) {
            operationIndex = resolved.operationIndex;
            throw resolved.failure;
          }
          model = resolved.model;
        }

        if (constructionFailure) {
          operationIndex = constructionFailure.index;
          throw constructionFailure.error;
        }
        // Capture the validated run before subsequent operations replace/remove its additions.
        let trackIndex = before.tracks.length,
          clipIndex = before.clips.length;
        for (let offset = 0; offset < appended.length; offset++) {
          const kind = appended[offset]!.kind;
          const change: EditChange =
            kind === "track"
              ? {
                  kind,
                  id: model.document.tracks[trackIndex]!.id,
                  value: model.document.tracks[trackIndex++]!,
                }
              : {
                  kind,
                  id: model.document.clips[clipIndex]!.id,
                  value: model.document.clips[clipIndex++]!,
                };
          normalized.push({ operationIndex: start + offset, changes: [change] });
        }
        operationIndex = end - 1;
        continue;
      }
      if (authored.operation === "transition") {
        const operation = authored;
        const targets = operation.targets.map((target) =>
          target.kind === "output"
            ? target
            : { kind: target.kind, id: resolve(target.id, target.kind) },
        );
        if (new Set(targets.map((target) => processingKey(target))).size !== targets.length)
          invalid("Transition targets must be distinct");
        const window =
          operation.window.kind === "project"
            ? operation.window
            : { ...operation.window, clipId: resolve(operation.window.clipId, "clip") };
        const transitionRange = resolvePlacement(model, window).range;
        for (const target of targets) {
          if (target.kind !== "clip") continue;
          const clip = model.clips.find((value) => value.clip.id === target.id);
          if (
            !clip ||
            compare(transitionRange.start, clip.range.start) < 0 ||
            compare(transitionRange.end, clip.range.end) > 0
          )
            invalid("Transition window exceeds a target's available handle", { target });
        }
        if (operation.kind === "zoom" || operation.kind === "whip") {
          if (
            operation.mediaKind !== "video" ||
            targets.length !== 1 ||
            targets[0]!.kind === "output"
          )
            invalid("Trajectory requires one video target");
          const target = targets[0]!;
          const [start, end] =
            window.kind === "clip"
              ? [window.start, window.end]
              : window.kind === "content"
                ? [window.sourceRange.startUs, window.sourceRange.endUs]
                : [window.range.startUs, window.range.endUs];
          if (window.kind !== "clip" && (typeof start !== "number" || typeof end !== "number"))
            invalid(
              "Trajectory endpoints must be whole microseconds; use a clip anchor for fractional boundaries",
            );
          const curve = {
            keys: [
              {
                at: start,
                value: operation.kind === "zoom" ? operation.from! : 0,
                interpolation: operation.interpolation,
              },
              {
                at: end,
                value: operation.kind === "zoom" ? operation.to! : 0,
                interpolation: "hold" as const,
              },
            ],
          };
          const processor =
            operation.kind === "zoom"
              ? { type: "geometry" as const, ...operation.geometry, scale: { x: curve, y: curve } }
              : (() => {
                  const width = operation.geometry?.rect?.width ?? model.document.canvas.width;
                  const height = operation.geometry?.rect?.height ?? model.document.canvas.height;
                  if (
                    typeof width !== "number" ||
                    typeof height !== "number" ||
                    !Number.isFinite(width) ||
                    !Number.isFinite(height) ||
                    width <= 0 ||
                    height <= 0
                  )
                    invalid("Whip coverage requires fixed positive geometry rectangle dimensions");
                  const dimension =
                    operation.direction === "left" || operation.direction === "right"
                      ? width
                      : height;
                  const maximum = ((operation.overscan! - 1) * dimension) / 2;
                  if (operation.distance! > maximum)
                    invalid(
                      "Whip distance exceeds overscan coverage; increase overscan or reduce distance",
                      {
                        distance: operation.distance,
                        maximum,
                      },
                    );
                  const signed =
                    operation.direction === "left" || operation.direction === "up"
                      ? operation.distance!
                      : -operation.distance!;
                  const x =
                    operation.direction === "left" || operation.direction === "right"
                      ? {
                          keys: [
                            { at: start, value: signed, interpolation: operation.interpolation },
                            { at: end, value: 0, interpolation: "hold" as const },
                          ],
                        }
                      : 0;
                  const y =
                    operation.direction === "up" || operation.direction === "down"
                      ? {
                          keys: [
                            { at: start, value: signed, interpolation: operation.interpolation },
                            { at: end, value: 0, interpolation: "hold" as const },
                          ],
                        }
                      : 0;
                  return {
                    type: "geometry" as const,
                    ...operation.geometry,
                    rect: {
                      x,
                      y,
                      width: operation.geometry?.rect?.width ?? model.document.canvas.width,
                      height: operation.geometry?.rect?.height ?? model.document.canvas.height,
                    },
                    scale: { x: operation.overscan!, y: operation.overscan! },
                  };
                })();
          next = replaceProcessing(before, [
            processingStack({
              operation: "processing.set",
              target,
              steps: [...getProcessing(model, target), { enabled: true, window, processor }],
            }),
          ]);
        } else {
          const endpoints =
            window.kind === "clip"
              ? [window.start, window.end]
              : window.kind === "content"
                ? [window.sourceRange.startUs, window.sourceRange.endUs]
                : [window.range.startUs, window.range.endUs];
          if (
            window.kind !== "clip" &&
            (typeof endpoints[0] !== "number" || typeof endpoints[1] !== "number")
          )
            invalid(
              "Transition source/project endpoints must be whole microseconds; use a clip anchor for fractional boundaries",
            );
          const midpoint =
            operation.kind === "crossfade"
              ? undefined
              : (() => {
                  if (window.kind === "clip") {
                    const denominator =
                      2n * BigInt(window.start.denominator) * BigInt(window.end.denominator);
                    const numerator =
                      BigInt(window.start.numerator) * BigInt(window.end.denominator) +
                      BigInt(window.end.numerator) * BigInt(window.start.denominator);
                    const divisor = greatestCommonDivisor(
                      numerator < 0n ? -numerator : numerator,
                      denominator,
                    );
                    return {
                      numerator: Number(numerator / divisor),
                      denominator: Number(denominator / divisor),
                    };
                  }
                  const start = endpoints[0] as number,
                    end = endpoints[1] as number;
                  if ((start + end) % 2 !== 0)
                    invalid("Dip and flash require an even whole-microsecond midpoint");
                  return (start + end) / 2;
                })();
          const values =
            operation.kind === "crossfade"
              ? targets.map((_, index) => (index === 0 ? [1, 0] : [0, 1]))
              : targets.map(() => [1, 0, 1]);
          const updates = targets.map((target, index) => {
            const valuesForTarget = values[index]!;
            const at =
              valuesForTarget.length === 2 ? endpoints : [endpoints[0], midpoint!, endpoints[1]];
            const curve = {
              keys: valuesForTarget.map((value, keyIndex) => ({
                at: at[keyIndex]!,
                value,
                interpolation:
                  keyIndex === valuesForTarget.length - 1
                    ? ("hold" as const)
                    : operation.interpolation,
              })),
            };
            const processor =
              operation.mediaKind === "audio"
                ? { type: "gain" as const, gain: curve }
                : { type: "opacity" as const, opacity: curve };
            return processingStack({
              operation: "processing.set",
              target,
              steps: [
                ...getProcessing(model, target),
                {
                  enabled: true,
                  ...(index === 0 && operation.label ? { label: operation.label } : {}),
                  window,
                  processor,
                },
              ],
            });
          });
          next = replaceProcessing(before, updates);
        }
      } else {
        let operation = authored;
        if (operation.operation === "fade" || operation.operation === "zoom") {
          const target =
            operation.target.kind === "output"
              ? operation.target
              : {
                  kind: operation.target.kind,
                  id: resolve(operation.target.id, operation.target.kind),
                };
          const window = operation.window;
          const [start, end] =
            window.kind === "clip"
              ? [window.start, window.end]
              : window.kind === "content"
                ? [window.sourceRange.startUs, window.sourceRange.endUs]
                : [window.range.startUs, window.range.endUs];
          if (window.kind !== "clip" && (typeof start !== "number" || typeof end !== "number"))
            invalid(
              "Transition source/project endpoints must be whole microseconds; use ordinary keys with fractional activation bounds",
            );
          const curve = {
            keys: [
              { at: start, value: operation.from, interpolation: operation.interpolation },
              { at: end, value: operation.to, interpolation: "hold" as const },
            ],
          };
          const processor =
            operation.operation === "zoom"
              ? { type: "geometry" as const, ...operation.geometry, scale: { x: curve, y: curve } }
              : operation.mediaKind === "audio"
                ? { type: "gain" as const, gain: curve }
                : { type: "opacity" as const, opacity: curve };
          operation = {
            operation: "processing.set",
            target,
            steps: [
              ...getProcessing(model, target),
              { enabled: true, label: operation.label, window, processor },
            ],
          };
        }
        switch (operation.operation) {
          case "text.set": {
            const id = resolve(operation.clipId, "clip");
            const clip = before.clips.find((clip) => clip.id === id);
            if (clip?.source.kind !== "text")
              invalid("Text edits require a text clip", { clipId: id });
            next = {
              ...before,
              clips: before.clips.map((clip) =>
                clip.id === id ? { ...clip, source: operation.source } : clip,
              ),
            };
            break;
          }
          case "processing.set": {
            next = replaceProcessing(before, [processingStack(operation)]);
            break;
          }
          case "replace": {
            // Every fit sees the clamped source, so ripple sizes the clip from what plays.
            const media = fitClip(operation.media, operationIndex).clip;
            const result = replaceClip(
              operation.processing === "reset"
                ? resolveComposition(
                    {
                      ...before,
                      processing: before.processing.filter(
                        (stack) =>
                          stack.target.kind !== "clip" ||
                          stack.target.id !== resolve(operation.clipId, "clip"),
                      ),
                    },
                    model.assets,
                    model.acquisitions,
                  )
                : model,
              clips([operation.clipId])[0]!,
              operation.kind,
              media,
              operation.fit,
              allocate,
              operation.pitch,
            );
            next = result.document;
            removedAttachments.push(...result.removedAttachments);
            clipLineage.push(...result.lineage);
            if (operation.fit === "ripple") {
              if (media.source.kind !== "range")
                invalid("Ripple replacement needs a source range with a duration");
              const source = media.source.range;
              const resized = retimeClips(
                resolveComposition(next, model.assets, model.acquisitions),
                [resolve(operation.clipId, "clip")],
                {
                  durationUs: toTime(subtract(fromTime(source.endUs), fromTime(source.startUs))),
                  pitch: operation.pitch ?? "preserve",
                },
                "selected",
                operation.ripple!.trackIds.map((id) => resolve(id, "track")),
                allocate,
              );
              next = resized.document;
              for (const anchor of resized.touchedFixedAnchors)
                touchedFixedAnchors.set(anchor.id, anchor);
            }
            break;
          }
          case "insert": {
            const result = insertGap(
              model,
              operation.atUs,
              fromTime(operation.durationUs),
              operation.ripple.trackIds.map((id) => resolve(id, "track")),
              allocate,
            );
            next = result.document;
            clipLineage.push(...result.lineage);
            for (const anchor of result.touchedFixedAnchors)
              touchedFixedAnchors.set(anchor.id, anchor);
            break;
          }
          case "retime": {
            const result = retimeClips(
              model,
              clips(operation.clipIds),
              { durationUs: operation.durationUs, pitch: operation.pitch },
              operation.scope,
              operation.ripple === "none"
                ? "none"
                : operation.ripple.trackIds.map((id) => resolve(id, "track")),
              allocate,
            );
            next = result.document;
            for (const anchor of result.touchedFixedAnchors)
              touchedFixedAnchors.set(anchor.id, anchor);
            break;
          }
          case "duplicate": {
            const result = duplicateClips(
              model,
              clips(operation.clipIds),
              operation.atUs,
              operation.scope,
              operation.tracks.map((entry) => ({
                clipId: resolve(entry.clipId, "clip"),
                trackId: resolve(entry.trackId, "track"),
              })),
              allocate,
            );
            const copies = new Map(
              result.lineage.map((entry) => [entry.originalId, entry.clipIds[0]!]),
            );
            for (const entry of operation.copyLabels) {
              const originalId = resolve(entry.clipId, "clip");
              const id = copies.get(originalId);
              if (!id) invalid("Copy label target was not duplicated", { clipId: originalId });
              bind(entry.label, "clip", id);
            }
            next = result.document;
            clipLineage.push(...result.lineage);
            break;
          }
          case "reanchor": {
            const id = clips([operation.clipId])[0]!;
            const anchor = operation.placement;
            const resolvedAnchor =
              anchor.kind === "project"
                ? anchor
                : { ...anchor, clipId: resolve(anchor.clipId, "clip") };
            // An anchor past its parent's source shortens the clip; it keeps that part of its interval.
            let kept = unit;
            next = {
              ...before,
              clips: before.clips.map((clip) => {
                if (clip.id !== id) return clip;
                const fitted = fitClip({ ...clip, placement: resolvedAnchor }, operationIndex);
                kept = fitted.kept;
                return fitted.clip;
              }),
            };
            const candidate = validateComposition(next, model.assets, model.acquisitions);
            const oldRange = keepSameFraction(
              unit,
              kept,
              model.clips.find((value) => value.clip.id === id)!.range,
            );
            const newRange = candidate.clips.find((value) => value.clip.id === id)!.range;
            if (
              compare(oldRange.start, newRange.start) !== 0 ||
              compare(oldRange.end, newRange.end) !== 0
            )
              invalid(
                "Reanchor must preserve the current project interval; move or retime explicitly first",
                { clipId: id },
              );
            break;
          }
          case "detach": {
            const ids = new Set(clips(operation.clipIds));
            const resolved = new Map(model.clips.map((value) => [value.clip.id, value.range]));
            next = {
              ...before,
              clips: before.clips.map((clip) => {
                if (!ids.has(clip.id) || clip.placement.kind === "project") return clip;
                const range = resolved.get(clip.id)!;
                return {
                  ...clip,
                  placement: {
                    kind: "project" as const,
                    range: { startUs: toTime(range.start), endUs: toTime(range.end) },
                  },
                };
              }),
            };
            break;
          }
          case "move": {
            const transformed = transformSelection(
              model,
              clips(operation.clipIds),
              { atUs: operation.atUs },
              operation.scope,
              allocate,
              operation.tracks.map((entry) => ({
                clipId: resolve(entry.clipId, "clip"),
                trackId: resolve(entry.trackId, "track"),
              })),
            );
            if (operation.ripple === "none") next = transformed.document;
            else {
              const result = rippleMove(
                model,
                transformed,
                operation.atUs,
                operation.ripple.trackIds.map((id) => resolve(id, "track")),
                allocate,
              );
              next = result.document;
              clipLineage.push(...result.lineage);
              for (const anchor of result.touchedFixedAnchors)
                touchedFixedAnchors.set(anchor.id, anchor);
            }
            break;
          }
          case "remove":
          case "trim": {
            const ids =
              operation.operation === "remove"
                ? clips(operation.clipIds, true)
                : clips([operation.clipId]);
            let ranges: ExactRange[] | undefined;
            if (operation.operation === "remove") {
              ranges = operation.ranges?.map((range) => ({
                start: fromTime(range.startUs),
                end: fromTime(range.endUs),
              }));
            } else {
              const target = model.clips.find((value) => value.clip.id === ids[0])!.range;
              const requested = interval(operation.range);
              const { range: keep, clamped } = admitRange(requested, target);
              if (clamped) issues.push(rangeClampedIssue(requested, keep, target, operationIndex));
              ranges = [];
              if (compare(target.start, keep.start) < 0)
                ranges.push({ start: target.start, end: keep.start });
              if (compare(keep.end, target.end) < 0)
                ranges.push({ start: keep.end, end: target.end });
            }
            const result = partitionClips(
              model,
              ids,
              { kind: "remove", scope: operation.scope, ...(ranges ? { ranges } : {}) },
              allocate,
            );
            if (operation.ripple === "none") next = result.document;
            else {
              const shifted = rippleTimeline(
                resolveComposition(result.document, model.assets, model.acquisitions),
                { kind: "remove", ranges: result.removalRanges },
                operation.ripple.trackIds.map((id) => resolve(id, "track")),
              );
              next = shifted.document;
              for (const anchor of shifted.touchedFixedAnchors)
                touchedFixedAnchors.set(anchor.id, anchor);
            }
            clipLineage.push(...result.lineage);
            removedAttachments.push(...result.removedAttachments);
            break;
          }
          case "split": {
            const result = partitionClips(
              model,
              clips(operation.clipIds),
              { kind: "split", atUs: operation.atUs, scope: operation.scope },
              allocate,
            );
            for (const entry of operation.rightLabels) {
              const originalId = resolve(entry.clipId, "clip");
              const right = result.lineage.find((item) => item.originalId === originalId)
                ?.clipIds[1];
              if (!right)
                invalid("Label target did not split at the requested time", {
                  clipId: originalId,
                  atUs: operation.atUs,
                });
              bind(entry.label, "clip", right);
            }
            next = result.document;
            clipLineage.push(...result.lineage);
            break;
          }
          case "track.add": {
            next = { ...before, tracks: [...before.tracks, addTrack(operation)] };
            break;
          }
          case "track.remove": {
            const id = resolve(operation.trackId, "track");
            const occupants = before.clips
              .filter((clip) => clip.trackId === id)
              .map((clip) => clip.id);
            if (occupants.length)
              invalid("Remove or move the track's clips explicitly first", {
                trackId: id,
                clipIds: occupants,
              });
            next = {
              ...before,
              tracks: before.tracks.filter((track) => track.id !== id),
              processing: before.processing.filter(
                (stack) => stack.target.kind !== "track" || stack.target.id !== id,
              ),
            };
            break;
          }
          case "group.add": {
            const id = allocate("group");
            bind(operation.label, "group", id);
            const { parentId, ...group } = operation.group;
            next = {
              ...before,
              groups: [
                ...before.groups,
                {
                  ...group,
                  id,
                  ...(parentId === undefined ? {} : { parentId: resolve(parentId, "group") }),
                },
              ],
            };
            break;
          }
          case "group.remove": {
            const id = resolve(operation.groupId, "group");
            if ([...before.groups, ...before.tracks].some((node) => node.parentId === id))
              invalid("Reparent the group's children explicitly first", { groupId: id });
            next = {
              ...before,
              groups: before.groups.filter((group) => group.id !== id),
              processing: before.processing.filter(
                (stack) => stack.target.kind !== "group" || stack.target.id !== id,
              ),
            };
            break;
          }
          case "routing.set": {
            const id = resolve(operation.target.id, operation.target.kind);
            const key = operation.target.kind === "track" ? "tracks" : "groups";
            if (!before[key].some((node) => node.id === id))
              invalid("Unknown routing target", { target: operation.target });
            const parentId =
              operation.parentId === undefined ? undefined : resolve(operation.parentId, "group");
            next = {
              ...before,
              [key]: before[key].map((node) => {
                if (node.id !== id) return node;
                return {
                  ...omit(node, "parentId"),
                  order: operation.order,
                  ...(parentId === undefined ? {} : { parentId }),
                };
              }),
            };
            break;
          }
          case "layers.reorder": {
            const parentId =
              operation.parentId === undefined ? undefined : resolve(operation.parentId, "group");
            if (
              parentId !== undefined &&
              !before.groups.some((group) => group.id === parentId && group.kind === "video")
            )
              invalid("Layer parent must be a video group", { parentId });
            const targets = operation.targets.map((target) => ({
              kind: target.kind,
              id: resolve(target.id, target.kind),
            }));
            const key = (kind: string, id: string) => JSON.stringify([kind, id]);
            const order = new Map(targets.map((target, i) => [key(target.kind, target.id), i]));
            const siblings = [
              ...before.tracks
                .filter((node) => node.kind === "video" && node.parentId === parentId)
                .map((node) => key("track", node.id)),
              ...before.groups
                .filter((node) => node.kind === "video" && node.parentId === parentId)
                .map((node) => key("group", node.id)),
            ];
            if (
              order.size !== targets.length ||
              siblings.length !== targets.length ||
              siblings.some((id) => !order.has(id))
            )
              invalid("Reorder must name every video sibling exactly once");
            next = {
              ...before,
              tracks: before.tracks.map((node) =>
                order.has(key("track", node.id))
                  ? { ...node, order: order.get(key("track", node.id))! }
                  : node,
              ),
              groups: before.groups.map((node) =>
                order.has(key("group", node.id))
                  ? { ...node, order: order.get(key("group", node.id))! }
                  : node,
              ),
            };
            break;
          }
          case "canvas.set": {
            const supplied = Object.fromEntries(
              Object.entries(operation.canvas).filter(([, value]) => value !== undefined),
            );
            next = { ...before, canvas: { ...before.canvas, ...supplied } };
            break;
          }
          case "place": {
            next = { ...before, clips: [...before.clips, placeClip(operation, operationIndex)] };
            break;
          }
          case "link": {
            const ids = clips(operation.clipIds);
            const existing = before.syncGroups.find(
              (group) =>
                group.clipIds.length === ids.length &&
                group.clipIds.every((id) => ids.includes(id)),
            );
            if (existing) {
              bind(operation.label, "syncGroup", existing.id);
              next = before;
              break;
            }
            const conflicts = before.syncGroups
              .filter((group) => group.clipIds.some((id) => ids.includes(id)))
              .map((group) => group.id);
            if (conflicts.length)
              invalid("Unlink conflicting groups explicitly before linking this selection", {
                groupIds: conflicts,
              });
            const id = allocate("syncGroup");
            bind(operation.label, "syncGroup", id);
            next = { ...before, syncGroups: [...before.syncGroups, { id, clipIds: ids }] };
            break;
          }
          case "unlink": {
            const ids = new Set(clips(operation.clipIds));
            next = {
              ...before,
              syncGroups: before.syncGroups.flatMap((group) => {
                const clipIds = group.clipIds.filter((id) => !ids.has(id));
                return clipIds.length >= 2 ? [{ ...group, clipIds }] : [];
              }),
            };
            break;
          }
          case "angle.declare": {
            const memberIds = clips(operation.members.map((member) => member.clipId));
            const originClipId = clips([operation.originClipId])[0]!;
            if (!memberIds.includes(originClipId)) invalid("Angle origin must be a member");
            const members = operation.members.map((member, index) => {
              const clip = model.clips.find((value) => value.clip.id === memberIds[index])!;
              if (!isMediaClip(clip.clip)) invalid("Angle members require media clips");
              const base = {
                clipId: clip.clip.id,
                assetId: clip.clip.assetId,
                streamId: clip.clip.streamId,
              };
              // Validity is kept to the part inside the member's interval; the offset is untouched.
              const valid = (range: { startUs: TimeValue; endUs: TimeValue }) => {
                const requested = interval(range);
                const { range: kept, clamped } = admitRange(requested, clip.range);
                if (!clamped) return range;
                issues.push(rangeClampedIssue(requested, kept, clip.range, operationIndex));
                return wire(kept);
              };
              return operation.mapping === "piecewise-local"
                ? {
                    ...base,
                    segments: member.segments!.map((segment) => ({
                      ...segment,
                      validRange: valid(segment.validRange),
                    })),
                  }
                : { ...base, offsetUs: member.offsetUs!, validRange: valid(member.validRange!) };
            });
            const id = allocate("angleGroup");
            bind(operation.label, "angleGroup", id);
            // The caller authored the offsets; refused evidence is information, not a veto.
            if (operation.evidence.status === "refused")
              issues.push({
                code: "synchronization-evidence-refused",
                message:
                  "The angle group's synchronization evidence was refused; its offsets are the caller's",
                evidence: {
                  angleGroupId: id,
                  evidenceId: operation.evidence.id,
                  generation: operation.evidence.generation,
                  method: operation.evidence.method,
                  fingerprint: operation.evidence.fingerprint,
                  operationIndex,
                },
              });
            next = {
              ...before,
              angleGroups: [
                ...(before.angleGroups ?? []),
                {
                  id,
                  sessionId: operation.sessionId,
                  originClipId,
                  evidence: operation.evidence,
                  ...(operation.mapping === "piecewise-local"
                    ? { mapping: operation.mapping }
                    : {}),
                  members,
                },
              ],
            };
            break;
          }
          case "angle.remove": {
            const id = resolve(operation.angleGroupId, "angleGroup");
            if (!(before.angleGroups ?? []).some((group) => group.id === id))
              invalid("Unknown angle group", { angleGroupId: id });
            next = {
              ...before,
              angleGroups: (before.angleGroups ?? []).filter((group) => group.id !== id),
            };
            break;
          }
        }
      }
      const candidate = resolveComposition(next, model.assets, model.acquisitions);
      const stateDocument = normalizeStateEdit(model, candidate);
      model =
        stateDocument === candidate.document
          ? candidate
          : validateComposition(stateDocument, model.assets, model.acquisitions);
      normalized.push({ operationIndex, changes: changes(before, model.document) });
    } catch (error) {
      if (error instanceof CompositionError)
        invalid(error.message, { ...error.details, operationIndex, cause: error.code });
      throw error;
    }
  }
  return {
    document: model.document,
    changed: changes(initial, model.document).length > 0,
    issues: boundedIssues(issues),
    createdIds,
    labels: Object.fromEntries([...bindings].map(([name, value]) => [name, value.id])),
    normalized,
    clipLineage,
    removedAttachments,
    processingLineage,
    touchedFixedAnchors: [...touchedFixedAnchors.values()],
    linkChanges: normalized.flatMap((step) =>
      step.changes.filter(
        (change): change is Extract<EditChange, { kind: "syncGroup" }> =>
          change.kind === "syncGroup",
      ),
    ),
  };
}
