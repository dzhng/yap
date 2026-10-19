import { storedWork, type StoredWorkState } from "@yap/protocol";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  compare,
  fromTime,
  toTime,
  createSourceRangeProjection,
  createProjectCuts,
  documentAssetIds,
  validateComposition,
  type Issue,
  type TimeValue,
  type SelectionRange,
  type SourceWindowOccurrence,
} from "@yap/composition";
import { AssetStore, compositionAsset } from "./assets.js";
import { CatalogError, dependencyRefusal } from "./catalog.js";
import { ProjectStore } from "./projects.js";
import type { JobExecution, JobQueue } from "./jobs.js";
import type { DerivedCache } from "./cache.js";
import type { RetainedRead } from "./files.js";
import { submitCachedDerivative } from "./cached-derivative.js";
import { TranscriptProcessing } from "./transcript-processing.js";
import { transcriptSearchTerms } from "./transcript-read.js";
import {
  publicTranscriptMetadata,
  publicTranscriptIssues,
  type TranscriptMetadata,
  type TranscriptRecords,
} from "./transcript.js";
import { sourceSelectionKey as selectionKey, type SourceSelection } from "./source-selection.js";
import {
  initialTranscript,
  mergeTranscript,
  type TranscriptPosition,
} from "./project-transcript.js";
import type { EvidenceKey } from "./evidence-merge.js";
import { admitProjectEvidenceRange } from "./project-window.js";
import { boundSourceEvidenceResponse, type CaptureDomain } from "./capture-source-read.js";
import { initialProjectEvents, mergeEvents, type ProjectEventPosition } from "./project-events.js";
import { SourceEvents, type SourceEventContext } from "./source-events.js";
import { speakerSourceSchema } from "./source-speakers.js";
import {
  initialProjectSpeakers,
  mergeSpeakers,
  projectSpeakerCoverage,
  projectSpeakerTracks,
  type ProjectSpeakerPosition,
  type ProjectSpeakerDependency,
} from "./project-speakers.js";
import type { SpeakerEvidenceMetadata, SpeakerEvidenceStore } from "./speaker-evidence.js";
import type { SpeakerProcessing } from "./speaker-processing.js";
export type { ProjectSpeakerRow, ProjectSpeakerDependency } from "./project-speakers.js";
export type ProjectSpeakerInput = ProjectEvidenceInput & { channel: number; modelId: string };
export type ProjectTranscriptSpeaker = SourceSelection & {
  channel: number;
  modelId: string;
  observationRange: SelectionRange;
  generation: string;
};
type ProjectCheckpoint =
  | (EvidenceCheckpoint<TranscriptPosition> & { kind: "transcript" })
  | (EvidenceCheckpoint<ProjectEventPosition> & { kind: "events" })
  | (EvidenceCheckpoint<ProjectSpeakerPosition> & { kind: "speakers" });
export type { ProjectEventRow } from "./project-events.js";
export type { ProjectTranscriptRow, ProjectTranscriptMatch } from "./project-transcript.js";
export type EvidencePagePlan = ReturnType<ProjectEvidenceInspection["pagePlan"]>;

const artifact = "project.evidence";
const policy = (domain: Query["domain"]) =>
  domain === "speakers"
    ? "project-speakers-v1"
    : domain === "events"
      ? "project-events-v2"
      : domain === "cursor"
        ? "project-events-v1"
        : "project-transcript-v4";
// Provisional inspection budgets; scale acceptance owns changes to these limits.
const maximumBytes = 8 * 1024 * 1024;

