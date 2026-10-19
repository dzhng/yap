import {
  faceObservationRequestSchema,
  type FaceObservationRequest,
  pictureObservationRequestSchema,
  type PictureObservationRequest,
} from "@yap/protocol";
import type { ProjectStore } from "./projects.js";
import type { ProjectFrameInput } from "./frame-inspection.js";
import { projectComposition } from "./project-window.js";
import {
  projectIndexPlan,
  type ProjectIndexIdentity,
  type ProjectIndexRecords,
} from "./project-index.js";
import {
  materializeProjectIndex,
  retainedProjectIndexIssues,
} from "./project-index-materialization.js";
import { isDeepStrictEqual } from "node:util";
import type { AssetStore } from "./assets.js";
import type { AcquisitionStore } from "./acquisitions.js";
import type { DerivedCache } from "./cache.js";
import type { MediaFrameInspection } from "./frame-inspection.js";
import {
  sceneGenerationResource,
  type SceneEvidenceStore,
  type SceneEvidenceMetadata,
} from "./scene-evidence.js";
import { type SourceSelection } from "./source-selection.js";
import type { SourceIndexIdentity, SourceIndexRecords } from "./source-index.js";
import { sourceIndexPolicy } from "./source-index-selection.js";
import { materializeSourceIndex } from "./source-index-materialization.js";
import { RetainedIndexRead, type IndexCoverageCursor, type IndexReadCursor } from "./index-read.js";
import { setImmediate } from "node:timers/promises";
import { CatalogError, type Catalog } from "./catalog.js";
import type {
  Job,
  JobAdmission,
  JobExecution,
  JobOwner,
  JobQueue,
  RetainedArtifact,
  StagedJobResult,
} from "./jobs.js";
import type { SceneProcessing } from "./scene-processing.js";
import {
  encodeIndexRecord,
  type ScreenshotIndexStore,
  type ScreenshotIndexMetadata,
} from "./screenshot-index.js";

const artifact = "screenshot-index";
export type SourceIndexReference = SourceSelection & { generation: string };
type SourceIndexInput = Omit<SourceIndexIdentity, "generation">;
export type ProjectIndexReference = Pick<
  ProjectIndexIdentity,
  "projectId" | "revisionId" | "generation" | "tap" | "maxLongEdge"
