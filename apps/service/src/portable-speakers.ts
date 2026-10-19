import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { acquisitionContext } from "@yap/core/acquisitions";
import { CatalogError } from "@yap/core/catalog";
import {
  admitProjectEvidenceRange,
  projectCompositionFromRevision,
} from "@yap/core/project-window";
import { sourceSelectionKey, type SourceSelection } from "@yap/core/source-selection";
import { selectSourceChannel } from "@yap/core/source-selection";
import {
  speakerOperandRecords,
  speakerGenerationResource,
  type SpeakerEvidenceMetadata,
  type SpeakerEvidenceStore,
} from "@yap/core/speaker-evidence";
import {
  initialProjectSpeakers,
  mergeSpeakers,
  projectSpeakerCoverage,
  projectSpeakerTracks,
  type ProjectSpeakerPosition,
  type ProjectSpeakerRow,
} from "@yap/core/project-speakers";
import type {
  EvidenceCheckpoint,
  EvidenceManifest,
  ProjectEvidenceCursor,
  ProjectSpeakerInput,
} from "@yap/core/project-evidence";
import type { PortableResource, ValidatedProjectPackage } from "@yap/core/project-package";
import type { FileAccess } from "@yap/core/files";
import { createSourceRangeProjection, toTime, type ExactRange, type Issue } from "@yap/composition";

type Context = { manifest: ValidatedProjectPackage; files: FileAccess };
export type PortableSpeakerCheckpoint = {
  packageHandle: string;
  manifest: EvidenceManifest;
  state: EvidenceCheckpoint<ProjectSpeakerPosition>;
  issues: Issue[];
  rows: ProjectSpeakerRow[];
  nextCursor: ProjectEvidenceCursor | null;
};
const changed = () => new CatalogError("ARTIFACT_CHANGED", "Portable speaker continuation changed");
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const range = (value: ExactRange) => ({ startUs: toTime(value.start), endUs: toTime(value.end) });