const cursorSchema = z.strictObject({
  projectId: z.string(),
  revisionId: z.string(),
  manifestId: z.uuid(),
  checkpointId: z.uuid(),
  queryDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ProjectEvidenceCursor = z.infer<typeof cursorSchema>;
export type ProjectEvidenceInput = {
  prepare?: boolean | undefined;
  sourceGenerations?: readonly (SourceSelection & { generation: string })[] | undefined;
  speakerGenerations?: readonly ProjectTranscriptSpeaker[] | undefined;
  projectId: string;
  revisionId?: string | undefined;
  range?: { startUs: number; endUs: number } | undefined;
  trackIds?: readonly string[] | undefined;
  limit?: number | undefined;
  cursor?: unknown;
};
type QueryInput = ProjectEvidenceInput & {
  text?: string | undefined;
  domain?: Query["domain"];
  channel?: number;
  modelId?: string;
};
type Query = {
  sourceGenerations?: (SourceSelection & { generation: string })[];
  speakerGenerations?: ProjectTranscriptSpeaker[];
  speakerBindingDigests?: { selection: string; generation: string; digest: string }[];
  domain: "transcript" | "transcript.search" | CaptureDomain | "speakers";
  channel?: number;
  modelId?: string;
  text?: string;
  projectId: string;
  revisionId: string;
  range: { startUs: number; endUs: number };
  trackIds: string[];
  policy: string;
};
type Dependency = {
  capture?: SourceEventContext;
  speaker?: ProjectSpeakerDependency;
  selection: SourceSelection;
  transcript: TranscriptMetadata | null;
  /** The issues published with `transcript`; a project read reports its sources' problems. */
  issues?: Issue[];
  state: StoredWorkState;
  reason: string | null;
  retryable: boolean;
  jobId: string | null;
};
export type EvidenceManifest = {
  query: Query;
  queryDigest: string;
  dependencies: Dependency[];
  tracks: { clipIds: string[]; lowerBound: TimeValue; cuts?: true; speakerGeneration?: string }[];
  coverage?: {
    clipId: string;
    trackId: string;
    projectRange: SelectionRange;
    available: SelectionRange[];
    unavailable: SelectionRange[];
    observed?: SelectionRange[];
    unobserved?: SelectionRange[];
  }[];
};
export type EvidenceCheckpoint<Position> = {
  manifestId: string;
  queryDigest: string;
  initialized: number;
  pendingTrack: number | null;
  tracks: Position[];
  heap: number[];
  last: EvidenceKey | null;
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const changed = () =>
  new CatalogError("ARTIFACT_CHANGED", "Project evidence continuation or dependencies changed");
/** Immutable query manifests and resumable merge checkpoints share the project's disposable cache. */
export class ProjectEvidenceInspection {
  constructor(
    private readonly options: {
      projects: ProjectStore;
      assets: AssetStore;
      jobs: JobQueue;
      cache: DerivedCache;
      transcripts: TranscriptProcessing;
      records: TranscriptRecords;
      events?: SourceEvents;
      speakers?: Pick<SpeakerProcessing, "resolveMany"> & {
        records: Pick<SpeakerEvidenceStore, "intervalPage">;
        sourceStatus?: SpeakerProcessing["sourceStatus"];
        labels?: (metadata: SpeakerEvidenceMetadata) => ReadonlyMap<number, string>;
      };
    },
  ) {}

  private readonly revisions = new Map<
    string,
    {
      model: ReturnType<typeof validateComposition>;
      projection: ReturnType<typeof createSourceRangeProjection>;
      cuts?: ReturnType<typeof createProjectCuts>;
      speakerCorrections: import("./speaker-attribution.js").SpeakerCorrection[];
      tracks: readonly { id: string; kind: string }[];
    }
  >();

  private query(input: QueryInput, storedRange = false) {
    const project = this.options.projects.get(input.projectId);
    const revisionId = input.revisionId ?? project.currentRevisionId;
    const key = JSON.stringify([input.projectId, revisionId]);
    let context = this.revisions.get(key);
    if (!context) {
      const revision = this.options.projects.revision(input.projectId, revisionId);
      const ids = documentAssetIds(revision.document);
      const model = validateComposition(
        revision.document,
        ids.map((id) => compositionAsset(this.options.assets.get(id))),
        this.options.projects.contexts(revision.document),
      );
      context = {
        model,
        projection: createSourceRangeProjection(model),
        tracks: model.document.tracks,
        speakerCorrections: revision.speakerCorrections ?? [],
      };
    }
    this.revisions.delete(key);
    this.revisions.set(key, context);
    if (this.revisions.size > 4) this.revisions.delete(this.revisions.keys().next().value!);
    const { model, projection } = context;
    const domain = input.domain ?? (input.text === undefined ? "transcript" : "transcript.search");
    const eligible = context.tracks
      .filter(
        (track) => domain === "events" || track.kind === (domain === "cursor" ? "video" : "audio"),
      )
      .map((track) => track.id);
    const eligibleIds = new Set(eligible);
    const admitted = admitProjectEvidenceRange(model.durationUs, input.range, storedRange);
    const empty = model.durationUs === 0;
    const trackIds = [...new Set(input.trackIds ?? eligible)].sort();
    if (trackIds.some((id) => !eligibleIds.has(id)))
      throw new CatalogError("INVALID_PARAMS", "Tracks are not applicable to this evidence domain");
    const cuts =
      empty || domain !== "events"
        ? []
        : (context.cuts ??= createProjectCuts(model)).window({ range: admitted.range, trackIds });
    if (input.text !== undefined) transcriptSearchTerms(input.text);
    const speaker =
      domain === "speakers"
        ? speakerSourceSchema
            .pick({ channel: true, modelId: true })
            .parse({ channel: input.channel, modelId: input.modelId })
        : {};
    const speakerBindingDigests =
      input.speakerGenerations &&
      this.options.speakers?.sourceStatus &&
      this.options.speakers.labels
        ? input.speakerGenerations.map((selector) => {
            const status = this.options.speakers!.sourceStatus!({
              ...selector,
              sourceRange: selector.observationRange,
            });
            const labels =
              status.published?.evidence.generation === selector.generation
                ? [...this.options.speakers!.labels!(status.published.evidence).entries()]
                : [];
            return {
              selection: selectionKey(selector),
              generation: selector.generation,
              digest: digest(labels),
            };
          })
        : undefined;
    const query: Query = {
      ...speaker,
      ...(input.sourceGenerations === undefined
        ? {}
        : {
            sourceGenerations: [...input.sourceGenerations].sort((a, b) =>
              selectionKey(a).localeCompare(selectionKey(b)),
            ),
          }),
      ...(input.speakerGenerations === undefined
        ? {}
        : {
            speakerGenerations: [...input.speakerGenerations].sort((a, b) =>
              selectionKey(a).localeCompare(selectionKey(b)),
            ),
          }),
      ...(speakerBindingDigests === undefined ? {} : { speakerBindingDigests }),
      domain,
      ...(input.text === undefined ? {} : { text: input.text }),
      projectId: input.projectId,
      revisionId,
      range: admitted.range,
      trackIds,
      policy: policy(domain),
    };
    return { query, queryDigest: digest(query), projection, cuts, issues: admitted.issues };
  }
  private plan(input: QueryInput, storedRange = false) {
    const plan = this.query(input, storedRange);
    const occurrences =
      plan.query.range.endUs === 0
        ? []
        : plan.projection.window({ range: plan.query.range, trackIds: plan.query.trackIds });
    if (occurrences.length > 10000)
      throw new CatalogError("LIMIT_EXCEEDED", "Evidence window exceeds 10000 occurrences");
    if (plan.cuts.length > 20000)
      throw new CatalogError("LIMIT_EXCEEDED", "Evidence window exceeds 20000 cuts");
    const selections = new Map<string, SourceSelection>();
    for (const value of occurrences) {
      const selection = {
        assetId: value.assetId,
        streamId: value.streamId,
        ...(value.acquisitionId === undefined ? {} : { acquisitionId: value.acquisitionId }),
      };
      selections.set(selectionKey(selection), selection);
    }
    if (selections.size > 1024)
      throw new CatalogError("LIMIT_EXCEEDED", "Evidence window exceeds 1024 sources");
    if (plan.query.sourceGenerations) {
      const keys = plan.query.sourceGenerations.map(selectionKey);
      if (new Set(keys).size !== keys.length || keys.some((key) => !selections.has(key)))
        throw new CatalogError(
          "INVALID_REQUEST",
          "Transcript generation selectors must uniquely name selected project sources",
        );
    }
    if (plan.query.speakerGenerations) {
      const keys = plan.query.speakerGenerations.map(selectionKey);
      if (new Set(keys).size !== keys.length || keys.some((key) => !selections.has(key)))
        throw new CatalogError(
          "INVALID_REQUEST",
          "Speaker generation selectors must uniquely name selected project sources",
        );
    }
    return {
      ...plan,
      occurrences,
      selections: [...selections]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, selection]) => selection),
    };
  }
  private pagePlan(input: QueryInput, storedRange: boolean) {
    const plan = this.query(input, storedRange);
    const occurrences = new Map<string, SourceWindowOccurrence>();
    return {
      ...plan,
      occurrence: (clipId: string) => {
        let clip = occurrences.get(clipId);
        if (!clip) {
          clip = plan.projection.inverse(clipId, plan.query.range) ?? undefined;
          if (!clip) throw changed();
          occurrences.set(clipId, clip);
        }
        return clip;
      },
    };
  }
  private dependencies(
    selections: readonly SourceSelection[],
    prepare: boolean,
    query: Query,
  ): Dependency[] {
    const domain = query.domain;
    if (selections.length === 0) return [];
    if (domain === "speakers") {
      if (!this.options.speakers)
        throw new CatalogError("UNAVAILABLE", "Speaker inspection is unavailable");
      return this.options.speakers
        .resolveMany(selections, { channel: query.channel!, modelId: query.modelId! })
        .map((speaker) =>
          storedWork({
            selection: speaker.selection,
            speaker,
            transcript: null,
            state: speaker.state,
            reason: speaker.reason,
            retryable: speaker.retryable,
            jobId: speaker.jobId,
          }),
        );
    }
    if (domain === "events" || domain === "cursor") {
      if (!this.options.events)
        throw new CatalogError("UNAVAILABLE", "Capture inspection is unavailable");
      return this.options.events.resolveMany(selections, domain, prepare).map((capture, index) => {
        const selection = selections[index]!;
        const ready = capture.coverage.some((value) => value.state === "ready");
        return storedWork({
          selection,
          transcript: null,
          capture,
          state:
            capture.scene && !["ready", "unavailable"].includes(capture.scene.state)
              ? capture.scene.state
              : ready
                ? "ready"
                : "unavailable",
          reason: ready ? null : capture.coverage[0]!.reason,
          retryable: capture.scene?.retryable ?? false,
          jobId: capture.scene?.jobId ?? null,
        });
      });
    }
    return selections.map((selection) => {
      const generation = query.sourceGenerations?.find(
        (value) => selectionKey(value) === selectionKey(selection),
      )?.generation;
      const status = this.options.transcripts.sourceStatus({
        ...selection,
        ...(generation === undefined ? {} : { generation }),
      });
      const speakerSelector = query.speakerGenerations?.find(
        (value) => selectionKey(value) === selectionKey(selection),
      );
      let speaker: ProjectSpeakerDependency | undefined;
      if (speakerSelector) {
        if (!this.options.speakers?.sourceStatus)
          throw new CatalogError("UNAVAILABLE", "Speaker attribution is unavailable");
        const status = this.options.speakers.sourceStatus({
          ...selection,
          channel: speakerSelector.channel,
          modelId: speakerSelector.modelId,
          sourceRange: speakerSelector.observationRange,
        });
        const evidence =
          status.published && status.published.evidence.generation === speakerSelector.generation
            ? [status.published.evidence]
            : [];
        speaker = storedWork({
          selection,
          evidence,
          state: evidence.length ? "ready" : status.state,
          reason: evidence.length ? null : (status.reason ?? "speaker_evidence_changed"),
          retryable: evidence.length ? false : status.retryable,
          jobId: null,
        });
      }
      return storedWork({
        selection,
        transcript: status.published?.transcript ?? null,
        ...(speaker === undefined ? {} : { speaker }),
        issues: publicTranscriptIssues(status.published?.issues ?? []),
        state: status.published ? "ready" : status.state,
        reason: status.published ? null : status.reason,
        retryable: status.published ? false : status.retryable,
        jobId: status.jobId,
      });
    });
  }
  private pins(dependencies: Dependency[]) {
    return dependencies.map(({ selection, transcript, state, reason, capture, speaker }) =>
      speaker
        ? { selection, speaker }
        : capture
          ? { selection, capture }
          : {
              selection,
              generation: transcript?.generation ?? null,
              source: transcript?.source ?? null,
              engine: transcript?.engine ?? null,
              state,
              reason,
            },
    );
  }
  request(input: QueryInput) {
    const plan = this.plan(input),
      dependencies = this.dependencies(plan.selections, input.prepare !== false, plan.query);
    const pending = dependencies.filter((dependency) =>
      dependency.capture
        ? !!dependency.capture.scene &&
          !["ready", "unavailable"].includes(dependency.capture.scene.state)
        : (plan.query.speakerGenerations !== undefined &&
            dependency.speaker !== undefined &&
            dependency.speaker.state !== "ready") ||
          (!dependency.speaker && !dependency.transcript && dependency.reason !== "no_audio"),
    );
    if (pending.length)
      return storedWork({
        ...plan.query,
        issues: plan.issues,
        state: "not_ready",
        reason: "source_evidence_not_ready",
        retryable: pending.some((d) => d.retryable),
        jobId: null,
        published: null,
        dependencies,
      });
    const status = submitCachedDerivative<{ cacheId: string }>(
      this.options.jobs,
      this.options.cache,
      {
        target: { kind: "project", projectId: input.projectId, revisionId: plan.query.revisionId },
        artifact,
        input: JSON.stringify({ query: plan.query, pins: digest(this.pins(dependencies)) }),
      },
      "frame",
    );
    return { ...plan.query, issues: plan.issues, ...status, dependencies };
  }
  retry(input: QueryInput) {
    const status = this.request(input);
    if (!status.jobId)
      throw dependencyRefusal(
        "NOT_READY",
        "Source evidence is not ready",
        { dependencies: status.dependencies },
        status.retryable,
      );
    this.options.jobs.retry(status.jobId);
    return this.request(input);
  }
  async execute({ job, signal }: JobExecution) {
    if (job.target.kind !== "project" || job.artifact !== artifact)
      throw new CatalogError("UNSUPPORTED_JOB", "Project evidence needs a project target");
    const input = JSON.parse(job.input) as { query: Query; pins: string };
    const plan = this.plan(
      { ...input.query, projectId: job.target.projectId, revisionId: job.target.revisionId },
      true,
    );
    const dependencies = this.dependencies(plan.selections, false, plan.query);
    if (
      digest(this.pins(dependencies)) !== input.pins ||
      digest(plan.query) !== digest(input.query)
    )
      throw changed();
    const byTrack = new Map(plan.query.trackIds.map((id) => [id, [] as string[]]));
    for (const clip of plan.occurrences) byTrack.get(clip.trackId)!.push(clip.clipId);
    const tracks: EvidenceManifest["tracks"] =
      plan.query.domain === "speakers"
        ? projectSpeakerTracks(plan.occurrences, dependencies, plan)
        : [...byTrack.values()]
            .flatMap((clipIds) => {
              return clipIds.length
                ? [
                    {
                      clipIds,
                      lowerBound: toTime(
                        plan.projection.inverse(clipIds[0]!, {
                          startUs: 0,
                          endUs: plan.query.range.endUs,
                        })!.project.start,
                      ),
                    },
                  ]
                : [];
            })
            .sort((a, b) => compare(fromTime(a.lowerBound), fromTime(b.lowerBound)));
    if (plan.cuts.length) {
      tracks.push({ clipIds: [], lowerBound: plan.cuts[0]!.projectAtUs, cuts: true });
      tracks.sort((a, b) => compare(fromTime(a.lowerBound), fromTime(b.lowerBound)));
    }
    const dependencyBySource = new Map(dependencies.map((d) => [selectionKey(d.selection), d]));
    const manifest: EvidenceManifest = {
      query: plan.query,
      queryDigest: plan.queryDigest,
      dependencies,
      tracks,
      ...(plan.query.domain === "events" ||
      plan.query.domain === "cursor" ||
      plan.query.domain === "speakers"
        ? {
            coverage: plan.occurrences.map((clip) => {
              const range = (value: {
                start: Parameters<typeof toTime>[0];
                end: Parameters<typeof toTime>[0];
              }) => ({ startUs: toTime(value.start), endUs: toTime(value.end) });
              return {
                clipId: clip.clipId,
                trackId: clip.trackId,
                projectRange: range(clip.project),
                available: clip.fragments.map((value) => range(value.project)),
                unavailable: clip.unavailable.map((value) => range(value.project)),
                ...(plan.query.domain === "speakers"
                  ? projectSpeakerCoverage(
                      clip,
                      dependencyBySource.get(selectionKey(clip))!.speaker!.evidence,
                      plan.projection,
                    )
                  : {}),
              };
            }),
          }
        : {}),
    };
    const cacheId = await this.publish(plan.query.projectId, manifest, signal);
    return JSON.stringify({ cacheId });
  }
  private acquire<T>(id: string, leases: RetainedRead[]): T {
    const read = this.options.cache.acquire(id);
    if (!read) throw changed();
    leases.push(read);
    if (read.bytes > maximumBytes)
      throw new CatalogError("LIMIT_EXCEEDED", "Evidence cache exceeds its bound");
    const buffer = Buffer.alloc(read.bytes);
    let at = 0;
    while (at < buffer.length) {
      const bytes = read.read(buffer.subarray(at), at);
      if (!bytes) throw changed();
      at += bytes;
    }
    try {
      return JSON.parse(buffer.toString("utf8")) as T;
    } catch {
      throw changed();
    }
  }
  private async publish(projectId: string, value: unknown, signal?: AbortSignal) {
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > maximumBytes)
      throw new CatalogError("LIMIT_EXCEEDED", "Evidence checkpoint exceeds 8MiB");
    signal?.throwIfAborted();
    const reservation = this.options.cache.reserve({ kind: "project", projectId });
    try {
      await writeFile(reservation.path, body, { flag: "wx" });
      signal?.throwIfAborted();
      await this.options.cache.publish(reservation.id);
      signal?.throwIfAborted();
      return reservation.id;
    } catch (error) {
      this.options.cache.remove(reservation.id);
      throw error;
    }
  }

  private publicResult<T>(result: T): T {
    const value = result as T & { dependencies?: unknown };
    return {
      ...result,
      dependencies: Array.isArray(value.dependencies)
        ? value.dependencies.map((dependency: any) =>
            dependency.transcript
              ? { ...dependency, transcript: publicTranscriptMetadata(dependency.transcript) }
              : dependency,
          )
        : value.dependencies,
    } as T;
  }
  async get(input: ProjectEvidenceInput) {
    const result = await this.read(input);
    return {
      ...this.publicResult(result),
      page: result.page && { rows: result.page.rows, nextCursor: result.page.nextCursor },
    };
  }
  async search(input: ProjectEvidenceInput & { text: string }) {
    transcriptSearchTerms(input.text);
    const result = await this.read(input);
    return {
      ...this.publicResult(result),
      page: result.page && { entries: result.page.entries, nextCursor: result.page.nextCursor },
    };
  }
  async events(input: ProjectEvidenceInput) {
    const result = await this.read({ ...input, domain: "events" });
    return {
      ...this.publicResult(result),
      coverage: "coverage" in result ? (result.coverage ?? null) : null,
      page: result.page && { rows: result.page.events, nextCursor: result.page.nextCursor },
    };
  }
  async cursor(input: ProjectEvidenceInput) {
    const result = await this.read({ ...input, domain: "cursor" });
    return {
      ...this.publicResult(result),
      coverage: "coverage" in result ? (result.coverage ?? null) : null,
      page: result.page && { rows: result.page.events, nextCursor: result.page.nextCursor },
    };
  }
  async speakers(input: ProjectSpeakerInput) {
    const result = await this.read({ ...input, domain: "speakers", prepare: false });
    return {
      ...this.publicResult(result),
      coverage: "coverage" in result ? (result.coverage ?? null) : null,
      page: result.page && { rows: result.page.speakers, nextCursor: result.page.nextCursor },
    };
  }
  private async read(input: QueryInput) {
    const parsed = input.cursor === undefined ? null : cursorSchema.safeParse(input.cursor);
    if (parsed && !parsed.success)
      throw new CatalogError("INVALID_PARAMS", "Invalid project evidence cursor");
    const cursor = parsed?.success ? parsed.data : null;
    if (
      cursor &&
      (cursor.projectId !== input.projectId ||
        (input.revisionId !== undefined && input.revisionId !== cursor.revisionId))
    )
      throw new CatalogError("INVALID_PARAMS", "Project evidence continuation used other filters");
    const maximum = input.domain === "cursor" ? 5000 : 1000;
    const limit = input.limit ?? 250;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum)
      throw new CatalogError("INVALID_PARAMS", `Limit must be 1 to ${maximum}`);
    const leases: RetainedRead[] = [];
    let created: string | null = null;
    try {
      const status = cursor ? null : this.request(input);
      if (status && !status.published) {
        if (input.domain === "events" || input.domain === "cursor")
          boundSourceEvidenceResponse(status);
        return { ...status, page: null };
      }
      const manifestId = cursor?.manifestId ?? status!.published!.value.cacheId;
      const manifest = this.acquire<EvidenceManifest>(manifestId, leases);
      if (
        manifest?.query?.policy !==
        policy(input.domain ?? (input.text === undefined ? "transcript" : "transcript.search"))
      )
        throw cursor && manifest
          ? new CatalogError("INVALID_PARAMS", "Project evidence continuation is another read's")
          : changed();
      const plan = this.pagePlan(
        {
          ...input,
          revisionId: cursor?.revisionId ?? manifest.query.revisionId,
          range: input.range ?? manifest.query.range,
          trackIds: input.trackIds ?? manifest.query.trackIds,
          sourceGenerations: input.sourceGenerations ?? manifest.query.sourceGenerations,
          speakerGenerations: input.speakerGenerations ?? manifest.query.speakerGenerations,
        },
        input.range === undefined,
      );
      if (cursor && cursor.queryDigest !== plan.queryDigest)
        throw new CatalogError(
          "INVALID_PARAMS",
          "Project evidence continuation used other filters",
        );
      if (manifest.queryDigest !== plan.queryDigest) throw changed();
      const selections = manifest.dependencies.map(({ selection }) => selection);
      const expectedPins = digest(this.pins(manifest.dependencies));
      const validate = () => {
        this.options.projects.get(input.projectId);
        const current = this.dependencies(selections, false, plan.query);
        if (digest(this.pins(current)) !== expectedPins) throw changed();
        return current;
      };
      const current = validate();
      const state = cursor
        ? this.acquire<ProjectCheckpoint>(cursor.checkpointId, leases)
        : ({
            manifestId,
            queryDigest: manifest.queryDigest,
            initialized: 0,
            pendingTrack: null,
            ...(plan.query.domain === "speakers"
              ? { kind: "speakers" as const, tracks: manifest.tracks.map(initialProjectSpeakers) }
              : plan.query.domain === "events" || plan.query.domain === "cursor"
                ? { kind: "events" as const, tracks: manifest.tracks.map(initialProjectEvents) }
                : { kind: "transcript" as const, tracks: manifest.tracks.map(initialTranscript) }),
            heap: [],
            last: null,
          } satisfies ProjectCheckpoint);
      if (state.manifestId !== manifestId || state.queryDigest !== manifest.queryDigest)
        throw changed();
      const merged =
        state.kind === "speakers"
          ? {
              rows: [],
              entries: [],
              events: [],
              speakers: mergeSpeakers(manifest, plan, state, limit, this.options.speakers!.records),
            }
          : state.kind === "events"
            ? {
                rows: [],
                entries: [],
                speakers: [],
                events: mergeEvents(manifest, plan, state, limit, this.options.events!),
              }
            : {
                ...mergeTranscript(
                  manifest,
                  plan,
                  state,
                  limit,
                  this.options.records,
                  this.options.speakers?.records,
                  this.options.speakers?.labels,
                  this.revisions.get(JSON.stringify([input.projectId, manifest.query.revisionId]))
                    ?.speakerCorrections ?? [],
                ),
                events: [],
                speakers: [],
              };
      // Issues follow the pinned generations, so a manifest cached before they were kept reports them.
      const dependencies = cursor
        ? { manifestId }
        : manifest.dependencies.map((dependency, index) =>
            current[index]!.issues === undefined
              ? dependency
              : { ...dependency, issues: current[index]!.issues },
          );
      const coverage = manifest.coverage
        ? {
            manifestId,
            ...(cursor
              ? {}
              : {
                  occurrences: manifest.coverage,
                  ...(plan.query.domain === "events"
                    ? { cuts: { state: "ready", basis: "revision" } }
                    : {}),
                }),
          }
        : undefined;
      if (state.kind === "events")
        boundSourceEvidenceResponse({
          projectId: input.projectId,
          revisionId: manifest.query.revisionId,
          state: "ready",
          dependencies,
          coverage,
          page: {
            rows: merged.events,
            nextCursor: {
              projectId: input.projectId,
              revisionId: manifest.query.revisionId,
              manifestId,
              checkpointId: "00000000-0000-0000-0000-000000000000",
              queryDigest: manifest.queryDigest,
            },
          },
        });
      const more =
        state.initialized < state.tracks.length ||
        state.pendingTrack !== null ||
        state.heap.length > 0;
      let nextCursor: ProjectEvidenceCursor | null = null;
      if (more) {
        created = await this.publish(input.projectId, state);
        validate();
        nextCursor = {
          projectId: input.projectId,
          revisionId: manifest.query.revisionId,
          manifestId,
          checkpointId: created,
          queryDigest: manifest.queryDigest,
        };
      }
      return {
        projectId: input.projectId,
        revisionId: manifest.query.revisionId,
        state: "ready",
        issues: plan.issues,
        dependencies,
        ...(coverage ? { coverage } : {}),
        page: { ...merged, nextCursor },
      };
    } catch (error) {
      if (created) this.options.cache.remove(created);
      throw error;
    } finally {
      for (const lease of leases.reverse()) lease.release();
    }
  }
}
