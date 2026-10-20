import { omit } from "./omit.js";
import { deriveStatePlan, selectStatePlan } from "./processing-state.js";
import { temporalProcessing } from "./temporal-processing.js";
import { compileScalarCurve } from "./curve.js";
import { visualPlanner } from "./visual-plan.js";
import { intervalIndex } from "./interval-index.js";
import { sampleAt } from "./sample-clock.js";
import { audioContexts } from "./audio-context.js";
import type { CompiledFrame, CompiledAudio } from "./compiled-records.js";
import { executionWindow, executionWindowRequestSchema } from "./execution-window.js";
import { processingPlanner } from "./processing-plan.js";
import { CompositionError } from "./errors.js";
import { projectTime, resolvedClip, sourceTime, type ValidatedComposition } from "./model.js";
import { compare, fromTime, toTime, rational, type Rational } from "./rational.js";
import {
  isMediaClip,
  processingTapSchema,
  type ProcessingTap,
  rangeSchema,
  timeValueSchema,
  type TimeValue,
  type Range,
  type Fraction,
} from "./schema.js";

type Resolved = ValidatedComposition["clips"][number];
const renderOrder = (a: Resolved, b: Resolved) =>
  a.trackRank - b.trackRank || compare(a.range.start, b.range.start);
function safeInteger(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new CompositionError("INVALID_TIME", "Compiled clock exceeds safe-integer precision");
  return Number(value);
}
function checkedRange(input: Range): Range {
  const parsed = rangeSchema.safeParse(input);
  if (!parsed.success) throw new CompositionError("INVALID_TIME", parsed.error.message);
  return parsed.data;
}

function firstAvailable(ranges: Resolved["available"], at: Rational): number {
  let lo = 0,
    hi = ranges.length;
  while (lo < hi) {
    const middle = Math.floor((lo + hi) / 2);
    if (compare(ranges[middle]!.end, at) <= 0) lo = middle + 1;
    else hi = middle;
  }
  return lo;
}

function frameClock(fps: Fraction) {
  const numerator = BigInt(fps.numerator),
    denominator = 1000000n * BigInt(fps.denominator);
  return {
    labelAt: (index: bigint) => (index * denominator) / numerator,
    exactTimeAt: (index: bigint) => rational(index * denominator, numerator),
    // Display-cell selection uses floor labels, including skipped empty cells.
    indexAtLabel: (time: bigint) => ((time + 1n) * numerator + denominator - 1n) / denominator - 1n,
    firstAtOrAfter: (time: Rational) =>
      (time.numerator * numerator + time.denominator * denominator - 1n) /
      (time.denominator * denominator),
  };
}

function frameTiming(
  clock: ReturnType<typeof frameClock>,
  index: bigint,
  range: Range,
): Pick<CompiledFrame, "index" | "sampleAtUs" | "visibleRange"> {
  const sampleAtUs = safeInteger(clock.labelAt(index));
  const next = clock.labelAt(index + 1n);
  return {
    index: safeInteger(index),
    sampleAtUs,
    visibleRange: {
      startUs: Math.max(range.startUs, sampleAtUs),
      endUs: safeInteger(next < BigInt(range.endUs) ? next : BigInt(range.endUs)),
    },
  };
}

function compileAudioInput(
  value: Resolved,
  ranges: readonly { start: Rational; end: Rational }[],
  sampleRate: number,
  contexts: ReturnType<typeof audioContexts>,
): CompiledAudio {
  const sample = (at: Rational) => sampleAt(at, sampleRate);
  const first = ranges[0]!,
    last = ranges.at(-1)!;
  const start = Math.max(sample(first.start), sample(value.range.start)),
    end = Math.min(sample(last.end), sample(value.range.end));
  const clip = value.clip;
  const source: CompiledAudio["source"] =
    isMediaClip(clip) && clip.source.kind === "range"
      ? { kind: "range", assetId: clip.assetId, streamId: clip.streamId, range: clip.source.range }
      : { kind: "silence" };
  const available: CompiledAudio["available"] = [];
  for (const selected of ranges) {
    const selectedStart = Math.max(start, sample(selected.start)),
      selectedEnd = Math.min(end, sample(selected.end));
    for (let i = firstAvailable(value.available, selected.start); i < value.available.length; i++) {
      const part = value.available[i]!,
        a = Math.max(selectedStart, sample(part.start)),
        b = Math.min(selectedEnd, sample(part.end));
      if (a >= selectedEnd) break;
      if (a < b) available.push({ start: a, end: b });
    }
  }
  return {
    clipId: clip.id,
    trackId: clip.trackId,
    sampleRange: { start, end },
    placement: { startUs: toTime(value.range.start), endUs: toTime(value.range.end) },
    source,
    context: contexts(value, { startUs: toTime(first.start), endUs: toTime(last.end) }, sampleRate),
    pitch: isMediaClip(clip) ? (clip.pitch ?? "preserve") : "preserve",
    available,
  };
}

