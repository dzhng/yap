import { timeUs, type SignedTimeValue } from "@yap/composition";
import { setImmediate } from "node:timers/promises";
import {
  createCompiler,
  createSourceRangeProjection,
  compare,
  fromTime,
  floor,
  ceil,
  isMediaClip,
  type SourceWindowOccurrence,
  toTime,
  type CompiledFrame,
  type ProcessingInstruction,
  type ProcessingTap,
  type TimeValue,
  type ValidatedComposition,
} from "@yap/composition";
import { CatalogError } from "./catalog.js";
import { CoverageTracker } from "./index-coverage.js";
import type { IndexMoment, IndexPointerSample } from "./source-index-selection.js";
import { observedSceneBoundary, type SourceSceneChunk } from "./source-scene-chunks.js";
import type { SceneSampleClock } from "./source-scenes.js";
import type { TimeRange } from "./presentation-time.js";

export const projectIndexPolicy = Object.freeze({
  id: "project-picture-selection-v4",
  maximumCandidates: 20000,
  maximumReasons: 100000,
  maximumOccurrences: 10000,
  maximumWork: 1000000,
});
type Frame = Pick<CompiledFrame, "index" | "sampleAtUs" | "visibleRange">;
export type ProjectIndexReason =
  | {
      kind: "scene";
      clipId: string;
      generation: string;
      observedSourceUs: number;
      projectAtUs: TimeValue;
      side: "before" | "after";
      sample: SceneSampleClock;
      originUs: SignedTimeValue;
    }
  | { kind: "first" | "last" | "coverage"; projectAtUs: TimeValue }
  | { kind: "mark" | "pin" | "click"; markId: string; projectAtUs: TimeValue }
  | { kind: "processing"; projectAtUs: TimeValue; side: "before" | "after" }
  | {
      kind: "clip" | "availability";
      clipId: string;
      edge: "start" | "end";
      projectAtUs: TimeValue;
      side: "before" | "after";
    };
export type ProjectIndexCandidate = Frame & { ordinal: number; reasons: ProjectIndexReason[] };

