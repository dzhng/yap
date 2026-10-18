import { setImmediate } from "node:timers/promises";
import type { Issue } from "@yap/composition";
import { CatalogError, dependencyRefusal } from "./catalog.js";
import { JobDependencyLost, type JobQueue } from "./jobs.js";
import type { DerivedCache } from "./cache.js";
import {
  pictureTextIssues,
  type MediaFrameInspection,
  type ProjectFrameArtifact,
} from "./frame-inspection.js";
import { waitForIndexFrame, retainIndexFrame } from "./index-frame.js";
import { encodeIndexRecord, type ScreenshotIndexStore } from "./screenshot-index.js";
import type { SceneEvidenceMetadata, SceneEvidenceStore } from "./scene-evidence.js";
import { sourceSelectionKey } from "./source-selection.js";
import { selectProjectIndex } from "./project-index-selection.js";
import type {
  ProjectIndexIdentity,
  ProjectIndexRecords,
  projectIndexPlan,
} from "./project-index.js";
import type { TimeRange } from "./presentation-time.js";

async function* observedChunks(
  records: SceneEvidenceStore,
  identity: SceneEvidenceMetadata,
  range: TimeRange,
  signal: AbortSignal,
) {
  let afterStartUs: number | undefined;
  for (;;) {
    signal.throwIfAborted();
    const page = records.sourceWindowPage({
      identity,
      range,
      limit: 1,
      ...(afterStartUs === undefined ? {} : { afterStartUs }),
    });
    yield* page.chunks;
    if (page.nextStartUs === null) return;
    afterStartUs = page.nextStartUs;
    await setImmediate(undefined, { signal });
  }
}

/** Each distinct issue once, in first-seen order: frames repeat their text's issues. */
function distinctIssues(): { add(issues: readonly Issue[]): void; list(): Issue[] } {
  const seen = new Map<string, Issue>();
  return {
    add: (issues) => {
      for (const issue of issues) seen.set(JSON.stringify(issue), issue);
    },
    list: () => [...seen.values()],
  };
}

/**
 * The issues a retained project index published, derived from its retained frames alone, so an
 * adopted index carries the same issues its producer published.
 */
export function retainedProjectIndexIssues(
  index: ScreenshotIndexStore<ProjectIndexRecords>,
  identity: ProjectIndexIdentity,
): Issue[] {
  const issues = distinctIssues();
  let afterOrdinal: number | undefined;
  do {
    const page = index.page({ identity, ...(afterOrdinal === undefined ? {} : { afterOrdinal }) });
    for (const entry of page.entries) issues.add(pictureTextIssues(entry.frame));
    afterOrdinal = page.nextOrdinal ?? undefined;
  } while (afterOrdinal !== undefined);
  return issues.list();
}

/**
 * Identity and candidate row budgets are checked before asking the shared frame lane to produce any
 * picture. The index publishes the issues its frames published.
 */
export async function materializeProjectIndex(
  identity: ProjectIndexIdentity,
  plan: ReturnType<typeof projectIndexPlan>,
  owners: {
    index: ScreenshotIndexStore<ProjectIndexRecords>;
    records: SceneEvidenceStore;
    frames: MediaFrameInspection;
    cache: DerivedCache;
    jobs: JobQueue;
  },
  retryFrames: boolean,
  signal: AbortSignal,
) {
  encodeIndexRecord(identity);
  const dependencies = new Map(
    identity.scenes.map((scene) => {
      if (scene.owner.kind !== "asset" || scene.source.kind !== "asset")
        throw new CatalogError("INVALID_EVIDENCE", "Project scenes require a video source");
      return [
        sourceSelectionKey({
          assetId: scene.owner.assetId,
          streamId: scene.source.streamId,
          ...(scene.source.acquisitionId === undefined
            ? {}
            : { acquisitionId: scene.source.acquisitionId }),
        }),
        scene,
      ];
    }),
  );
  const candidates = await selectProjectIndex({
    model: plan.model,
    revisionId: identity.revisionId,
    processing: plan.processing,
    tap: identity.tap,
    signal,
    scenes(occurrence, range) {
      const scene = dependencies.get(sourceSelectionKey(occurrence));
      return scene
        ? {
            generation: scene.generation,
            chunks: observedChunks(owners.records, scene, range, signal),
          }
        : null;
    },
  });
  for (const candidate of candidates) {
    signal.throwIfAborted();
    encodeIndexRecord(candidate);
    if (candidate.ordinal % 128 === 0) await setImmediate(undefined, { signal });
  }
  const { index, frames, cache } = owners;
  let through = 0;
  function gap(endUs: number) {
    if (through < endUs)
      index.appendCoverage(identity, {
        ordinal: null,
        equality: "unproven",
        project: { startUs: through, endUs },
      });
  }
  const issues = distinctIssues();
  try {
    index.begin(identity);
    for (const candidate of candidates) {
      const input = {
        projectId: identity.projectId,
        revisionId: identity.revisionId,
        tap: identity.tap,
        maxLongEdge: identity.maxLongEdge,
        ...(identity.observationRequest === undefined
          ? {}
          : { observations: identity.observationRequest }),
        ...(identity.faceObservationRequest === undefined
          ? {}
          : { faceObservations: identity.faceObservationRequest }),
        atUs: candidate.sampleAtUs,
      };
      const status = await waitForIndexFrame(
        () => {
          const status = frames.request(input);
          if (status.jobId) {
            const child = owners.jobs.job(status.jobId);
            if (child.state === "waiting" && child.reason !== null)
              throw new JobDependencyLost("Index frame lost its admitted pointer history");
          }
          return status;
        },
        () => frames.retry(input),
        retryFrames,
        signal,
      );
      if (!status.published)
        throw dependencyRefusal(
          "FRAME_FAILED",
          status.reason ?? "Picture preparation did not publish",
          { dependency: { artifact: "frame", jobId: status.jobId, ...input } },
          status.retryable,
        );
      issues.add(status.published.issues);
      const frame = status.published.frame as ProjectFrameArtifact;
      if (frame.implementationId !== identity.implementationId)
        throw new CatalogError("ARTIFACT_CHANGED", "Pinned picture renderer changed");
      await retainIndexFrame(
        cache,
        frame,
        index.outputPath(identity, candidate.ordinal),
        signal,
        (retained) =>
          index.appendCandidate(identity, candidate, {
            ...(retained as any),
            sizeBytes: (retained as any).sizeBytes ?? (retained as any).bytes,
          }),
      );
      gap(candidate.visibleRange.startUs);
      index.appendCoverage(identity, {
        ordinal: candidate.ordinal,
        equality: "sampled",
        project: candidate.visibleRange,
      });
      through = candidate.visibleRange.endUs;
    }
    gap(plan.model.durationUs);
    signal.throwIfAborted();
    return { metadata: await index.finish(identity, signal), issues: issues.list() };
  } catch (error) {
    await index.remove(identity);
    throw error;
  }
}