function textAt(model: ValidatedComposition, value: Resolved, at: Rational) {
  const clip = value.clip;
  const source = clip.source;
  if (source.kind !== "text")
    throw new CompositionError("INVALID_COMPOSITION", "Expected text clip");
  const { timedWords, ...compiled } = source;
  if (timedWords === undefined || source.highlight === undefined) return compiled;
  const seed = "seed" in clip ? clip.seed : undefined;
  const parent = seed
    ? model.clips.find((candidate) => candidate.clip.id === seed.occurrenceClipId)
    : undefined;
  const activeRanges = timedWords
    .filter((word) => {
      const start = parent
        ? projectTime(parent, fromTime(word.sourceRange.startUs))
        : fromTime(word.sourceRange.startUs);
      const end = parent
        ? projectTime(parent, fromTime(word.sourceRange.endUs))
        : fromTime(word.sourceRange.endUs);
      return compare(start, at) <= 0 && compare(at, end) < 0;
    })
    .map((word) => word.range);
  return { ...compiled, activeRanges };
}

function compileSchedules(
  model: ValidatedComposition,
  visual: ReturnType<typeof visualPlanner>,
  processing: ReturnType<typeof processingPlanner>,
  tap: ProcessingTap | undefined,
  clock: ReturnType<typeof frameClock>,
  query: ReturnType<typeof intervalIndex<Resolved>>,
  contexts: ReturnType<typeof audioContexts>,
) {
  return {
    *audio(input: Range, sampleRate = 48000): Generator<CompiledAudio> {
      const range = checkedRange(input);
      if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0)
        throw new CompositionError("INVALID_TIME", "Expected a positive integer sample rate");
      for (const value of query(fromTime(range.startUs), fromTime(range.endUs))) {
        if (value.track.kind !== "audio") continue;
        const clip = compileAudioInput(
          value,
          [{ start: fromTime(range.startUs), end: fromTime(range.endUs) }],
          sampleRate,
          contexts,
        );
        if (clip.sampleRange.start < clip.sampleRange.end) yield clip;
      }
    },
    *frames(input: Range): Generator<CompiledFrame> {
      const range = checkedRange(input);
      let index = clock.indexAtLabel(BigInt(range.startUs));
      for (;;) {
        const timestamp = clock.labelAt(index);
        if (timestamp >= BigInt(range.endUs)) return;
        const at = clock.exactTimeAt(index);
        const layers: CompiledFrame["layers"] = [];
        const active = query(at);
        for (const value of active) {
          const clip = value.clip;
          if (value.track.kind !== "video") continue;
          if (clip.source.kind === "text") {
            const available = value.available.some(
              (range) => compare(range.start, at) <= 0 && compare(at, range.end) < 0,
            );
            layers.push({
              kind: "text",
              clipId: clip.id,
              trackId: clip.trackId,
              text: textAt(model, value, at),
              width: clip.source.width,
              height: clip.source.height,
              availability: available ? "available" : "anchor-unavailable",
            });
            continue;
          }
          if (!isMediaClip(clip)) continue;
          const part = value.available[firstAvailable(value.available, at)];
          const anchor = value.anchorSupport[firstAvailable(value.anchorSupport, at)];
          layers.push({
            clipId: clip.id,
            trackId: clip.trackId,
            assetId: clip.assetId,
            streamId: clip.streamId,
            ...(value.stream!.kind === "image"
              ? { kind: "image" as const }
              : { kind: "video" as const, sourceUs: toTime(sourceTime(value, at)) }),
            availability:
              anchor === undefined || compare(anchor.start, at) > 0
                ? "anchor-unavailable"
                : part !== undefined && compare(part.start, at) <= 0
                  ? "available"
                  : "source-unavailable",
            width: value.stream!.kind === "audio" ? 0 : value.stream!.width,
            height: value.stream!.kind === "audio" ? 0 : value.stream!.height,
          });
        }
        const nextTimestamp = clock.labelAt(index + 1n);
        yield {
          ...frameTiming(clock, index, range),
          layers,
          visual: visual(
            processing(
              active.filter((clip) => clip.track.kind === "video"),
              tap,
              "video",
            ),
            toTime(at),
          ),
        };
        index = clock.indexAtLabel(nextTimestamp);
      }
    },
  };
}

