import { ceil, fromTime, type TimeValue, type SelectionRange } from "@yap/composition";
import { indexCaptureEvidence, type IndexCaptureOwners } from "./index-capture-evidence.js";
import { SourceIndexStillness, sourceIndexPoints } from "./source-index-equality.js";
import { waitForIndexFrame, retainIndexFrame } from "./index-frame.js";
import { CatalogError, dependencyRefusal } from "./catalog.js";
import type { DerivedCache } from "./cache.js";
import type {
  MediaFrameInspection,
  SourceFrameArtifact,
  SourceFrameInput,
} from "./frame-inspection.js";
import type { SceneEvidenceStore } from "./scene-evidence.js";
import type { ScreenshotIndexStore } from "./screenshot-index.js";
import type {
  SourceIndexIdentity,
  SourceIndexRecords,
  SourceIndexCoverage,
} from "./source-index.js";
import {
  sourceIndexChunks,
  sourceIndexQueryRanges,
  selectSourceIndex,
  type SourceIndexRequest,
} from "./source-index-selection.js";
import type { AcquisitionStore } from "./acquisitions.js";
import type { SourceEvidenceReader } from "./evidence-read.js";

type Resolved = { request: SourceIndexRequest } & (
  | { ordinal: number; frame: SourceFrameArtifact }
  | {
      ordinal: null;
      observation: Extract<SourceIndexCoverage, { basis: "observation" }>["observation"];
    }
);

/** A heavy index attempt waits only on existing frame-lane jobs, then retains their leased bytes. */
export async function materializeSourceIndex(
  identity: SourceIndexIdentity,
  source: { durationUs: TimeValue; support: readonly SelectionRange[] },
  owners: {
    index: ScreenshotIndexStore<SourceIndexRecords>;
    records: SceneEvidenceStore;
    acquisitions: AcquisitionStore;
    evidence?: SourceEvidenceReader;
    capture?: IndexCaptureOwners["capture"];
    frames: MediaFrameInspection;
    cache: DerivedCache;
  },
  retryFrames: boolean,
  signal: AbortSignal,
) {
  const { index, records, frames, cache } = owners;
  const { moments, pointerSamples } = indexCaptureEvidence(identity, owners);
  const stillness = new SourceIndexStillness(sourceIndexPoints(records, identity, signal));
  let ordinal = 0,
    through = 0,
    previous: Resolved | undefined;
  async function resolve(request: SourceIndexRequest): Promise<Resolved> {
    signal.throwIfAborted();
    if (request.kind === "unavailable")
      return { request, ordinal: null, observation: { kind: "scene", point: request.observation } };
    const input: SourceFrameInput = {
      assetId: identity.assetId,
      streamId: identity.streamId,
      ...(identity.acquisitionId === undefined ? {} : { acquisitionId: identity.acquisitionId }),
      atUs: request.requestedSourceUs,
      maxLongEdge: identity.maxLongEdge,
      ...(identity.observationRequest === undefined
        ? {}
        : { observations: identity.observationRequest }),
      ...(identity.faceObservationRequest === undefined
        ? {}
        : { faceObservations: identity.faceObservationRequest }),
    };
    const status = await waitForIndexFrame(
      () => frames.request(input),
      () => frames.retry(input),
      retryFrames,
      signal,
    );
    const dependency = { artifact: "frame", jobId: status.jobId, ...input };
    if (status.state === "unavailable") {
      try {
        return {
          request,
          ordinal: null,
          observation: { kind: "frame", frame: frames.sourceUnavailable(input) },
        };
      } catch (error) {
        if (error instanceof CatalogError && error.code === "PREREQUISITE_MISSING")
          throw dependencyRefusal(
            "FRAME_FAILED",
            status.reason ?? "Picture unavailable without physical observation",
            { dependency },
            status.retryable,
          );
        throw error;
      }
    }
    if (!status.published)
      throw dependencyRefusal(
        "FRAME_FAILED",
        status.reason ?? "Picture preparation did not publish",
        { dependency },
        status.retryable,
      );
    const frame = status.published.frame as SourceFrameArtifact;
    if (frame.implementationId !== identity.implementationId)
      throw new CatalogError("ARTIFACT_CHANGED", "Pinned picture renderer changed");
    await retainIndexFrame(
      cache,
      frame,
      index.outputPath(identity, ordinal),
      signal,
      (retained) => {
        index.appendCandidate(
          identity,
          {
            ordinal,
            requestedSourceUs: request.requestedSourceUs,
            support: request.support,
            reasons: request.reasons,
          },
          {
            ...(retained as any),
            sizeBytes: (retained as any).sizeBytes ?? (retained as any).bytes,
          },
        );
      },
    );
    return { request, ordinal: ordinal++, frame };
  }
  async function cover(value: Resolved | undefined, endUs: number) {
    if (endUs <= through) return;
    const range = { startUs: through, endUs };
    const equality = await stillness.equality(
      value?.ordinal !== null ? value?.frame : undefined,
      range,
    );
    signal.throwIfAborted();
    index.appendCoverage(
      identity,
      value === undefined
        ? { ordinal: null, state: "unavailable", basis: "support", source: range }
        : value.ordinal === null
          ? {
              ordinal: null,
              state: "unavailable",
              basis: "observation",
              equality: "unproven",
              observation: value.observation,
              source: range,
            }
          : { ordinal: value.ordinal, state: "available", equality, source: range },
    );
    through = endUs;
  }
  try {
    index.begin(identity);
    for await (const request of selectSourceIndex(
      sourceIndexQueryRanges(source.support),
      sourceIndexChunks(records, identity.scenes, signal),
      moments,
      pointerSamples,
      signal,
    )) {
      if (previous && previous.request.support !== request.support) {
        await cover(previous, previous.request.support.endUs);
        previous = undefined;
      }
      if (!previous) await cover(undefined, request.support.startUs);
      const current = await resolve(request);
      if (previous) await cover(previous, request.requestedSourceUs);
      previous = current;
    }
    if (previous) await cover(previous, previous.request.support.endUs);
    await cover(undefined, ceil(fromTime(source.durationUs)));
    signal.throwIfAborted();
    return await index.finish(identity, signal);
  } catch (error) {
    await index.remove(identity);
    throw error;
  } finally {
    await stillness.close();
  }
}
