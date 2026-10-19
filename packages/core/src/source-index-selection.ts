import { fromTime, ceil, type SignedTimeValue, type SelectionRange } from "@yap/composition";
import { CatalogError } from "./catalog.js";
import { setImmediate } from "node:timers/promises";
import type { SceneEvidenceStore, SceneEvidenceMetadata } from "./scene-evidence.js";
import { observedSceneBoundary, type SourceSceneChunk } from "./source-scene-chunks.js";
import type { SceneSampleClock } from "./source-scenes.js";
import type { TimeRange } from "./presentation-time.js";
import { selectionPolicy } from "./screenshot-index.js";
import { coverageDue } from "./index-coverage.js";

/** Raw pictures have no cursor overlay; presentation samples, not nearest frames, anchor changes. */
export const sourceIndexPolicy = {
  id: "source-presentation-selection-v3",
};
export type IndexMoment = {
  sourceUs: number;
  kind: "mark" | "pin" | "click";
  markId: string;
};
export type IndexPointerSample = {
  sourceUs: number;
  x: number | null;
  y: number | null;
};
export type SourceIndexReason =
  | { kind: "first" | "last" | "availability" | "coverage"; eventSourceUs: number }
  | { kind: "mark" | "pin" | "click"; eventSourceUs: number; markId: string }
  | {
      kind: "scene";
      side: "before" | "after";
      observedSourceUs: number;
      sample: SceneSampleClock;
      originUs: SignedTimeValue;
    };
type Point = SourceSceneChunk["coverage"][number];
export type SourceIndexRequest = { requestedSourceUs: number; support: TimeRange } & (
  | { kind: "picture"; reasons: SourceIndexReason[] }
  | { kind: "unavailable"; observation: Extract<Point, { status: "unavailable" }> }
);

export async function* sourceIndexChunks(
  records: Pick<SceneEvidenceStore, "sourcePage">,
  identity: SceneEvidenceMetadata,
  signal: AbortSignal,
): AsyncGenerator<SourceSceneChunk> {
  let afterStartUs: number | undefined;
  for (;;) {
    signal.throwIfAborted();
    const page = records.sourcePage({
      identity,
      limit: 1,
      ...(afterStartUs === undefined ? {} : { afterStartUs }),
    });
    yield* page.chunks;
    if (page.nextStartUs === null) return;
    afterStartUs = page.nextStartUs;
    await setImmediate();
  }
}