/** Build once per validated immutable revision, then request lazy globally phased schedules. */
export function createCompiler(model: ValidatedComposition, revisionId: string) {
  const temporal = temporalProcessing(model);
  if (typeof revisionId !== "string" || revisionId.length === 0)
    throw new CompositionError("INVALID_COMPOSITION", "Expected a revision identity");
  const query = intervalIndex(model.clips, (clip) => clip.range, renderOrder);
  const processing = processingPlanner(model);
  const visual = visualPlanner(model, temporal);
  const clock = frameClock(model.document.canvas.fps);
  const contexts = audioContexts(model);
  function contributors(range: Range, sampleRate = 48000) {
    const leading = clock.indexAtLabel(BigInt(range.startUs));
    const candidates = new Map(
      query(fromTime(range.startUs), fromTime(range.endUs)).map((value) => [value.clip.id, value]),
    );
    for (const value of query(clock.exactTimeAt(leading)))
      if (value.track.kind === "video") candidates.set(value.clip.id, value);
    return [...candidates.values()]
      .filter((value) => {
        if (value.track.kind === "audio")
          return (
            Math.max(
              sampleAt(fromTime(range.startUs), sampleRate),
              sampleAt(value.range.start, sampleRate),
            ) <
            Math.min(
              sampleAt(fromTime(range.endUs), sampleRate),
              sampleAt(value.range.end, sampleRate),
            )
          );
        const first = clock.firstAtOrAfter(value.range.start);
        const sampleIndex = clock.indexAtLabel(clock.labelAt(first > leading ? first : leading));
        const sample = clock.exactTimeAt(sampleIndex);
        return (
          clock.labelAt(sampleIndex) < BigInt(range.endUs) && compare(sample, value.range.end) < 0
        );
      })
      .sort((a, b) => a.trackRank - b.trackRank || compare(a.range.start, b.range.start));
  }
  let fullState: ReturnType<typeof deriveStatePlan> | undefined;
  function window(input: unknown, component?: "audio" | "video") {
    const parsed = executionWindowRequestSchema.safeParse(input);
    if (!parsed.success) throw new CompositionError("INVALID_COMPOSITION", parsed.error.message);
    const request = parsed.data;
    const clips = contributors(request.range, request.rendition.sampleRate).filter(
      (value) => !component || value.track.kind === component,
    );
    const target = request.tap.target;
    if (
      target.kind === "clip" &&
      !clips.some((value) => value.clip.id === target.id) &&
      model.clips.some((value) => value.clip.id === target.id && value.track.kind === "audio")
    )
      throw new CompositionError(
        "INVALID_RANGE",
        "Audio clip tap has no output samples in the requested window",
      );
    let plan = processing(clips, request.tap, component);
    const selected = new Set(
      plan.flatMap((node) => (node.target.kind === "clip" ? [node.target.id] : [])),
    );
    const inputs = clips.filter((value) => selected.has(value.clip.id));
    let state: ReturnType<typeof deriveStatePlan> | undefined;
    if (component !== "video" && plan.at(-1)?.mediaKind !== "video") {
      fullState ??= deriveStatePlan(model);
      const eligible = fullState.domains.length
        ? new Set(
            processing(
              model.clips.filter((clip) => clip.track.kind === "audio"),
              request.tap,
              "audio",
            ).flatMap((node) => node.steps.filter((step) => step.enabled).map((step) => step.id)),
          )
        : new Set<string>();
      const selectedState = fullState.domains.length
        ? selectStatePlan(fullState, eligible, request.range)
        : fullState;
      if (selectedState.domains.length) {
        state = selectedState;
        const first = sampleAt(fromTime(request.range.startUs), request.rendition.sampleRate),
          last = sampleAt(fromTime(request.range.endUs), request.rendition.sampleRate);
        const targets = state.domains.flatMap((domain) =>
          domain.members
            .filter(
              (member) =>
                eligible.has(member.stepId) &&
                sampleAt(fromTime(member.range.startUs), request.rendition.sampleRate) < last &&
                sampleAt(fromTime(member.range.endUs), request.rendition.sampleRate) > first,
            )
            .map((member) => member.target),
        );
        plan = processing(clips, request.tap, component, targets);
      }
    }
    const compiled = executionWindow(
      revisionId,
      model.document.canvas,
      request,
      inputs,
      plan,
      contexts,
      compileSchedules(
        model,
        visual,
        processing,
        request.tap,
        clock,
        intervalIndex(inputs, (clip) => clip.range, renderOrder),
        contexts,
      ),
      () => temporal.audio(plan, request.rendition.sampleRate, state),
      component,
      state,
      () => {
        return state
          ? {
              clips: state.inputs.map((input) => {
                const value = resolvedClip(model, input.clip.id)!;
                const ranges = input.selected.map((range) => ({
                  start: fromTime(range.startUs),
                  end: fromTime(range.endUs),
                }));
                return {
                  ...compileAudioInput(value, ranges, request.rendition.sampleRate, contexts),
                  required: ranges
                    .map((range) => ({
                      start: sampleAt(range.start, request.rendition.sampleRate),
                      end: sampleAt(range.end, request.rendition.sampleRate),
                    }))
                    .filter((range) => range.start < range.end),
                };
              }),
              processing: temporal.audio(
                state.nodes.map((node) => omit(node, "range")),
                request.rendition.sampleRate,
                state,
              ),
              domains: state.domains.map((domain) => ({
                recipe: domain.recipe,
                sampleRange: domain.sampleRange,
                dependencies: domain.dependencies,
                members: domain.members.map((member) => ({
                  target: member.target,
                  stepId: member.stepId,
                  ...(member.detector ? { detector: member.detector } : {}),
                  sampleRange: {
                    start: sampleAt(fromTime(member.range.startUs), request.rendition.sampleRate),
                    end: sampleAt(fromTime(member.range.endUs), request.rendition.sampleRate),
                  },
                })),
              })),
              formats: state.inputs.flatMap((input) =>
                isMediaClip(input.clip)
                  ? [
                      {
                        assetId: input.clip.assetId,
                        streamId: input.clip.streamId,
                        channels: input.channels ?? null,
                        sampleRate: input.sampleRate ?? null,
                      },
                    ]
                  : [],
              ),
            }
          : undefined;
      },
    );
    return compiled;
  }
  return {
    ...compileSchedules(model, visual, processing, undefined, clock, query, contexts),
    curve: (curve: unknown, anchor: unknown) => compileScalarCurve(model, curve, anchor),
    processingBoundaries(
      input: unknown = { target: { kind: "output" }, point: { kind: "processed" } },
    ) {
      const tap = processingTapSchema.parse(input);
      return temporal.boundaries(processing(model.clips, tap, "video")).map(toTime);
    },
    /** Authoritative execution instant; frame descriptors keep integer display labels. */
    frameTime(index: number): TimeValue {
      if (!Number.isSafeInteger(index) || index < 0)
        throw new CompositionError(
          "INVALID_TIME",
          "Frame index must be a nonnegative safe integer",
        );
      return toTime(clock.exactTimeAt(BigInt(index)));
    },
    /** Exact execution neighbors, represented by the existing integer frame-cell labels. */
    frameBoundary(at: TimeValue) {
      const parsed = timeValueSchema.safeParse(at);
      if (!parsed.success || compare(fromTime(parsed.data), fromTime(model.durationUs)) > 0)
        throw new CompositionError("INVALID_TIME", "Frame boundary must be within the project");
      const threshold = fromTime(parsed.data);
      const picture = (
        index: bigint,
      ): Pick<CompiledFrame, "index" | "sampleAtUs" | "visibleRange"> | null => {
        const sample = clock.labelAt(index);
        if (sample >= BigInt(model.durationUs)) return null;
        return frameTiming(clock, index, { startUs: 0, endUs: model.durationUs });
      };
      const first = clock.firstAtOrAfter(threshold);
      const after = clock.indexAtLabel(clock.labelAt(first));
      return {
        before:
          clock.labelAt(first) === 0n
            ? null
            : picture(clock.indexAtLabel(clock.labelAt(first) - 1n)),
        after: picture(after),
      };
    },
    /** Validate target and step scope without inventing a render range for an empty project. */
    tapPlan(input: unknown, component?: "audio" | "video") {
      const tap = processingTapSchema.safeParse(input);
      if (!tap.success) throw new CompositionError("INVALID_COMPOSITION", tap.error.message);
      return processing(
        model.clips.filter((value) => !component || value.track.kind === component),
        tap.data,
        component,
      );
    },
    processing(input: Range) {
      const range = checkedRange(input);
      return processing(contributors(range));
    },
    window: (input: unknown) => window(input),
    audioWindow: (input: unknown) => window(input, "audio"),
    videoWindow: (input: unknown) => window(input, "video"),
  };
}