/** Immutable package metadata supplies the existing speaker projection and merge owners. */
export function portableProjectSpeakers(
  context: Context,
  packageHandle: string,
  input: ProjectSpeakerInput,
  engine: SpeakerEvidenceMetadata["source"]["engine"],
  jobId: string,
  manifestId: string,
  previous?: PortableSpeakerCheckpoint,
): PortableSpeakerCheckpoint {
  const { manifest: archive, files } = context;
  if (archive.snapshot.project.projectId !== input.projectId)
    throw new CatalogError("NOT_FOUND", "Project is outside this package");
  const cursor = input.cursor as ProjectEvidenceCursor | undefined;
  if (
    previous &&
    (previous.packageHandle !== packageHandle ||
      previous.state.queryDigest !== cursor?.queryDigest ||
      previous.state.manifestId !== cursor.manifestId)
  )
    throw changed();
  const revisionId =
    input.revisionId ?? cursor?.revisionId ?? archive.snapshot.project.currentRevisionId;
  const revision = archive.snapshot.revisions.find((value) => value.revisionId === revisionId);
  if (!revision) throw new CatalogError("NOT_FOUND", "Revision is outside this package");
  const assets = new Map(
    archive.resources.flatMap((value) =>
      value.kind === "asset" ? [[value.asset.id, value.asset] as const] : [],
    ),
  );
  const acquisitions = new Map(
    archive.resources.flatMap((value) =>
      value.kind === "acquisition" ? [[value.acquisition.id, value.acquisition] as const] : [],
    ),
  );
  const sourceAssets = {
    get: (id: string) => {
      const value = assets.get(id);
      if (!value) throw new CatalogError("NOT_FOUND", "Package source asset is absent");
      return value;
    },
    path: (id: string) => files.path(`assets/${assets.get(id)!.fileName}`),
  };
  const sourceAcquisitions = {
    get: (id: string) => {
      const value = acquisitions.get(id);
      if (!value) throw new CatalogError("NOT_FOUND", "Package acquisition is absent");
      return value;
    },
  };
  const { model } = projectCompositionFromRevision(
    revision,
    sourceAssets,
    [...acquisitions.values()].map(acquisitionContext),
  );
  const projection = createSourceRangeProjection(model);
  const admitted = admitProjectEvidenceRange(
    model.durationUs,
    input.range ?? previous?.manifest.query.range,
    input.range === undefined,
  );
  const selectedRange = admitted.range;
  const eligible = model.document.tracks
    .filter((track) => track.kind === "audio")
    .map((track) => track.id);
  const trackIds = [
    ...new Set(input.trackIds ?? previous?.manifest.query.trackIds ?? eligible),
  ].sort();
  if (trackIds.some((id) => !eligible.includes(id)))
    throw new CatalogError("INVALID_PARAMS", "Tracks are not applicable to speaker evidence");
  const query: EvidenceManifest["query"] = {
    domain: "speakers",
    channel: input.channel,
    modelId: input.modelId,
    projectId: input.projectId,
    revisionId,
    range: selectedRange,
    trackIds,
    policy: "project-speakers-v1",
  };
  const queryDigest = digest({ packageHandle, query, engine });
  if (
    cursor &&
    (cursor.projectId !== input.projectId ||
      cursor.revisionId !== revisionId ||
      cursor.queryDigest !== queryDigest ||
      previous?.manifest.queryDigest !== queryDigest)
  )
    throw changed();
  const occurrences =
    model.durationUs === 0 ? [] : projection.window({ range: selectedRange, trackIds });
  if (occurrences.length > 10000)
    throw new CatalogError("LIMIT_EXCEEDED", "Evidence window exceeds 10000 occurrences");
  const selections = new Map<string, SourceSelection>();
  for (const clip of occurrences) {
    const selection = {
      assetId: clip.assetId,
      streamId: clip.streamId,
      ...(clip.acquisitionId === undefined ? {} : { acquisitionId: clip.acquisitionId }),
    };
    selections.set(sourceSelectionKey(selection), selection);
  }
  if (selections.size > 1024)
    throw new CatalogError("LIMIT_EXCEEDED", "Evidence window exceeds 1024 sources");
  const resources = archive.resources
    .filter(
      (value): value is Extract<PortableResource, { kind: "speaker-generation" }> =>
        value.kind === "speaker-generation",
    )
    .toSorted((a, b) => a.sequence - b.sequence);
  const dependencies: EvidenceManifest["dependencies"] = [...selections]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, selection]) => {
      const selected = selectSourceChannel(sourceAssets, sourceAcquisitions, {
        ...selection,
        channel: input.channel,
      });
      const found = new Map<string, SpeakerEvidenceMetadata>();
      for (const resource of resources) {
        const source = resource.metadata.source;
        if (
          resource.metadata.owner.id === selection.assetId &&
          source.streamId === selection.streamId &&
          source.acquisitionId === (selection.acquisitionId ?? null) &&
          source.channel === input.channel &&
          source.supportDigest === selected.supportDigest &&
          isDeepStrictEqual(source.engine, engine)
        )
          found.set(JSON.stringify(source.observationRange), resource.metadata);
      }
      const evidence = [...found.values()],
        speaker = {
          selection,
          evidence,
          state: evidence.length ? "ready" : "unavailable",
          reason: evidence.length ? null : "source_evidence_unobserved",
          retryable: false,
          jobId: null,
        };
      return { ...speaker, transcript: null, speaker };
    });
  const plan = {
    query,
    projection,
    occurrence: (id: string) => {
      const clip = projection.inverse(id, selectedRange);
      if (!clip) throw changed();
      return clip;
    },
  };
  const bySource = new Map(
    dependencies.map((value) => [sourceSelectionKey(value.selection), value.speaker!]),
  );
  const manifest: EvidenceManifest = {
    query,
    queryDigest,
    dependencies,
    tracks: projectSpeakerTracks(occurrences, dependencies, plan),
    coverage: occurrences.map((clip) => ({
      clipId: clip.clipId,
      trackId: clip.trackId,
      projectRange: range(clip.project),
      available: clip.fragments.map((value) => range(value.project)),
      unavailable: clip.unavailable.map((value) => range(value.project)),
      ...projectSpeakerCoverage(clip, bySource.get(sourceSelectionKey(clip))!.evidence, projection),
    })),
  };
  const state: EvidenceCheckpoint<ProjectSpeakerPosition> = previous
    ? structuredClone(previous.state)
    : {
        manifestId,
        queryDigest,
        initialized: 0,
        pendingTrack: null,
        tracks: manifest.tracks.map(initialProjectSpeakers),
        heap: [],
        last: null,
      };
  const recordReads = new Map<string, ReturnType<typeof speakerOperandRecords>>();
  const records: Pick<SpeakerEvidenceStore, "intervalPage"> = {
    intervalPage: (request) => {
      const identity = speakerGenerationResource(request.identity);
      let reader = recordReads.get(identity);
      if (!reader) {
        const resource = resources.find(
          (value) => speakerGenerationResource(value.metadata) === identity,
        );
        if (!resource) throw changed();
        reader = speakerOperandRecords(resource.metadata, resource);
        recordReads.set(identity, reader);
      }
      return reader.intervalPage(request);
    },
  };
  const limit = input.limit ?? 250;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new CatalogError("INVALID_PARAMS", "Limit must be 1 to 1000");
  const rows = mergeSpeakers(manifest, plan, state, limit, records).map((row) => {
    const resource = resources.find((value) => value.metadata.generation === row.generation);
    const label = resource?.bindings.find((binding) => binding.slot === row.slot)?.displayName;
    return label === undefined ? row : { ...row, label };
  });
  const more =
    state.initialized < state.tracks.length || state.pendingTrack !== null || state.heap.length > 0;
  return {
    packageHandle,
    manifest,
    state,
    issues: admitted.issues,
    rows,
    nextCursor: more
      ? {
          projectId: input.projectId,
          revisionId,
          manifestId: state.manifestId,
          checkpointId: jobId,
          queryDigest,
        }
      : null,
  };
}