> & {
  observations?: PictureObservationRequest | undefined;
  faceObservations?: FaceObservationRequest | undefined;
};
export type ProjectIndexInput = Omit<ProjectFrameInput, "atUs">;
type ProjectIndexRecipe = Omit<ProjectIndexIdentity, "generation">;
function projectRecipe(metadata: ProjectIndexRecipe): ProjectIndexRecipe {
  return {
    projectId: metadata.projectId,
    revisionId: metadata.revisionId,
    maxLongEdge: metadata.maxLongEdge,
    ...(metadata.observationRequest === undefined
      ? {}
      : { observationRequest: metadata.observationRequest }),
    ...(metadata.faceObservationRequest === undefined
      ? {}
      : { faceObservationRequest: metadata.faceObservationRequest }),
    tap: metadata.tap,
    implementationId: metadata.implementationId,
    selectionPolicy: metadata.selectionPolicy,
    scenes: metadata.scenes,
  };
}
type MediaIndexOwners = {
  catalog: Catalog;
  assets: AssetStore;
  acquisitions: AcquisitionStore;
  scenes: SceneProcessing;
  records: SceneEvidenceStore;
  frames: MediaFrameInspection;
  cache: DerivedCache;
};
export type IndexProcessingOptions = {
  jobs: JobQueue;
  asset?: MediaIndexOwners & { index: ScreenshotIndexStore<SourceIndexRecords> };
  project?: MediaIndexOwners & {
    projects: ProjectStore;
    index: ScreenshotIndexStore<ProjectIndexRecords>;
  };
};
/** Dependency readiness is resolved before index admission to the existing work lanes. */
export class IndexProcessing {
  private readonly jobs: JobQueue;
  constructor(private readonly options: IndexProcessingOptions) {
    this.jobs = options.jobs;
    if (options.project)
      options.project.catalog.catalog.exec(`CREATE INDEX IF NOT EXISTS project_index_publication
        ON artifacts(targetKind,targetId,revisionId,artifact,json_extract(result,'$.generation'))
        WHERE targetKind='project' AND artifact='screenshot-index'`);
    if (options.asset)
      options.asset.catalog.catalog.exec(`
      CREATE INDEX IF NOT EXISTS source_index_publication ON artifacts(targetKind,targetId,artifact,json_extract(result,'$.generation')) WHERE targetKind='asset' AND artifact='screenshot-index';
    `);
  }
  private get asset() {
    if (!this.options.asset)
      throw new CatalogError("UNSUPPORTED_JOB", "Source indexes are unavailable");
    return this.options.asset;
  }
  private get project() {
    if (!this.options.project)
      throw new CatalogError("UNSUPPORTED_JOB", "Project indexes are unavailable");
    return this.options.project;
  }
  private projectPlan(input: ProjectIndexInput) {
    return projectIndexPlan(
      projectComposition(this.project.projects, this.project.assets, input),
      input,
      this.project.frames.projectSupport,
    );
  }
  requestProject(input: ProjectIndexInput) {
    const plan = this.projectPlan(input);
    const dependencies = plan.sources.map((selection) => ({
      artifact: "source-scenes" as const,
      ...this.project.scenes.publishedSource(selection),
    }));
    const waiting =
      dependencies.find(
        (value) => !value.published && ["failed", "unavailable"].includes(value.state),
      ) ?? dependencies.find((value) => !value.published);
    if (waiting)
      return {
        ...plan.identity,
        state: waiting.state,
        reason: waiting.reason,
        retryable: waiting.retryable,
        jobId: null,
        published: null,
        dependencies,
      };
    const recipe = projectRecipe({
      ...plan.identity,
      scenes: dependencies.map((value) => value.published!.evidence),
    });
    const identity = {
      target: {
        kind: "project" as const,
        id: recipe.projectId,
        revisionId: recipe.revisionId,
      },
      artifact,
      input: encodeIndexRecord(recipe),
    };
    const submit = plan.pointerSources.length
      ? this.jobs.submitDeferred.bind(this.jobs)
      : this.jobs.submit.bind(this.jobs);
    if (!this.jobs.status(identity).published)
      submit({ ...identity, lane: "heavy" }, (job) => {
        encodeIndexRecord({ ...recipe, generation: job.attemptId });
        this.jobs.retainInputs(
          job.jobId,
          "scene-generation",
          recipe.scenes.map(sceneGenerationResource),
        );
      });
    const status = this.jobs.status(identity);
    return {
      ...plan.identity,
      ...status,
      dependencies: [],
      published: status.published
        ? {
            generation: status.published.generation,
            issues: status.published.issues,
            evidence: JSON.parse(
              status.published.result,
            ) as ScreenshotIndexMetadata<ProjectIndexRecords>,
          }
        : null,
    };
  }
  retryProject(input: ProjectIndexInput) {
    const status = this.requestProject(input);
    if (!status.published)
      for (const selection of this.projectPlan(input).pointerSources)
        this.project.frames.projectSupport.pointers?.retry(selection);
    if (status.jobId) this.jobs.retry(status.jobId);
    else
      for (const dependency of status.dependencies)
        if (dependency.retryable && !["queued", "processing", "ready"].includes(dependency.state))
          this.project.scenes.retrySource(dependency);
    return this.requestProject(input);
  }
  publishedProject(reference: ProjectIndexReference) {
    this.project.projects.get(reference.projectId);
    const row = this.project.catalog.catalog
      .prepare(`SELECT result FROM artifacts
      WHERE targetKind='project' AND targetId=? AND revisionId=? AND artifact='screenshot-index'
      AND json_extract(result,'$.generation')=? LIMIT 1`)
      .get(reference.projectId, reference.revisionId, reference.generation) as
      | { result: string }
      | undefined;
    if (!row)
      throw new CatalogError("ARTIFACT_CHANGED", "Project screenshot index is not published");
    const metadata = JSON.parse(row.result) as ScreenshotIndexMetadata<ProjectIndexRecords>;
    if (!isDeepStrictEqual(this.projectReference(metadata), this.projectReference(reference)))
      throw new CatalogError(
        "ARTIFACT_CHANGED",
        "Project screenshot index belongs to another selection",
      );
    return metadata;
  }
  private projectReference(
    input: ProjectIndexReference | ProjectIndexIdentity,
  ): ProjectIndexReference {
    const observations = "scenes" in input ? input.observationRequest : input.observations;
    const faceObservations =
      "scenes" in input ? input.faceObservationRequest : input.faceObservations;
    return {
      projectId: input.projectId,
      revisionId: input.revisionId,
      generation: input.generation,
      tap: input.tap,
      maxLongEdge: input.maxLongEdge,
      ...(observations === undefined
        ? {}
        : { observations: pictureObservationRequestSchema.parse(observations) }),
      ...(faceObservations === undefined
        ? {}
        : { faceObservations: faceObservationRequestSchema.parse(faceObservations) }),
    };
  }
  private projectRead(reference: ProjectIndexReference) {
    const pinned = this.projectReference(reference);
    return new RetainedIndexRead<ProjectIndexReference, ProjectIndexRecords>(
      this.project.index,
      this.publishedProject(pinned),
      pinned,
    );
  }
  getProject(
    input: ProjectIndexInput & {
      cursor?: IndexReadCursor<ProjectIndexReference> | undefined;
      limit?: number;
    },
  ) {
    if (
      input.cursor &&
      (input.cursor.projectId !== input.projectId ||
        (input.revisionId !== undefined && input.cursor.revisionId !== input.revisionId) ||
        (input.tap !== undefined && !isDeepStrictEqual(input.cursor.tap, input.tap)) ||
        (input.maxLongEdge !== undefined && input.cursor.maxLongEdge !== input.maxLongEdge) ||
        (input.observations !== undefined &&
          !isDeepStrictEqual(
            input.cursor.observations,
            pictureObservationRequestSchema.parse(input.observations),
          )) ||
        (input.faceObservations !== undefined &&
          !isDeepStrictEqual(
            input.cursor.faceObservations,
            faceObservationRequestSchema.parse(input.faceObservations),
          )))
    )
      throw new CatalogError(
        "INVALID_PARAMS",
        "Project index continuation belongs to another selection",
      );
    const status = input.cursor ? null : this.requestProject(input);
    if (status && !status.published) return { ...status, page: null };
    const metadata = input.cursor
      ? this.publishedProject(input.cursor)
      : status!.published!.evidence;
    // A ready read keeps the job identity its status reported; continuations name no job.
    return {
      ...this.projectRead(metadata).get({ cursor: input.cursor, limit: input.limit }),
      jobId: status?.jobId ?? null,
    };
  }
  coverageProject(
    input: ProjectIndexReference & {
      candidateOrdinal?: number | undefined;
      cursor?: IndexCoverageCursor<ProjectIndexReference> | undefined;
      limit?: number | undefined;
    },
  ) {
    return this.projectRead(input).coverage(input);
  }
  frameProject(input: ProjectIndexReference & { ordinal: number }) {
    return this.withIssues(this.projectRead(input).frame(input.ordinal), {
      kind: "project",
      id: input.projectId,
    });
  }
  /** A frame read from a retained index carries the issues reported with that index publication. */
  private withIssues<F extends { generation: string; published: object }>(
    frame: F,
    owner: JobOwner,
  ) {
    const publication = this.jobs.retainedArtifact(owner, artifact, frame.generation);
    return {
      ...frame,
      published: { ...frame.published, issues: publication ? this.jobs.issues(publication) : [] },
    };
  }
  openReadProject(input: ProjectIndexReference & { ordinal: number }) {
    return this.projectRead(input).openRead(input.ordinal);
  }
  private async cleanupProject(projectId: string, signal: AbortSignal) {
    const owner = { kind: "project" as const, id: projectId };
    await this.project.index.reclaim(
      owner,
      ({ generation }) => this.jobs.retainsAttempt(owner, artifact, generation),
      signal,
    );
  }
  admitProject(job: Job): ReturnType<JobAdmission> {
    if (job.target.kind !== "project" || job.artifact !== artifact)
      throw new CatalogError("UNSUPPORTED_JOB", "Index admission requires a project index");
    const input = JSON.parse(job.input) as ProjectIndexRecipe;
    if (input.implementationId !== this.project.frames.projectSupport.implementationId)
      throw new CatalogError("NOT_READY", "Pinned picture renderer is unavailable", {
        implementationId: input.implementationId,
      });
    const plan = this.projectPlan({
      ...input,
      observations: input.observationRequest,
      faceObservations: input.faceObservationRequest,
    });
    return (
      this.project.frames.projectSupport.pointers?.admit(plan.pointerSources) ?? { state: "ready" }
    );
  }
  private async executeProject({ job, signal }: JobExecution) {
    if (job.target.kind !== "project" || job.artifact !== artifact)
      throw new CatalogError("UNSUPPORTED_JOB", "Project index requires a project job");
    const input = JSON.parse(job.input) as ProjectIndexRecipe;
    const plan = this.projectPlan({
      ...input,
      observations: input.observationRequest,
      faceObservations: input.faceObservationRequest,
    });
    const { scenes, ...identity } = input;
    if (
      job.target.id !== input.projectId ||
      job.target.revisionId !== input.revisionId ||
      !isDeepStrictEqual(identity, plan.identity)
    )
      throw new CatalogError("ARTIFACT_CHANGED", "Project index recipe changed");
    await this.cleanupProject(input.projectId, signal);
    const materialize = () =>
      materializeProjectIndex(
        { ...identity, scenes, generation: job.attemptId },
        plan,
        { ...this.project, jobs: this.jobs },
        job.generation > 1 && !this.jobs.wasReadmitted(job.jobId),
        signal,
      );
    const pointers = this.project.frames.projectSupport.pointers;
    const { metadata, issues } = pointers
      ? await pointers.withReady(plan.pointerSources, materialize)
      : await materialize();
    return { result: JSON.stringify(metadata), issues };
  }
  portableProject(metadata: ScreenshotIndexMetadata<ProjectIndexRecords>) {
    const publication = this.jobs.retainedArtifact(
      { kind: "project", id: metadata.projectId },
      artifact,
      metadata.generation,
    );
    if (publication && !isDeepStrictEqual(JSON.parse(publication.result), metadata))
      throw new CatalogError(
        "INVALID_STORAGE",
        "Project screenshot publication differs from retained rows",
      );
    return publication
      ? {
          generation: publication.generation,
          attemptId: publication.attemptId,
          input: publication.input,
        }
      : null;
  }
  adoptProjectPublication(
    original: ScreenshotIndexMetadata<ProjectIndexRecords>,
    adopted: ScreenshotIndexMetadata<ProjectIndexRecords>,
    publication: Pick<RetainedArtifact, "generation" | "attemptId" | "input"> | null,
  ) {
    if (!publication) return;
    let saved: ProjectIndexRecipe;
    try {
      saved = JSON.parse(publication.input) as ProjectIndexRecipe;
    } catch {
      throw new CatalogError("INVALID_PACKAGE", "Invalid project screenshot recipe");
    }
    if (
      publication.attemptId !== original.generation ||
      !isDeepStrictEqual(saved, projectRecipe(original))
    )
      throw new CatalogError(
        "INVALID_PACKAGE",
        "Project screenshot recipe differs from retained evidence",
      );
    const scenes = original.scenes.map((metadata, index) => {
      const retained = this.project.scenes.portablePublication(metadata);
      const scene = retained
        ? (JSON.parse(retained.result) as SceneEvidenceMetadata)
        : saved.scenes[index]!;
      if (!isDeepStrictEqual(scene, metadata))
        throw new CatalogError(
          "INVALID_PACKAGE",
          "Project screenshot scene recipe differs from retained evidence",
        );
      return scene;
    });
    this.jobs.adoptArtifact(
      {
        ...publication,
        target: { kind: "project", id: adopted.projectId, revisionId: adopted.revisionId },
        input: encodeIndexRecord(projectRecipe({ ...adopted, scenes })),
        artifact,
        result: JSON.stringify(this.project.index.metadata(adopted)),
      },
      retainedProjectIndexIssues(this.project.index, adopted),
    );
  }
  portableSource(metadata: ScreenshotIndexMetadata<SourceIndexRecords>) {
    const publication = this.jobs.retainedArtifact(
      { kind: "asset", id: metadata.assetId },
      artifact,
      metadata.generation,
    );
    if (publication && !isDeepStrictEqual(JSON.parse(publication.result), metadata))
      throw new CatalogError(
        "INVALID_STORAGE",
        "Screenshot index publication differs from retained rows",
      );
    return publication
      ? {
          generation: publication.generation,
          attemptId: publication.attemptId,
          input: publication.input,
        }
      : null;
  }
  adoptSourcePublication(
    metadata: ScreenshotIndexMetadata<SourceIndexRecords>,
    publication: Pick<RetainedArtifact, "generation" | "attemptId" | "input"> | null,
  ) {
    if (!publication) return;
    let saved: SourceIndexInput;
    try {
      saved = JSON.parse(publication.input) as SourceIndexInput;
    } catch {
      throw new CatalogError("INVALID_PACKAGE", "Invalid screenshot index recipe");
    }
    const scenePublication = this.asset.scenes.portablePublication(metadata.scenes);
    const scenes = scenePublication
      ? (JSON.parse(scenePublication.result) as SceneEvidenceMetadata)
      : saved?.scenes;
    if (!isDeepStrictEqual(scenes, metadata.scenes))
      throw new CatalogError(
        "INVALID_PACKAGE",
        "Screenshot index scene recipe differs from retained evidence",
      );
    const input: SourceIndexInput = {
      assetId: metadata.assetId,
      streamId: metadata.streamId,
      ...(metadata.acquisitionId === undefined ? {} : { acquisitionId: metadata.acquisitionId }),
      scenes,
      selectionPolicy: metadata.selectionPolicy,
      implementationId: metadata.implementationId,
      maxLongEdge: metadata.maxLongEdge,
      ...(metadata.observationRequest === undefined
        ? {}
        : { observationRequest: metadata.observationRequest }),
      ...(metadata.faceObservationRequest === undefined
        ? {}
        : { faceObservationRequest: metadata.faceObservationRequest }),
    };
    if (
      publication.attemptId !== metadata.generation ||
      publication.input !== encodeIndexRecord(input)
    )
      throw new CatalogError(
        "INVALID_PACKAGE",
        "Retained screenshot index recipe differs from metadata",
      );
    // A source index publishes no issues: its frames draw no text.
    this.jobs.adoptArtifact(
      {
        ...publication,
        target: { kind: "asset", id: metadata.assetId },
        artifact,
        result: JSON.stringify(this.asset.index.metadata(metadata)),
      },
      [],
    );
  }
  private sourceRecipe(
    options: ReturnType<MediaFrameInspection["sourcePlan"]>["options"],
    scenes: SceneEvidenceMetadata,
  ): SourceIndexInput {
    return {
      ...options.selection,
      scenes,
      selectionPolicy: sourceIndexPolicy.id,
      implementationId: options.implementationId,
      maxLongEdge: options.maxLongEdge,
      ...(options.observationRequest === undefined
        ? {}
        : { observationRequest: options.observationRequest }),
      ...(options.faceObservationRequest === undefined
        ? {}
        : { faceObservationRequest: options.faceObservationRequest }),
    };
  }
  requestSource(
    selection: SourceSelection & {
      observations?: PictureObservationRequest | undefined;
      faceObservations?: FaceObservationRequest | undefined;
    },
  ) {
    const plan = this.asset.frames.sourcePlan({ ...selection, atUs: 0 });
    selection = plan.source.selection;
    const dependency = this.asset.scenes.publishedSource(selection);
    if (!dependency.published)
      return {
        ...selection,
        state: dependency.state,
        reason: dependency.reason,
        retryable: dependency.retryable,
        jobId: null,
        published: null,
        dependencies: [{ artifact: "source-scenes", ...dependency }],
      };
    const input = this.sourceRecipe(plan.options, dependency.published.evidence);
    const identity = {
      target: { kind: "asset" as const, id: input.assetId },
      artifact,
      input: encodeIndexRecord(input),
    };
    if (!this.jobs.status(identity).published)
      this.jobs.submit({ ...identity, lane: "heavy" }, (job) => {
        encodeIndexRecord({ ...input, generation: job.attemptId });
        this.jobs.retainInputs(job.jobId, "scene-generation", [
          sceneGenerationResource(input.scenes),
        ]);
        const owner = { kind: "job" as const, id: job.jobId };
        this.asset.assets.retain(owner, [input.assetId]);
        if (input.acquisitionId) this.asset.acquisitions.retain(owner, [input.acquisitionId]);
      });
    const status = this.jobs.status(identity);
    return {
      ...selection,
      ...status,
      published: status.published
        ? {
            generation: status.published.generation,
            issues: status.published.issues,
            evidence: JSON.parse(
              status.published.result,
            ) as ScreenshotIndexMetadata<SourceIndexRecords>,
          }
        : null,
      dependencies: [],
    };
  }
  retrySource(
    selection: SourceSelection & {
      observations?: PictureObservationRequest | undefined;
      faceObservations?: FaceObservationRequest | undefined;
    },
  ) {
    const status = this.requestSource(selection);
    if (status.jobId) this.jobs.retry(status.jobId);
    else if (status.retryable && !["queued", "processing", "ready"].includes(status.state))
      this.asset.scenes.retrySource(
        this.asset.frames.sourcePlan({ ...selection, atUs: 0 }).source.selection,
      );
    return this.requestSource(selection);
  }
  publishedSource(reference: SourceIndexReference) {
    const selected = this.asset.frames.sourcePlan({ ...reference, atUs: 0 }).source;
    const row = this.asset.catalog.catalog
      .prepare(
        `SELECT result FROM artifacts WHERE targetKind='asset' AND targetId=? AND artifact='screenshot-index' AND json_extract(result,'$.generation')=? LIMIT 1`,
      )
      .get(reference.assetId, reference.generation) as { result: string } | undefined;
    if (!row)
      throw new CatalogError("ARTIFACT_CHANGED", "Source screenshot index is not published");
    const metadata = JSON.parse(row.result) as ScreenshotIndexMetadata<SourceIndexRecords>;
    if (
      metadata.assetId !== selected.selection.assetId ||
      metadata.streamId !== selected.selection.streamId ||
      metadata.acquisitionId !== selected.selection.acquisitionId
    )
      throw new CatalogError(
        "ARTIFACT_CHANGED",
        "Source screenshot index belongs to another selection",
      );
    return metadata;
  }
  private sourceRead(reference: SourceIndexReference) {
    const pinned = {
      assetId: reference.assetId,
      streamId: reference.streamId,
      ...(reference.acquisitionId === undefined ? {} : { acquisitionId: reference.acquisitionId }),
      generation: reference.generation,
    };
    return new RetainedIndexRead<SourceIndexReference, SourceIndexRecords>(
      this.asset.index,
      this.publishedSource(pinned),
      pinned,
    );
  }
  getSource(
    input: SourceSelection & {
      observations?: PictureObservationRequest | undefined;
      faceObservations?: FaceObservationRequest | undefined;
      generation?: string | undefined;
      cursor?: IndexReadCursor<SourceIndexReference> | undefined;
      limit?: number;
    },
  ) {
    if (
      input.cursor &&
      (input.cursor.assetId !== input.assetId ||
        input.cursor.streamId !== input.streamId ||
        input.cursor.acquisitionId !== input.acquisitionId ||
        (input.generation !== undefined && input.cursor.generation !== input.generation))
    )
      throw new CatalogError(
        "INVALID_PARAMS",
        "Source index continuation belongs to another selection",
      );
    const status = input.cursor || input.generation ? null : this.requestSource(input);
    if (status && !status.published) return { ...status, page: null };
    const metadata = input.cursor
      ? this.publishedSource(input.cursor)
      : input.generation
        ? this.publishedSource({ ...input, generation: input.generation })
        : status!.published!.evidence;
    if (
      input.observations !== undefined &&
      !isDeepStrictEqual(
        metadata.observationRequest,
        pictureObservationRequestSchema.parse(input.observations),
      )
    )
      throw new CatalogError(
        "ARTIFACT_CHANGED",
        "Source index continuation changed its picture masks",
      );
    if (
      input.faceObservations !== undefined &&
      !isDeepStrictEqual(
        metadata.faceObservationRequest,
        faceObservationRequestSchema.parse(input.faceObservations),
      )
    )
      throw new CatalogError(
        "ARTIFACT_CHANGED",
        "Source index continuation changed its face request",
      );
    // A ready read keeps the job identity its status reported; continuations name no job.
    return {
      ...this.sourceRead(metadata).get({ cursor: input.cursor, limit: input.limit }),
      jobId: status?.jobId ?? null,
    };
  }
  coverageSource(
    input: SourceIndexReference & {
      candidateOrdinal?: number | undefined;
      cursor?: IndexCoverageCursor<SourceIndexReference> | undefined;
      limit?: number | undefined;
    },
  ) {
    return this.sourceRead(input).coverage(input);
  }
  frameSource(input: SourceIndexReference & { ordinal: number }) {
    return this.withIssues(this.sourceRead(input).frame(input.ordinal), {
      kind: "asset",
      id: input.assetId,
    });
  }
  openReadSource(input: SourceIndexReference & { ordinal: number }) {
    return this.sourceRead(input).openRead(input.ordinal);
  }
  /** Scene evidence stays pinned for unfinished recipes, including explicit retry after failure. */
  retainsSourceScenes(assetId: string, generation: string) {
    return this.jobs.retainsInput(
      "scene-generation",
      sceneGenerationResource({ owner: { kind: "asset", id: assetId }, generation }),
    );
  }
  private async cleanupAsset(assetId: string, signal: AbortSignal) {
    const owner = { kind: "asset" as const, id: assetId };
    await this.asset.index.reclaim(
      owner,
      ({ generation }) => this.jobs.retainsAttempt(owner, artifact, generation),
      signal,
    );
  }
  private async executeSource({ job, signal }: JobExecution) {
    if (job.target.kind !== "asset" || job.artifact !== artifact)
      throw new CatalogError("UNSUPPORTED_JOB", "Source index requires an asset job");
    const input = JSON.parse(job.input) as SourceIndexInput;
    if (job.target.id !== input.assetId)
      throw new CatalogError("ARTIFACT_CHANGED", "Source index recipe changed");
    const { options, source } = this.asset.frames.sourcePlan({
      ...input,
      atUs: 0,
      observations: input.observationRequest,
      faceObservations: input.faceObservationRequest,
    });
    if (!isDeepStrictEqual(input, this.sourceRecipe(options, input.scenes)))
      throw new CatalogError("ARTIFACT_CHANGED", "Source index recipe changed");
    await this.cleanupAsset(input.assetId, signal);
    return JSON.stringify(
      await materializeSourceIndex(
        { ...input, generation: job.attemptId },
        { durationUs: source.durationUs, support: source.track.available },
        this.asset,
        job.generation > 1,
        signal,
      ),
    );
  }