/** Keeps only one observation of lookback so a newly observed change can retain both known sides. */
export async function* selectSourceIndex(
  support: readonly TimeRange[],
  chunks: AsyncIterable<SourceSceneChunk> | Iterable<SourceSceneChunk>,
  moments: readonly IndexMoment[] = [],
  pointerSamples: readonly IndexPointerSample[] = [],
  signal?: AbortSignal,
): AsyncGenerator<SourceIndexRequest> {
  const pending = new Map<number, SourceIndexRequest>();
  let edgeIndex = 0,
    endEdge = false,
    supportIndex = 0;
  let previous: Point | undefined, previousSupport: TimeRange | undefined;
  let through = -1,
    lastRequest = -Infinity,
    representativeRun: number | undefined,
    pointerTravel = 0,
    pointerIndex = 0,
    momentIndex = 0;
  function add(at: number, range: TimeRange, reason: SourceIndexReason) {
    let request = pending.get(at);
    if (!request) {
      if (pending.size >= selectionPolicy.maximumPendingCandidates)
        throw new CatalogError(
          "LIMIT_EXCEEDED",
          "Too many source screenshot requests between observations",
        );
      request = { kind: "picture", requestedSourceUs: at, support: range, reasons: [] };
      pending.set(at, request);
    }
    if (request.kind === "picture") request.reasons.push(reason);
    if (at > lastRequest) {
      lastRequest = at;
      representativeRun = undefined;
      pointerTravel = 0;
    }
  }
  function edges(throughUs: number) {
    while (support[edgeIndex]) {
      const range = support[edgeIndex]!;
      const at = endEdge ? range.endUs - 1 : range.startUs;
      if (at > throughUs) return;
      add(at, range, {
        kind: endEdge ? "last" : "first",
        eventSourceUs: endEdge ? range.endUs : at,
      });
      if (endEdge) edgeIndex++;
      endEdge = !endEdge;
    }
  }
  function* flush(before: number) {
    for (const at of [...pending.keys()].sort((a, b) => a - b)) {
      if (at >= before) return;
      yield pending.get(at)!;
      pending.delete(at);
    }
  }
  for await (const chunk of chunks) {
    signal?.throwIfAborted();
    for (const point of chunk.coverage) {
      signal?.throwIfAborted();
      const at = point.requestedSourceUs;
      if (at <= through) continue;
      while (pointerSamples[pointerIndex] && pointerSamples[pointerIndex]!.sourceUs <= at) {
        const sample = pointerSamples[pointerIndex++];
        const previous = pointerSamples[pointerIndex - 2];
        if (
          sample &&
          previous &&
          sample.x !== null &&
          sample.y !== null &&
          previous.x !== null &&
          previous.y !== null
        )
          pointerTravel += Math.hypot(sample.x - previous.x, sample.y - previous.y);
      }
      edges(at);
      while (support[supportIndex] && support[supportIndex]!.endUs <= at) supportIndex++;
      const possible = support[supportIndex];
      const range = possible && possible.startUs <= at ? possible : undefined;
      if (range) {
        if (point.status === "unavailable") {
          if (pending.has(at) || previousSupport !== range || previous?.status !== "unavailable")
            pending.set(at, {
              kind: "unavailable",
              requestedSourceUs: at,
              support: range,
              observation: point,
            });
          representativeRun = undefined;
        } else {
          while (moments[momentIndex] && moments[momentIndex]!.sourceUs <= at) {
            const moment = moments[momentIndex++];
            if (moment && range.startUs <= moment.sourceUs && moment.sourceUs < range.endUs)
              add(moment.sourceUs, range, {
                kind: moment.kind,
                markId: moment.markId,
                eventSourceUs: moment.sourceUs,
              });
          }
          const before =
            previousSupport === range && previous?.status === "available" ? previous : undefined;
          if (!before || !point.continuousFromPrevious)
            add(at, range, { kind: "availability", eventSourceUs: at });
          const boundary = observedSceneBoundary(before, point, chunk);
          if (boundary) {
            const reason = {
              kind: "scene" as const,
              observedSourceUs: at,
              sample: boundary.current,
              originUs: chunk.originUs,
            };
            add(before!.requestedSourceUs, range, { ...reason, side: "before" });
            add(at, range, { ...reason, side: "after" });
          }
          const pictureChanged =
            representativeRun === undefined || representativeRun !== point.stillnessRunStartUs;
          if (
            Number.isFinite(lastRequest) &&
            coverageDue({
              sinceLastChosenUs: at - lastRequest,
              pictureChanged,
              pointerTravelPt: pointerTravel,
              displayWidthPt: Math.max(chunk.sourceWidth, chunk.sourceHeight),
            })
          )
            add(at, range, { kind: "coverage", eventSourceUs: at });
          if (lastRequest === at) representativeRun = point.stillnessRunStartUs;
        }
      }
      // The next scene comparison can still select this point as its known earlier side.
      yield* flush(previous?.requestedSourceUs ?? -Infinity);
      previous = point;
      previousSupport = range;
      through = at;
    }
  }
  signal?.throwIfAborted();
  for (const moment of moments.slice(momentIndex)) {
    const range = support.find(
      (value) => value.startUs <= moment.sourceUs && moment.sourceUs < value.endUs,
    );
    if (range)
      add(moment.sourceUs, range, {
        kind: moment.kind,
        markId: moment.markId,
        eventSourceUs: moment.sourceUs,
      });
  }
  edges(Infinity);
  yield* flush(Infinity);
}

/** Integer point-query coverage; physical support remains authoritative at frame admission. */
export function sourceIndexQueryRanges(support: readonly SelectionRange[]): TimeRange[] {
  return support
    .map((range) => ({
      startUs: ceil(fromTime(range.startUs)),
      endUs: ceil(fromTime(range.endUs)),
    }))
    .filter((range) => range.startUs < range.endUs);
}