/** Compiler-selected video contributors supply scope; the compiler alone chooses frame phase. */
export async function selectProjectIndex(input: {
  model: ValidatedComposition;
  revisionId: string;
  processing: readonly ProcessingInstruction[];
  tap: ProcessingTap;
  /** The retained owner reads only the requested inverse window, including its chunk lookback. */
  scenes: (
    occurrence: SourceWindowOccurrence,
    range: TimeRange,
  ) => {
    generation: string;
    chunks: AsyncIterable<SourceSceneChunk> | Iterable<SourceSceneChunk>;
    moments?: readonly IndexMoment[];
    pointerSamples?: readonly IndexPointerSample[];
  } | null;
  signal?: AbortSignal | undefined;
}): Promise<ProjectIndexCandidate[]> {
  const { model, signal } = input;
  signal?.throwIfAborted();
  if (!model.durationUs) return [];
  function bound(
    kind: "maximumCandidates" | "maximumReasons" | "maximumOccurrences" | "maximumWork",
    observed: number,
  ) {
    const maximum = projectIndexPolicy[kind];
    if (observed > maximum)
      throw new CatalogError(
        "LIMIT_EXCEEDED",
        `Project index exceeds ${maximum} ${kind.slice(7).toLowerCase()}`,
        {
          revisionId: input.revisionId,
          limitKind: kind,
          maximum,
          observed,
        },
      );
  }
  const selected = new Set(
    input.processing.flatMap((node) => (node.target.kind === "clip" ? [node.target.id] : [])),
  );
  const clips = model.clips.filter(
    (value) => value.track.kind === "video" && selected.has(value.clip.id),
  );
  bound("maximumOccurrences", clips.length);
  const compiler = createCompiler(model, input.revisionId);
  const candidates = new Map<number, Omit<ProjectIndexCandidate, "ordinal">>();
  // Every chosen frame counts toward coverage, at the project time its reason names.
  const coverage = new CoverageTracker();
  let reasonCount = 0,
    work = 0;
  async function checkpoint() {
    signal?.throwIfAborted();
    bound("maximumWork", ++work);
    if (work % 128 === 0) await setImmediate();
  }
  function add(frame: Frame | null, reason: ProjectIndexReason) {
    if (!frame) return;
    let candidate = candidates.get(frame.index);
    if (!candidate) {
      bound("maximumCandidates", candidates.size + 1);
      candidate = { ...frame, reasons: [] };
      candidates.set(frame.index, candidate);
    }
    bound("maximumReasons", ++reasonCount);
    candidate.reasons.push(reason);
    coverage.chosen(timeUs(reason.projectAtUs));
  }
  async function boundary(
    projectAtUs: TimeValue,
    reason: Pick<
      Extract<ProjectIndexReason, { kind: "clip" | "availability" }>,
      "kind" | "clipId" | "edge"
    >,
  ) {
    await checkpoint();
    const frames = compiler.frameBoundary(projectAtUs);
    for (const side of ["before", "after"] as const)
      add(frames[side], { ...reason, projectAtUs, side });
  }
  add(compiler.frameBoundary(0).after, { kind: "first", projectAtUs: 0 });
  add(compiler.frameBoundary(model.durationUs).before, {
    kind: "last",
    projectAtUs: model.durationUs,
  });
  for (const value of clips) {
    signal?.throwIfAborted();
    for (const edge of ["start", "end"] as const) {
      await boundary(toTime(value.range[edge]), { kind: "clip", clipId: value.clip.id, edge });
      for (const range of value.available)
        await boundary(toTime(range[edge]), { kind: "availability", clipId: value.clip.id, edge });
    }
  }
  for (const projectAtUs of compiler.processingBoundaries(input.tap)) {
    await checkpoint();
    const frames = compiler.frameBoundary(projectAtUs);
    for (const side of ["before", "after"] as const)
      add(frames[side], { kind: "processing", projectAtUs, side });
  }
  const projection = createSourceRangeProjection(model);
  for (const value of clips) {
    const clip = value.clip;
    if (!isMediaClip(clip) || clip.source.kind !== "range") continue;
    const occurrence = projection.inverse(clip.id, { startUs: 0, endUs: model.durationUs });
    if (!occurrence) continue;
    for (const fragment of occurrence.fragments) {
      await checkpoint();
      const source = input.scenes(occurrence, {
        startUs: floor(fragment.source.start),
        endUs: ceil(fragment.source.end),
      });
      if (!source) continue;
      const moments = source.moments ?? [];
      if (clip.acquisitionId) {
        for (const moment of moments) {
          const mapped = projection.point(clip.id, moment.sourceUs);
          if (
            !mapped ||
            compare(mapped.project, fragment.project.start) < 0 ||
            compare(mapped.project, fragment.project.end) >= 0
          )
            continue;
          const projectAtUs = toTime(mapped.project),
            neighbors = compiler.frameBoundary(projectAtUs);
          const frame =
            neighbors.after &&
            compare(fromTime(compiler.frameTime(neighbors.after.index)), fragment.project.end) < 0
              ? neighbors.after
              : neighbors.before;
          add(frame, { kind: moment.kind, markId: moment.markId, projectAtUs });
        }
      }
      coverage.scan(source.pointerSamples ?? []);
      let previous: SourceSceneChunk["coverage"][number] | undefined;
      for await (const chunk of source.chunks) {
        await checkpoint();
        for (const point of chunk.coverage) {
          await checkpoint();
          if (previous && point.requestedSourceUs <= previous.requestedSourceUs) continue;
          const change = observedSceneBoundary(previous, point, chunk);
          if (change) {
            for (const [side, observation] of [
              ["before", previous!],
              ["after", point],
            ] as const) {
              if (observation.status !== "available") continue;
              const mapped = projection.point(clip.id, observation.requestedSourceUs);
              if (
                !mapped ||
                compare(mapped.project, fragment.project.start) < 0 ||
                compare(mapped.project, fragment.project.end) >= 0
              )
                continue;
              const projectAtUs = toTime(mapped.project),
                neighbors = compiler.frameBoundary(projectAtUs);
              const frame =
                side === "after" ||
                (neighbors.after &&
                  compare(fromTime(compiler.frameTime(neighbors.after.index)), mapped.project) ===
                    0)
                  ? neighbors.after
                  : neighbors.before;
              if (
                !frame ||
                compare(fromTime(compiler.frameTime(frame.index)), fragment.project.start) < 0 ||
                compare(fromTime(compiler.frameTime(frame.index)), fragment.project.end) >= 0
              )
                continue;
              add(frame, {
                kind: "scene",
                clipId: clip.id,
                generation: source.generation,
                observedSourceUs: observation.requestedSourceUs,
                projectAtUs,
                side,
                sample: observation.sample,
                originUs: chunk.originUs,
              });
            }
          }
          const mapped = projection.point(clip.id, point.requestedSourceUs);
          if (
            mapped &&
            compare(mapped.project, fragment.project.start) >= 0 &&
            compare(mapped.project, fragment.project.end) < 0
          ) {
            const projectAtUs = toTime(mapped.project);
            coverage.advance(timeUs(projectAtUs), point.requestedSourceUs);
            const run = point.status === "available" ? point.stillnessRunStartUs : undefined;
            if (
              run !== undefined &&
              coverage.due(run, Math.max(chunk.sourceWidth, chunk.sourceHeight))
            )
              add(compiler.frameBoundary(projectAtUs).after, { kind: "coverage", projectAtUs });
            coverage.shown(run);
          }
          previous = point;
        }
      }
    }
  }
  signal?.throwIfAborted();
  return [...candidates.values()]
    .sort((a, b) => a.index - b.index)
    .map((candidate, ordinal) => ({ ...candidate, ordinal }));
}