  async execute({ job, signal }: JobExecution): Promise<string | StagedJobResult> {
    if (job.target.kind === "asset") return this.executeSource({ job, signal });
    if (job.target.kind === "project") return this.executeProject({ job, signal });
    throw new CatalogError(
      "UNSUPPORTED_JOB",
      "Index processing requires an asset or project target",
    );
  }

  async cleanup(signal: AbortSignal): Promise<void> {
    if (this.options.project) {
      let cursor: string | undefined;
      for (;;) {
        signal.throwIfAborted();
        const page = this.project.projects.list({ ...(cursor ? { cursor } : {}), limit: 100 });
        for (const project of page.projects) await this.cleanupProject(project.id, signal);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
        await setImmediate(undefined, { signal });
      }
    }
    if (this.options.asset) {
      let cursor: string | undefined, failure: unknown;
      for (;;) {
        signal.throwIfAborted();
        const page = this.asset.assets.list({ ...(cursor ? { cursor } : {}), limit: 100 });
        for (const asset of page.assets) {
          try {
            await this.cleanupAsset(asset.id, signal);
          } catch (error) {
            signal.throwIfAborted();
            failure ??= error;
          }
        }
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
        await setImmediate(undefined, { signal });
      }
      if (failure) throw failure;
    }
  }
}
