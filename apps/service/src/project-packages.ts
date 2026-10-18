import { portableProjectSpeakers, type PortableSpeakerCheckpoint } from "./portable-speakers.js";
import { publishedOutput } from "@yap/protocol";
import { omit } from "@yap/composition";
import type { ProjectSpeakerInput, ProjectEvidenceCursor } from "@yap/core/project-evidence";
import { randomUUID } from "node:crypto";
import { resolveProjectPackageMetadata } from "./project-package-metadata.js";
import { sourceExporter } from "./source-export.js";
import { preparedAudioResource, type PreparedAudioStore } from "@yap/core/prepared-audio";
import { acquisitionContext } from "@yap/core/acquisitions";
import { indexGenerationResource } from "@yap/core/screenshot-index";
import { portableIndexRecords } from "./portable-index.js";
import { projectCompositionFromRevision } from "@yap/core/project-window";
import {
  projectIndexDomain,
  portableProjectIndexMetadataSchema,
  portableProjectIndexRecordSchema,
  type ProjectIndexRecords,
} from "@yap/core/project-index";
import { selectSourceMetadata } from "@yap/core/source-selection";
import {
  sourceIndexDomain,
  portableSourceIndexMetadataSchema,
  portableSourceIndexRecordSchema,
  type SourceIndexRecords,
} from "@yap/core/source-index";
import type { ScreenshotIndexStore, IndexRecords } from "@yap/core/screenshot-index";
import type { IndexProcessing } from "@yap/core/index-processing";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { fstatSync, readFileSync, constants } from "node:fs";
import { mkdir, open, writeFile, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CatalogError } from "@yap/core/catalog";
import { copyImportedFile, fileIdentity, type IdentifiedFile } from "@yap/core/files";
import { archiveLimits, checkProjectJsonBytes } from "@yap/core/package-archive";
import {
  collectPortableResources,
  projectResourceRoots,
  resourceMembers,
  resourceIdentity,
  sceneMemberPath,
  transcriptMemberPath,
  importedTranscriptMemberPath,
  indexMemberPath,
  type PortableDependency,
  type PortableResource,
  projectPackageManifest,
  parseProjectPackageManifest,
  resourceMetadataMember,
  type ProjectPackageManifest,
  staleTranscriptIssues,
  validateProjectPackage,
  type ValidatedProjectPackage,
} from "@yap/core/project-package";
import {
  type ImportedTranscriptStore,
  type PortableImportedTranscript,
} from "@yap/core/imported-transcript";
import type { ProjectStore, ProjectSnapshot } from "@yap/core/projects";
import type { AssetStore } from "@yap/core/assets";
import type {
  AcquisitionImporter,
  AcquisitionMember,
  PortableAcquisitionFiles,
} from "@yap/core/acquisitions";
import {
  sceneGenerationResource,
  type PortableSceneMetadata,
  type SceneEvidenceStore,
} from "@yap/core/scene-evidence";
import type { SceneProcessing } from "@yap/core/scene-processing";
import {
  assetSpeakerOwner,
  speakerOperandRecords,
  type SpeakerEvidenceStore,
} from "@yap/core/speaker-evidence";
import type { SpeakerProcessing } from "@yap/core/speaker-processing";
import {
  assetAlignmentOwner,
  alignmentGenerationResource,
  alignmentOperandRecords,
  type AlignmentEvidenceStore,
} from "@yap/core/alignment-evidence";
import type { AlignmentProcessing } from "@yap/core/alignment-processing";
import { SourceAlignmentRead, type AlignmentReadInput } from "@yap/core/alignment-read";
import { SourceSpeakerRead } from "@yap/core/speaker-read";
import type { SpeakerLabelStore } from "@yap/core/speaker-labels";
import { selectSpeakerSource } from "@yap/core/source-speakers";
import {
  portableTranscript,
  transcriptGenerationResource,
  type PortableTranscript,
  type TranscriptStore,
} from "@yap/core/transcript";
import type { ResourceReference } from "@yap/core/references";
import type { TranscriptProcessing } from "@yap/core/transcript-processing";
import type { ContextJob, JobQueue } from "@yap/core/jobs";
import { PackageRegistry } from "./package-registry.js";
import { openPackageParent } from "./package-workspace.js";
import { writeArchive } from "./archive-write.js";
import type { MediaWorker } from "./worker.js";
import type { DerivativeDelivery } from "./delivery.js";

export type PinnedProjectPackage = {
  revisionId: string;
  snapshot: ProjectSnapshot;
  resources: PortableDependency[];
  acquisitionFiles: Record<string, ReturnType<AcquisitionImporter["portable"]>["files"]>;
  transcriptFiles: Record<string, IdentifiedFile>;
  importedTranscriptFiles: Record<string, IdentifiedFile>;
  /** Stale derived transcripts the package leaves out; the recipient regenerates them on request. */
  stale: ResourceReference[];
};
type Workspace = { directory: string; handle: FileHandle };
/** Package context work returns only a result, so it has no channel to report issues on. */
const contextPublication = (job: ContextJob) => ({ ...job, issues: [] });
type Owners = {
  directory: string;
  projects: ProjectStore;
  preparedAudio: PreparedAudioStore;
  assets: AssetStore;
  acquisitions: AcquisitionImporter;
  sceneRecords: SceneEvidenceStore;
  scenes: SceneProcessing;
  speakerRecords: SpeakerEvidenceStore;
  speakerLabels: SpeakerLabelStore;
  speakers: SpeakerProcessing;
  alignmentRecords: AlignmentEvidenceStore;
  alignments: AlignmentProcessing;
  transcriptRecords: TranscriptStore;
  importedTranscripts: ImportedTranscriptStore;
  transcripts: TranscriptProcessing;
  indexRecords: ScreenshotIndexStore<SourceIndexRecords>;
  indexes: IndexProcessing;
  jobs: JobQueue;
  worker: MediaWorker;
  delivery: DerivativeDelivery;
  projectIndexRecords: ScreenshotIndexStore<ProjectIndexRecords>;
};

/** Archive lifetimes remain in the registry; durable adoption remains in the project and asset owners. */
export class ProjectPackages {
  private progress: (() => void) | undefined;
  set onUpdateProgress(callback: (() => void) | undefined) {
    this.progress = callback;
    if (this.registry) this.registry.onUpdateProgress = callback;
  }
  get updateBlocked(): boolean {
    return !!this.preparing || !!this.registry?.updateBlocked;
  }
  private parent: Awaited<ReturnType<typeof openPackageParent>> | undefined;
  private registry: PackageRegistry<ValidatedProjectPackage, ProjectPackageManifest> | undefined;
  private readonly openRequests = new Map<
    string,
    {
      path: string;
      result: ReturnType<PackageRegistry<ValidatedProjectPackage, ProjectPackageManifest>["open"]>;
    }
  >();
  private preparing: Promise<void> | undefined;
  private closed = false;
  constructor(private readonly owners: Owners) {}
  private async prepare() {
    if (this.closed) throw new CatalogError("OWNER_CLOSED", "Project packages are closed");
    if (this.preparing) return this.preparing;
    if (this.registry) return;
    this.preparing = (async () => {
      const parent = await openPackageParent(join(this.owners.directory, "packages"));
      const registry = new PackageRegistry<ValidatedProjectPackage, ProjectPackageManifest>({
        parent,
        jobs: this.owners.jobs,
        worker: this.owners.worker,
        delivery: this.owners.delivery,
        inlineRevisions: false,
        validate: parseProjectPackageManifest,
        resolve: resolveProjectPackageMetadata,
        inspect: async (context, signal = new AbortController().signal, lifetime) => {
          for (const entry of context.manifest.resources) {
            if (entry.kind !== "acquisition") continue;
            const leases: ReturnType<typeof context.files.open>[] = [];
            try {
              const assetFiles = new Map<string, IdentifiedFile>();
              for (const binding of entry.acquisition.bindings) {
                const asset = context.manifest.resources.find(
                  (resource) => resource.kind === "asset" && resource.asset.id === binding.assetId,
                );
                if (!asset || asset.kind !== "asset")
                  throw new CatalogError("INVALID_PACKAGE", "Missing canonical asset");
                const member = `assets/${asset.asset.fileName}`,
                  lease = context.files.open(member);
                leases.push(lease);
                const stat = fstatSync(lease.fd, { bigint: true });
                assetFiles.set(binding.assetId, {
                  path: context.files.path(member),
                  bytes: Number(stat.size),
                  identity: fileIdentity(stat),
                });
              }
              const files = Object.fromEntries(
                resourceMembers(entry).map((member, index) => {
                  const lease = context.files.open(member.path);
                  leases.push(lease);
                  const stat = fstatSync(lease.fd, { bigint: true });
                  return [
                    index === 0
                      ? "journal"
                      : index === 1
                        ? "normalized"
                        : member.path.split("/").at(-1)!,
                    {
                      path: context.files.path(member.path),
                      bytes: Number(stat.size),
                      identity: fileIdentity(stat),
                      sha256: context.manifest.inventory.find(
                        (value) => value.path === member.path,
                      )!.sha256,
                    },
                  ];
                }),
              ) as PortableAcquisitionFiles;
              await this.owners.acquisitions.verifyPortable(entry.acquisition, files, signal, {
                exportSource: sourceExporter(this.owners.worker, lifetime),
                assetFiles,
                assets: new Map(
                  context.manifest.resources.flatMap((value) =>
                    value.kind === "asset" ? [[value.asset.id, value.asset] as const] : [],
                  ),
                ),
              });
            } finally {
              for (const lease of leases) lease.close();
            }
          }
        },
      });
      try {
        await registry.recover();
        this.parent = parent;
        this.registry = registry;
        registry.onUpdateProgress = this.progress;
      } catch (error) {
        await parent.handle.close();
        throw error;
      }
    })().finally(() => {
      this.preparing = undefined;
      this.progress?.();
    });
    return this.preparing;
  }
  async open(path: string, requestId?: string) {
    const prior = requestId ? this.openRequests.get(requestId) : undefined;
    if (prior) {
      if (prior.path !== path)
        throw new CatalogError(
          "REQUEST_CONFLICT",
          "Request identity names a different package path",
        );
      return prior.result;
    }
    await this.prepare();
    const result = this.registry!.open(path);
    if (requestId) this.openRequests.set(requestId, { path, result });
    return result;
  }
  projectSpeakers(packageHandle: string, input: ProjectSpeakerInput) {
    if (!this.registry) throw new CatalogError("CONTEXT_CLOSED", "Project package is not open");
    const cursor = input.cursor as ProjectEvidenceCursor | undefined;
    let previous: PortableSpeakerCheckpoint | undefined;
    if (cursor) {
      const checkpoint = this.registry.job(packageHandle, cursor.checkpointId);
      if (
        checkpoint.artifact !== "package.speakers" ||
        checkpoint.state !== "ready" ||
        !checkpoint.result
      )
        throw new CatalogError("ARTIFACT_CHANGED", "Package speaker checkpoint is unavailable");
      previous = JSON.parse(checkpoint.result) as PortableSpeakerCheckpoint;
      const query = previous.manifest.query;
      if (
        previous.packageHandle !== packageHandle ||
        cursor.queryDigest !== previous.state.queryDigest ||
        cursor.manifestId !== previous.state.manifestId ||
        input.projectId !== query.projectId ||
        input.channel !== query.channel ||
        input.modelId !== query.modelId ||
        (input.revisionId !== undefined && input.revisionId !== query.revisionId) ||
        (input.range !== undefined && !isDeepStrictEqual(input.range, query.range)) ||
        (input.trackIds !== undefined &&
          !isDeepStrictEqual([...new Set(input.trackIds)].sort(), query.trackIds))
      )
        throw new CatalogError("ARTIFACT_CHANGED", "Package speaker query changed");
    }
    const engine = this.owners.speakers.engine(input.modelId),
      manifestId = cursor?.manifestId ?? randomUUID();
    const job = this.registry.submit(
      packageHandle,
      { artifact: "package.speakers", lane: "frame", input: JSON.stringify(input) },
      async (context, signal, { job }) => {
        signal.throwIfAborted();
        const result = portableProjectSpeakers(
          context,
          packageHandle,
          input,
          engine,
          job.jobId,
          manifestId,
          previous,
        );
        signal.throwIfAborted();
        return JSON.stringify(result);
      },
    );
    if (job.state !== "ready" || !job.result) {
      const { input: recipe, result: serialized, ...summary } = job;
      return {
        projectId: input.projectId,
        revisionId:
          input.revisionId ??
          cursor?.revisionId ??
          this.registry.lookup(packageHandle).manifest.snapshot.project.currentRevisionId,
        ...summary,
        inputSha256: createHash("sha256").update(recipe).digest("hex"),
        published: serialized
          ? publishedOutput(contextPublication(job), () => JSON.parse(serialized) as unknown)
          : null,
        page: null,
      };
    }
    const result = JSON.parse(job.result) as PortableSpeakerCheckpoint;
    return {
      projectId: result.manifest.query.projectId,
      revisionId: result.manifest.query.revisionId,
      state: "ready",
      issues: result.issues,
      dependencies: cursor ? { manifestId: result.state.manifestId } : result.manifest.dependencies,
      coverage: {
        manifestId: result.state.manifestId,
        ...(cursor ? {} : { occurrences: result.manifest.coverage }),
      },
      page: { rows: result.rows, nextCursor: result.nextCursor },
    };
  }
  sourceSpeakers(
    packageHandle: string,
    input: import("@yap/core/source-speakers").SpeakerSourceInput,
    query: import("@yap/core/speaker-read").SpeakerReadInput,
  ) {
    if (!this.registry) throw new CatalogError("CONTEXT_CLOSED", "Project package is not open");
    const { manifest, files } = this.registry.lookup(packageHandle);
    const assets = new Map(
      manifest.resources.flatMap((resource) =>
        resource.kind === "asset" ? [[resource.asset.id, resource.asset] as const] : [],
      ),
    );
    const acquisitions = new Map(
      manifest.resources.flatMap((resource) =>
        resource.kind === "acquisition"
          ? [[resource.acquisition.id, resource.acquisition] as const]
          : [],
      ),
    );
    const selected = selectSpeakerSource(
      {
        get: (id) => {
          const asset = assets.get(id);
          if (!asset) throw new CatalogError("NOT_FOUND", "Package source asset does not exist");
          return asset;
        },
        path: (id) => files.path(`assets/${assets.get(id)!.fileName}`),
      },
      {
        get: (id) => {
          const acquisition = acquisitions.get(id);
          if (!acquisition)
            throw new CatalogError("NOT_FOUND", "Package acquisition does not exist");
          return acquisition;
        },
      },
      input,
    );
    const engine = this.owners.speakers.engine(input.modelId);
    const resource = manifest.resources
      .filter(
        (resource): resource is Extract<PortableResource, { kind: "speaker-generation" }> =>
          resource.kind === "speaker-generation" &&
          resource.metadata.owner.assetId === input.assetId &&
          resource.metadata.source.streamId === input.streamId &&
          resource.metadata.source.acquisitionId === (input.acquisitionId ?? null) &&
          resource.metadata.source.channel === input.channel &&
          resource.metadata.source.supportDigest === selected.supportDigest &&
          isDeepStrictEqual(resource.metadata.source.engine, engine) &&
          isDeepStrictEqual(resource.metadata.source.observationRange, input.sourceRange),
      )
      .toSorted((a, b) => b.sequence - a.sequence)[0];
    if (!resource) {
      if (query.cursor)
        throw new CatalogError("ARTIFACT_CHANGED", "Package speaker observation changed");
      return { ...input, state: "unavailable", reason: "source_evidence_unobserved", page: null };
    }
    const page = new SourceSpeakerRead(
      speakerOperandRecords(resource.metadata, resource),
      resource.metadata,
      packageHandle,
    ).page(query);
    const labels = new Map(resource.bindings.map((binding) => [binding.slot, binding.displayName]));
    const labeledPage =
      query.view === "scores"
        ? page
        : {
            ...page,
            rows: page.rows.map((row) =>
              "slot" in row && labels.has(row.slot)
                ? { ...row, label: labels.get(row.slot)! }
                : row,
            ),
          };
    // The ready answer has the live path's shape, which carries no observation range.
    const selection: Partial<typeof input> = { ...input };
    delete selection.sourceRange;
    return {
      ...selection,
      state: "ready",
      generation: resource.metadata.generation,
      page: labeledPage,
    };
  }
  sourceAlignment(
    packageHandle: string,
    assetId: string,
    generation: string,
    query: AlignmentReadInput,
  ) {
    if (!this.registry) throw new CatalogError("CONTEXT_CLOSED", "Project package is not open");
    const { manifest } = this.registry.lookup(packageHandle);
    const resource = manifest.resources.find(
      (value): value is Extract<PortableResource, { kind: "alignment-generation" }> =>
        value.kind === "alignment-generation" &&
        value.metadata.owner.assetId === assetId &&
        value.metadata.generation === generation,
    );
    if (!resource) throw new CatalogError("NOT_READY", "Alignment evidence is not ready", {});
    return {
      assetId,
      state: "ready",
      generation,
      page: new SourceAlignmentRead(
        alignmentOperandRecords(resource.metadata, resource),
        resource.metadata,
        packageHandle,
      ).page(query),
    };
  }
  status(admissionId?: string) {
    if (admissionId) {
      if (!this.registry) throw new CatalogError("NOT_FOUND", "Package admission does not exist");
      const admission = this.registry.status(admissionId);
      if (admission.state !== "ready" || !admission.packageHandle) return admission;
      const manifest = this.registry.lookup(admission.packageHandle).manifest;
      return {
        ...admission,
        project: manifest.snapshot.project,
        revisions: manifest.snapshot.revisions.length,
        assets: manifest.resources.filter((resource) => resource.kind === "asset").length,
        acquisitions: manifest.resources.filter((resource) => resource.kind === "acquisition")
          .length,
        issues: staleTranscriptIssues(manifest.stale),
      };
    }
    return { usage: this.registry?.usage() ?? null, admissions: this.registry?.active() ?? [] };
  }
  async closeAdmission(admissionId: string) {
    if (!this.registry) throw new CatalogError("NOT_FOUND", "Package admission does not exist");
    await this.registry.close(admissionId);
    return this.registry.status(admissionId);
  }
  async close() {
    this.closed = true;
    await this.preparing;
    await this.registry?.dispose();
    await this.parent?.handle.close();
  }
  exportDirectory() {
    return openPackageParent(join(this.owners.directory, "package-exports"));
  }
  private *sceneChunks(metadata: PortableSceneMetadata): Generator<string> {
    let afterStartUs: number | undefined;
    do {
      const page = this.owners.sceneRecords.sourcePage({
        identity: metadata,
        ...(afterStartUs === undefined ? {} : { afterStartUs }),
        limit: 1,
      });
      for (const chunk of page.chunks) yield JSON.stringify(chunk);
      if (page.nextStartUs === null) return;
      afterStartUs = page.nextStartUs;
    } while (true);
  }
  pin(projectId: string, revisionId?: string): PinnedProjectPackage {
    const snapshot = this.owners.projects.snapshot(projectId, revisionId);
    let jsonBytes = snapshot.revisions.reduce(
        (sum, revision) => sum + Buffer.byteLength(JSON.stringify(revision)),
        0,
      ),
      members = snapshot.revisions.length;
    const acquisitionFiles: PinnedProjectPackage["acquisitionFiles"] = {};
    const transcriptFiles: PinnedProjectPackage["transcriptFiles"] = {};
    const importedTranscriptFiles: PinnedProjectPackage["importedTranscriptFiles"] = {};
    const transcriptInventory = new Map<
      string,
      Extract<PortableDependency, { kind: "transcript-generation" }>
    >();
    const importedTranscriptInventory = new Map<
      string,
      Extract<PortableDependency, { kind: "imported-transcript-generation" }>
    >();
    const importedTranscriptsForAsset = (assetId: string) =>
      this.owners.importedTranscripts.portableGenerations(assetId).map((value) => {
        const resource = { kind: "imported-transcript-generation" as const, ...value } as Extract<
          PortableDependency,
          { kind: "imported-transcript-generation" }
        >;
        const identity = resourceIdentity(resource);
        if (!importedTranscriptInventory.has(identity.id)) {
          importedTranscriptFiles[identity.id] =
            this.owners.importedTranscripts.portableFile(value);
          importedTranscriptInventory.set(identity.id, resource);
        }
        return identity;
      });
    const sceneInventory = new Map<
      string,
      Extract<PortableDependency, { kind: "scene-generation" }>
    >();
    const scenesForAsset = (assetId: string) => {
      return this.owners.sceneRecords.portableGenerations(assetId).map((metadata) => {
        if (metadata.chunkCount > archiveLimits.entries - 1)
          throw new CatalogError("LIMIT_EXCEEDED", "Scene chunks exceed archive inventory budget");
        const scene: Extract<PortableDependency, { kind: "scene-generation" }> = {
          kind: "scene-generation",
          metadata,
          publication: this.owners.scenes.portablePublication(metadata),
        };
        if (!sceneInventory.has(resourceIdentity(scene).id)) {
          members += metadata.chunkCount;
          if (members >= archiveLimits.entries)
            throw new CatalogError(
              "LIMIT_EXCEEDED",
              "Scene inventory exceeds archive metadata budget",
            );
        }
        const identity = resourceIdentity(scene);
        sceneInventory.set(identity.id, scene);
        return identity;
      });
    };
    const staleTranscripts = new Map<string, ResourceReference>();
    const addTranscript = (metadata: PortableTranscript) => {
      const resource: Extract<PortableDependency, { kind: "transcript-generation" }> = {
        kind: "transcript-generation",
        metadata,
        ...this.owners.transcripts.portable(metadata),
      };
      const identity = resourceIdentity(resource);
      if (!transcriptInventory.has(identity.id)) {
        members += 2;
        if (members >= archiveLimits.entries)
          throw new CatalogError("LIMIT_EXCEEDED", "Transcript inventory exceeds archive budget");
        transcriptFiles[identity.id] = this.owners.transcriptRecords.portableFile(metadata);
        transcriptInventory.set(identity.id, resource);
      }
      return identity;
    };
    const transcriptsForAsset = (assetId: string) => {
      const { generations, stale } = this.owners.transcriptRecords.portableGenerations(assetId);
      for (const generation of stale) {
        const id = transcriptGenerationResource({ owner: { kind: "asset", assetId }, generation });
        staleTranscripts.set(id, { kind: "transcript-generation", id });
      }
      return generations.map(addTranscript);
    };
    const indexInventory = new Map<
      string,
      Extract<PortableDependency, { kind: "index-generation" | "project-index-generation" }>
    >();
    const speakerInventory = new Map<
      string,
      Extract<PortableDependency, { kind: "speaker-generation" }>
    >();
    const speakersForAsset = (assetId: string) =>
      this.owners.speakerRecords.portableGenerations(assetId).map(({ metadata, sequence }) => {
        const resource: Extract<PortableDependency, { kind: "speaker-generation" }> = {
          kind: "speaker-generation",
          metadata,
          sequence,
          publication: this.owners.speakers.portablePublication(metadata),
          bindings: this.owners.speakerLabels.read(metadata),
          ...this.owners.speakerRecords.operands(metadata),
        };
        const identity = resourceIdentity(resource);
        speakerInventory.set(identity.id, resource);
        return identity;
      });
    const alignmentInventory = new Map<
      string,
      Extract<PortableDependency, { kind: "alignment-generation" }>
    >();
    let alignmentInventoryBytes = 0;
    const alignmentsForAsset = (assetId: string) => {
      const identities: import("@yap/core/references").ResourceReference[] = [];
      for (const { metadata, sequence } of this.owners.alignmentRecords.portableGenerations(
        assetId,
      )) {
        const identity = {
          kind: "alignment-generation" as const,
          id: alignmentGenerationResource(metadata),
        };
        identities.push(identity);
        if (alignmentInventory.has(identity.id)) continue;
        const resource: Extract<PortableDependency, { kind: "alignment-generation" }> = {
          kind: "alignment-generation",
          metadata,
          sequence,
          publication: this.owners.alignments.portablePublication(metadata),
          ...this.owners.alignmentRecords.operands(metadata),
        };
        alignmentInventoryBytes += Buffer.byteLength(JSON.stringify(resource));
        checkProjectJsonBytes(alignmentInventoryBytes);
        alignmentInventory.set(identity.id, resource);
      }
      return identities;
    };
    const indexesForAsset = (assetId: string) =>
      this.owners.indexRecords.portableGenerations({ kind: "asset", assetId }).map((metadata) => {
        const resource: Extract<PortableDependency, { kind: "index-generation" }> = {
          kind: "index-generation",
          metadata: portableSourceIndexMetadataSchema.parse(metadata),
          publication: this.owners.indexes.portableSource(metadata),
        };
        const identity = resourceIdentity(resource);
        if (!indexInventory.has(identity.id)) {
          const entries = metadata.candidateCount * 2 + metadata.coverageCount;
          members += entries;
          if (members >= archiveLimits.entries)
            throw new CatalogError(
              "LIMIT_EXCEEDED",
              "Screenshot index inventory exceeds archive budget",
            );
          indexInventory.set(identity.id, resource);
        }
        return identity;
      });
    for (const metadata of this.owners.projectIndexRecords.portableGenerations(
      { kind: "project", projectId },
      undefined,
      snapshot.project.currentRevisionId === this.owners.projects.get(projectId).currentRevisionId
        ? undefined
        : snapshot.revisions.map((revision) => revision.id),
    )) {
      const resource: Extract<PortableDependency, { kind: "project-index-generation" }> = {
        kind: "project-index-generation",
        metadata: portableProjectIndexMetadataSchema.parse(metadata),
        publication: this.owners.indexes.portableProject(metadata),
      };
      const identity = resourceIdentity(resource);
      const reference = snapshot.references.find(
        (value) => value.revisionId === metadata.revisionId,
      );
      if (!reference)
        throw new CatalogError(
          "INVALID_STORAGE",
          "Project index revision is outside retained history",
        );
      if (
        !reference.resources.some(
          (value) => value.kind === identity.kind && value.id === identity.id,
        )
      )
        reference.resources.push(identity);
      const entries = metadata.candidateCount * 2 + metadata.coverageCount;
      members += entries;
      if (members >= archiveLimits.entries)
        throw new CatalogError(
          "LIMIT_EXCEEDED",
          "Screenshot index inventory exceeds archive budget",
        );
      indexInventory.set(identity.id, resource);
    }
    const resources = collectPortableResources(projectResourceRoots(snapshot), (identity) => {
      let resource: PortableDependency;
      if (identity.kind === "asset") {
        const asset = this.owners.assets.portable(identity.id);
        const dependencies = [
          ...asset.dependencies,
          ...scenesForAsset(identity.id),
          ...transcriptsForAsset(identity.id),
          ...importedTranscriptsForAsset(identity.id),
          ...indexesForAsset(identity.id),
          ...speakersForAsset(identity.id),
          ...alignmentsForAsset(identity.id),
        ];
        resource = {
          kind: "asset",
          ...asset,
          dependencies: [
            ...new Map(dependencies.map((entry) => [`${entry.kind}:${entry.id}`, entry])).values(),
          ],
        };
      } else if (identity.kind === "prepared-audio") {
        resource = { kind: "prepared-audio", ...this.owners.preparedAudio.portable(identity.id) };
      } else if (identity.kind === "acquisition") {
        const pinned = this.owners.acquisitions.portable(identity.id);
        acquisitionFiles[identity.id] = pinned.files;
        resource = { kind: "acquisition", acquisition: pinned.acquisition };
      } else {
        if (
          ![
            "scene-generation",
            "transcript-generation",
            "index-generation",
            "speaker-generation",
            "alignment-generation",
            "imported-transcript-generation",
          ].includes(identity.kind)
        )
          throw new CatalogError(
            "UNSUPPORTED_PACKAGE_DEPENDENCY",
            `Portable adoption is not implemented for ${identity.kind}`,
          );
        const inventory =
          identity.kind === "alignment-generation"
            ? alignmentInventory
            : identity.kind === "speaker-generation"
              ? speakerInventory
              : identity.kind === "scene-generation"
                ? sceneInventory
                : identity.kind === "transcript-generation"
                  ? transcriptInventory
                  : identity.kind === "imported-transcript-generation"
                    ? importedTranscriptInventory
                    : indexInventory;
        if (!inventory.has(identity.id)) {
          let tuple: unknown;
          try {
            tuple = JSON.parse(identity.id);
          } catch {
            throw new CatalogError("INVALID_STORAGE", "Invalid retained-generation identity");
          }
          if (identity.kind === "imported-transcript-generation") {
            if (!tuple || typeof tuple !== "object" || !("source" in tuple))
              throw new CatalogError("INVALID_STORAGE", "Invalid imported transcript identity");
            const source = (tuple as { source?: { assetId?: unknown } }).source;
            if (!source || typeof source.assetId !== "string")
              throw new CatalogError("INVALID_STORAGE", "Invalid imported transcript identity");
            importedTranscriptsForAsset(source.assetId);
          } else if (
            !Array.isArray(tuple) ||
            tuple.length !== 3 ||
            tuple[0] !== "asset" ||
            typeof tuple[1] !== "string" ||
            typeof tuple[2] !== "string"
          )
            throw new CatalogError("INVALID_STORAGE", "Invalid retained-generation identity");
          if (identity.kind !== "imported-transcript-generation") {
            const retained = tuple as [string, string, string];
            if (identity.kind === "alignment-generation") alignmentsForAsset(retained[1]);
            else if (identity.kind === "speaker-generation") speakersForAsset(retained[1]);
            else if (identity.kind === "scene-generation") scenesForAsset(retained[1]);
            else if (identity.kind === "transcript-generation") {
              transcriptsForAsset(retained[1]);
              // A stale transcript a revision pins travels as historical evidence.
              if (!transcriptInventory.has(identity.id) && staleTranscripts.has(identity.id))
                addTranscript(
                  portableTranscript(
                    this.owners.transcriptRecords.retainedGeneration(
                      { owner: { kind: "asset", assetId: retained[1] }, generation: retained[2] },
                      { historical: true },
                    ),
                  ),
                );
            } else indexesForAsset(retained[1]);
          }
        }
        const scene = inventory.get(identity.id);
        if (!scene)
          throw new CatalogError(
            "INVALID_STORAGE",
            "Retained generation reference has no owned data",
          );
        resource = scene;
      }
      if (
        resource.kind === "asset" ||
        resource.kind === "acquisition" ||
        resource.kind === "prepared-audio"
      ) {
        members += resourceMembers(resource).length;
      }
      jsonBytes += Buffer.byteLength(JSON.stringify(resource));
      checkProjectJsonBytes(jsonBytes);
      members++;
      if (members >= archiveLimits.entries)
        throw new CatalogError(
          "LIMIT_EXCEEDED",
          "Project resources exceed package inventory budget",
        );
      return resource;
    });
    return {
      revisionId: snapshot.project.currentRevisionId,
      snapshot,
      resources,
      acquisitionFiles,
      transcriptFiles,
      importedTranscriptFiles,
      stale: [...staleTranscripts.values()].filter(({ id }) => !transcriptInventory.has(id)),
    };
  }
  checkPinned(pinned: PinnedProjectPackage): void {
    for (const resource of pinned.resources) {
      if (resource.kind === "prepared-audio")
        this.owners.preparedAudio.portable(resourceIdentity(resource).id);
      if (resource.kind === "speaker-generation")
        this.owners.speakerRecords.operands(resource.metadata);
      if (resource.kind === "alignment-generation")
        this.owners.alignmentRecords.operands(resource.metadata);
      if (resource.kind === "scene-generation")
        this.owners.sceneRecords.sourcePage({ identity: resource.metadata, limit: 1 });
      if (resource.kind === "transcript-generation")
        this.owners.transcriptRecords.portableFile(resource.metadata);
      if (resource.kind === "imported-transcript-generation")
        this.owners.importedTranscripts.portableFile(resource);
      if (resource.kind === "index-generation")
        this.owners.indexRecords.metadata(resource.metadata);
      if (resource.kind === "project-index-generation")
        this.owners.projectIndexRecords.metadata(resource.metadata);
    }
  }
  adopt(packageHandle: string, requestId: string) {
    if (!this.registry) throw new CatalogError("CONTEXT_CLOSED", "Project package is not open");
    const job = this.registry.submit(
      packageHandle,
      { artifact: "package.adopt", lane: "heavy", input: JSON.stringify({ requestId }) },
      async (context, signal, { lifetime }) => {
        const manifest = context.manifest;
        const adoption = this.owners.projects.prepareAdoption({
          requestId,
          packageIdentity: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
          snapshot: manifest.snapshot,
        });
        const preparedAudio: Awaited<ReturnType<PreparedAudioStore["stagePortable"]>>[] = [];
        const mappedResources = new Map(
          manifest.resources.flatMap((resource) => {
            if (resource.kind === "prepared-audio")
              return [
                [
                  resourceIdentity(resource).id,
                  preparedAudioResource(adoption.project.projectId, resource.publication.attemptId),
                ] as const,
              ];
            if (resource.kind === "project-index-generation")
              return [
                [
                  resourceIdentity(resource).id,
                  indexGenerationResource(
                    { kind: "project", projectId: adoption.project.projectId },
                    resource.metadata.generation,
                  ),
                ] as const,
              ];
            return [];
          }),
        );
        const reference = (value: import("@yap/core/references").ResourceReference) =>
          (value.kind === "prepared-audio" || value.kind === "index-generation") &&
          mappedResources.has(value.id)
            ? { ...value, id: mappedResources.get(value.id)! }
            : value;
        const staged: Awaited<ReturnType<AssetStore["stagePortable"]>>[] = [];
        const assetPaths = new Map<string, string>();
        const transcripts: {
          stage: Awaited<ReturnType<TranscriptStore["stagePortable"]>>;
          resource: Extract<PortableResource, { kind: "transcript-generation" }>;
        }[] = [];
        const projectIndexes: {
          stage: Awaited<ReturnType<ScreenshotIndexStore<ProjectIndexRecords>["stagePortable"]>>;
          resource: Extract<PortableResource, { kind: "project-index-generation" }>;
        }[] = [];
        const indexes: {
          stage: Awaited<ReturnType<ScreenshotIndexStore<SourceIndexRecords>["stagePortable"]>>;
          resource: Extract<PortableResource, { kind: "index-generation" }>;
        }[] = [];
        const acquisitions: Awaited<ReturnType<AcquisitionImporter["stagePortable"]>>[] = [];
        const speakers: {
          stage: ReturnType<SpeakerEvidenceStore["stagePortable"]>;
          resource: Extract<PortableResource, { kind: "speaker-generation" }>;
        }[] = [];
        const alignments: {
          stage: ReturnType<AlignmentEvidenceStore["stagePortable"]>;
          resource: Extract<PortableResource, { kind: "alignment-generation" }>;
        }[] = [];
        const scenes: {
          stage: Awaited<ReturnType<SceneEvidenceStore["stagePortable"]>>;
          resource: Extract<PortableResource, { kind: "scene-generation" }>;
        }[] = [];
        try {
          for (const entry of manifest.resources.filter((entry) => entry.kind === "asset")) {
            signal.throwIfAborted();
            const path = `assets/${entry.asset.fileName}`,
              source = context.files.open(path);
            try {
              const stat = fstatSync(source.fd, { bigint: true });
              const locator = context.files.path(path);
              staged.push(
                await this.owners.assets.stagePortable(
                  { asset: entry.asset, origins: entry.origins, dependencies: entry.dependencies },
                  locator,
                  signal,
                  {
                    path: locator,
                    bytes: Number(stat.size),
                    identity: fileIdentity(stat),
                  },
                ),
              );
              assetPaths.set(entry.asset.id, staged.at(-1)!.path);
            } finally {
              source.close();
            }
          }
          for (const entry of manifest.resources) {
            if (entry.kind !== "acquisition") continue;
            const members = resourceMembers(entry);
            const leases: ReturnType<typeof context.files.open>[] = [];
            try {
              for (const member of members) leases.push(context.files.open(member.path));
              const files = Object.fromEntries(
                members.map((member, index) => {
                  const stat = fstatSync(leases[index]!.fd, { bigint: true });
                  return [
                    index === 0
                      ? "journal"
                      : index === 1
                        ? "normalized"
                        : (member.path.split("/").at(-1)! as AcquisitionMember),
                    {
                      path: context.files.path(member.path),
                      bytes: Number(stat.size),
                      identity: fileIdentity(stat),
                      sha256: manifest.inventory.find((item) => item.path === member.path)!.sha256,
                    },
                  ];
                }),
              ) as PortableAcquisitionFiles;
              const assetFiles = new Map<string, IdentifiedFile>();
              for (const binding of entry.acquisition.bindings) {
                const path = assetPaths.get(binding.assetId)!;
                const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
                try {
                  const stat = await file.stat({ bigint: true });
                  assetFiles.set(binding.assetId, {
                    path,
                    bytes: Number(stat.size),
                    identity: fileIdentity(stat),
                  });
                } finally {
                  await file.close();
                }
              }
              acquisitions.push(
                await this.owners.acquisitions.stagePortable(entry.acquisition, files, signal, {
                  exportSource: sourceExporter(this.owners.worker, lifetime),
                  assetFiles,
                  assets: new Map(
                    context.manifest.resources.flatMap((value) =>
                      value.kind === "asset" ? [[value.asset.id, value.asset] as const] : [],
                    ),
                  ),
                }),
              );
            } finally {
              for (const lease of leases) lease.close();
            }
          }
          for (const resource of manifest.resources) {
            if (resource.kind !== "scene-generation") continue;
            async function* chunks() {
              for (const member of resourceMembers(resource)) {
                signal.throwIfAborted();
                const source = context.files.open(member.path);
                try {
                  yield JSON.parse(
                    new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(source.fd)),
                  );
                } finally {
                  source.close();
                }
              }
            }
            scenes.push({
              resource,
              stage: await this.owners.sceneRecords.stagePortable(
                resource.metadata,
                chunks(),
                signal,
              ),
            });
          }
          for (const resource of manifest.resources) {
            if (resource.kind !== "transcript-generation") continue;
            const rawPath = transcriptMemberPath(resource, "raw.jsonl"),
              receiptPath = transcriptMemberPath(resource, "receipt.json");
            const raw = context.files.open(rawPath);
            try {
              const receipt = context.files.open(receiptPath);
              let value: unknown;
              try {
                value = JSON.parse(
                  new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(receipt.fd)),
                );
              } finally {
                receipt.close();
              }
              const stat = fstatSync(raw.fd, { bigint: true });
              transcripts.push({
                resource,
                stage: await this.owners.transcriptRecords.stagePortable(
                  resource.metadata,
                  value,
                  {
                    path: context.files.path(rawPath),
                    bytes: Number(stat.size),
                    identity: fileIdentity(stat),
                  },
                  {
                    ...resource.metadata.track,
                    source: assetPaths.get(resource.metadata.owner.assetId)!,
                    available: resource.available,
                  },
                  signal,
                ),
              });
            } finally {
              raw.close();
            }
          }
          const importedResources = manifest.resources.filter(
            (
              value,
            ): value is Extract<PortableResource, { kind: "imported-transcript-generation" }> =>
              value.kind === "imported-transcript-generation",
          );
          const portableAssets = new Map(
            manifest.resources.flatMap((value) =>
              value.kind === "asset" ? [[value.asset.id, value.asset] as const] : [],
            ),
          );
          const portableAcquisitions = new Map(
            manifest.resources.flatMap((value) =>
              value.kind === "acquisition"
                ? [[value.acquisition.id, value.acquisition] as const]
                : [],
            ),
          );
          const validateSpeaker = assetSpeakerOwner(
            {
              get: (id) => {
                const value = portableAssets.get(id);
                if (!value)
                  throw new CatalogError("INVALID_PACKAGE", "Missing speaker source asset");
                return value;
              },
              path: (id) => assetPaths.get(id)!,
            },
            {
              get: (id) => {
                const value = portableAcquisitions.get(id);
                if (!value)
                  throw new CatalogError("INVALID_PACKAGE", "Missing speaker acquisition");
                return value;
              },
            },
          );
          for (const resource of manifest.resources
            .filter(
              (value): value is Extract<PortableResource, { kind: "speaker-generation" }> =>
                value.kind === "speaker-generation",
            )
            .toSorted((a, b) => a.sequence - b.sequence)) {
            signal.throwIfAborted();
            speakers.push({
              resource,
              stage: this.owners.speakerRecords.stagePortable(
                resource.metadata,
                resource,
                validateSpeaker,
              ),
            });
          }
          const validateAlignment = assetAlignmentOwner(
            {
              get: (id) => {
                const asset = portableAssets.get(id);
                if (!asset)
                  throw new CatalogError("INVALID_PACKAGE", "Missing alignment source asset");
                return asset;
              },
              path: (id) => assetPaths.get(id)!,
            },
            {
              get: (id) => {
                const acquisition = portableAcquisitions.get(id);
                if (!acquisition)
                  throw new CatalogError("INVALID_PACKAGE", "Missing alignment acquisition");
                return acquisition;
              },
            },
          );
          for (const resource of manifest.resources
            .filter(
              (value): value is Extract<PortableResource, { kind: "alignment-generation" }> =>
                value.kind === "alignment-generation",
            )
            .toSorted((a, b) => a.sequence - b.sequence)) {
            signal.throwIfAborted();
            alignments.push({
              resource,
              stage: this.owners.alignmentRecords.stagePortable(
                resource.metadata,
                resource,
                validateAlignment,
              ),
            });
          }
          const sceneReads = new Map(
            scenes.map(({ resource, stage }) => [resourceIdentity(resource).id, stage.read]),
          );
          for (const resource of manifest.resources) {
            if (resource.kind !== "index-generation") continue;
            const selected = selectSourceMetadata(
              portableAssets.get(resource.metadata.assetId)!,
              assetPaths.get(resource.metadata.assetId)!,
              resource.metadata.acquisitionId === undefined
                ? undefined
                : portableAcquisitions.get(resource.metadata.acquisitionId),
              {
                assetId: resource.metadata.assetId,
                streamId: resource.metadata.streamId,
                ...(resource.metadata.acquisitionId === undefined
                  ? {}
                  : { acquisitionId: resource.metadata.acquisitionId }),
              },
            );
            indexes.push({
              resource,
              stage: await this.owners.indexRecords.stagePortable(
                resource.metadata,
                portableIndexRecords<SourceIndexRecords>(
                  context.files,
                  resource,
                  (value) => portableSourceIndexRecordSchema.parse(value),
                  signal,
                ),
                signal,
                sourceIndexDomain(
                  () => selected,
                  sceneReads.get(sceneGenerationResource(resource.metadata.scenes))!,
                  null,
                ),
              ),
            });
          }
          for (const resource of manifest.resources) {
            if (resource.kind !== "project-index-generation") continue;
            const revisionId = adoption.revisionIds[resource.metadata.revisionId]!;
            const metadata = {
              ...resource.metadata,
              projectId: adoption.project.projectId,
              revisionId,
            };
            const revision = adoption.revisions.find((value) => value.id === revisionId)!;
            const validation = projectIndexDomain(
              {
                composition: () =>
                  projectCompositionFromRevision(
                    revision,
                    {
                      get: (id) => portableAssets.get(id)!,
                      path: (id) => assetPaths.get(id)!,
                    },
                    [...portableAcquisitions.values()].map(acquisitionContext),
                  ),
                source: (selection) =>
                  selectSourceMetadata(
                    portableAssets.get(selection.assetId)!,
                    assetPaths.get(selection.assetId)!,
                    selection.acquisitionId
                      ? portableAcquisitions.get(selection.acquisitionId)
                      : undefined,
                    selection,
                  ),
                scenes: {
                  metadata: (identity) =>
                    sceneReads.get(sceneGenerationResource(identity))!.metadata(identity),
                },
                isDeleting: () => false,
              },
              { implementationId: resource.metadata.implementationId },
            );
            const stage = await this.owners.projectIndexRecords.stagePortable(
              metadata,
              portableIndexRecords<ProjectIndexRecords>(
                context.files,
                resource,
                (value) => {
                  const parsed = portableProjectIndexRecordSchema.parse(value);
                  if (parsed.kind === "coverage") return parsed;
                  if (
                    parsed.frame.projectId !== resource.metadata.projectId ||
                    parsed.frame.revisionId !== resource.metadata.revisionId
                  )
                    throw new CatalogError(
                      "INVALID_PACKAGE",
                      "Project index receipt belongs to another revision",
                    );
                  return {
                    ...parsed,
                    frame: { ...parsed.frame, projectId: metadata.projectId, revisionId },
                  };
                },
                signal,
              ),
              signal,
              validation,
            );
            projectIndexes.push({ resource, stage });
          }
          // Asset staging links change ctime when closed; capture retained PCM identity afterward.
          for (const asset of staged) await asset.close();
          for (const resource of manifest.resources) {
            if (resource.kind !== "prepared-audio") continue;
            const revisionId = adoption.revisionIds[resource.revisionId]!;
            const revision = adoption.revisions.find((value) => value.id === revisionId)!;
            preparedAudio.push(
              await this.owners.preparedAudio.stagePortable(
                omit(resource, "kind"),
                projectCompositionFromRevision(
                  revision,
                  {
                    get: (id) => portableAssets.get(id)!,
                    path: (id) => assetPaths.get(id)!,
                  },
                  [...portableAcquisitions.values()].map(acquisitionContext),
                ),
                assetPaths.get(resource.audio.assetId)!,
                reference,
                signal,
              ),
            );
          }
          signal.throwIfAborted();
          const result = adoption.publish(
            () => {
              for (const asset of staged) asset.publish();
              for (const acquisition of acquisitions) acquisition.publish();
              for (const { resource, stage } of speakers) {
                stage.publish();
                if (resource.publication)
                  this.owners.speakers.adoptPublication(stage.metadata, resource.publication);
              }
              for (const { resource, stage } of alignments) {
                stage.publish();
                if (resource.publication)
                  this.owners.alignments.adoptPublication(stage.metadata, resource.publication);
              }
              for (const { resource, stage } of transcripts) {
                stage.publish();
                this.owners.transcripts.adoptPublication(
                  stage.metadata,
                  resource.available,
                  resource.publication,
                  stage.issues,
                );
              }
              for (const { resource, stage } of scenes) {
                stage.publish();
                if (resource.publication)
                  this.owners.scenes.adoptPublication(resource.metadata, resource.publication);
              }
              for (const { resource, stage } of indexes) {
                stage.publish();
                this.owners.indexes.adoptSourcePublication(resource.metadata, resource.publication);
              }
            },
            {
              reference,
              publish: () => {
                for (const stage of preparedAudio) stage.publish();
                for (const { resource, stage } of projectIndexes) {
                  stage.publish();
                  this.owners.indexes.adoptProjectPublication(
                    resource.metadata,
                    stage.metadata,
                    resource.publication,
                  );
                }
              },
            },
          );
          for (const resource of importedResources) {
            signal.throwIfAborted();
            await this.owners.importedTranscripts.adoptPortable(
              resource as unknown as PortableImportedTranscript,
              context.files.path(importedTranscriptMemberPath(resource)),
              signal,
            );
          }
          return JSON.stringify({
            projectId: result.project.projectId,
            revisionId: result.revision.id,
          });
        } finally {
          await Promise.all(speakers.map(({ stage }) => stage.close()));
          await Promise.all(alignments.map(({ stage }) => stage.close()));
          await Promise.all(projectIndexes.map(({ stage }) => stage.close()));
          await Promise.all(indexes.map(({ stage }) => stage.close()));
          await Promise.all(transcripts.map(({ stage }) => stage.close()));
          await Promise.all(scenes.map(({ stage }) => stage.close()));
          await Promise.all(acquisitions.map((acquisition) => acquisition.close()));
          await Promise.all(staged.map((asset) => asset.close()));
        }
      },
    );
    const { input: recipe, result: serialized, ...summary } = job;
    return {
      ...summary,
      packageHandle,
      requestId,
      inputSha256: createHash("sha256").update(recipe).digest("hex"),
      published: serialized
        ? publishedOutput(contextPublication(job), () => JSON.parse(serialized) as unknown)
        : null,
    };
  }
  async assemble(
    pinned: PinnedProjectPackage,
    input: Workspace,
    zip: Workspace,
    signal: AbortSignal,
  ) {
    const plan: {
      path: string;
      bytes: number;
      sha256: string;
      identity: ReturnType<typeof fileIdentity>;
    }[] = [];
    const revisions = new Map<string, string>();
    let expanded = 0;
    const add = async (path: string, bytes: number, sha256: string) => {
      if (
        bytes > archiveLimits.memberBytes ||
        plan.length >= archiveLimits.entries - 1 ||
        expanded + bytes > archiveLimits.expandedBytes
      )
        throw new CatalogError("LIMIT_EXCEEDED", "Project package exceeds archive budget");
      const file = await open(
        join(input.directory, path),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        plan.push({
          path,
          bytes,
          sha256,
          identity: fileIdentity(await file.stat({ bigint: true })),
        });
      } finally {
        await file.close();
      }
      expanded += bytes;
    };
    const text = async (path: string, body: string) => {
      await writeFile(join(input.directory, path), body, { flag: "wx", signal });
      await add(path, Buffer.byteLength(body), createHash("sha256").update(body).digest("hex"));
    };
    await mkdir(join(input.directory, "revisions"), { mode: 0o700 });
    await mkdir(join(input.directory, "assets"), { mode: 0o700 });
    for (const revision of pinned.snapshot.revisions) {
      const path = `revisions/${revision.ordinal}.json`,
        body = JSON.stringify(revision);
      revisions.set(path, body);
      await text(path, body);
    }
    const declared = pinned.resources.flatMap((resource) =>
      resource.kind === "scene-generation" ||
      resource.kind === "transcript-generation" ||
      resource.kind === "imported-transcript-generation" ||
      resource.kind === "index-generation" ||
      resource.kind === "project-index-generation"
        ? []
        : resourceMembers(resource),
    );
    const resources: PortableResource[] = [];
    const resourceMetadata = new Map<string, string>();
    let jsonBytes = [...revisions.values()].reduce((sum, body) => sum + Buffer.byteLength(body), 0);
    if (
      declared.length + plan.length >= archiveLimits.entries ||
      declared.some((entry) => entry.bytes > archiveLimits.memberBytes) ||
      declared.reduce((sum, entry) => sum + entry.bytes, expanded) > archiveLimits.expandedBytes
    )
      throw new CatalogError("LIMIT_EXCEEDED", "Project resources exceed archive budget");
    const assembleIndex = async <D extends IndexRecords>(
      entry: Extract<PortableDependency, { kind: "index-generation" | "project-index-generation" }>,
      recordsStore: ScreenshotIndexStore<D>,
      identity: D["identity"],
    ) => {
      const records: Extract<PortableResource, { kind: "index-generation" }>["records"] = [],
        images: Extract<PortableResource, { kind: "index-generation" }>["images"] = [];
      const record = async (value: unknown) => {
        const body = JSON.stringify(value),
          path = indexMemberPath(entry, "records", records.length);
        if (Buffer.byteLength(body) > 262144)
          throw new CatalogError(
            "LIMIT_EXCEEDED",
            "Screenshot index record exceeds package budget",
          );
        await mkdir(dirname(join(input.directory, path)), { recursive: true, mode: 0o700 });
        await text(path, body);
        records.push({
          bytes: Buffer.byteLength(body),
          sha256: createHash("sha256").update(body).digest("hex"),
        });
      };
      for (let ordinal = 0; ordinal < entry.metadata.candidateCount; ordinal++) {
        signal.throwIfAborted();
        const value = recordsStore.readEntry(identity, ordinal),
          source = recordsStore.portableImage(identity, ordinal),
          path = indexMemberPath(entry, "images", ordinal);
        await mkdir(dirname(join(input.directory, path)), { recursive: true, mode: 0o700 });
        const copied = await copyImportedFile(
          source.path,
          join(input.directory, path),
          signal,
          source,
          32 * 1024 * 1024,
        );
        await add(path, copied.bytes, copied.sha256);
        images.push(copied);
        await record({
          kind: "entry",
          candidate: value.candidate,
          frame: { ...value.frame, file: `${ordinal}.png` },
        });
      }
      // undefined reads the first page; null means the previous page was the last.
      let afterSequence: number | null | undefined;
      while (afterSequence !== null) {
        const page = recordsStore.coveragePage({
          identity,
          ...(afterSequence === undefined ? {} : { afterSequence }),
          limit: 100,
        });
        for (const coverage of page.coverage)
          await record({ kind: "coverage", coverage: omit(coverage, "sequence") });
        afterSequence = page.nextSequence;
      }
      if (records.length !== entry.metadata.candidateCount + entry.metadata.coverageCount)
        throw new CatalogError("INVALID_STORAGE", "Screenshot index inventory changed");
      return { ...entry, records, images };
    };
    for (const entry of pinned.resources) {
      if (entry.kind === "scene-generation") {
        const chunks: Extract<PortableResource, { kind: "scene-generation" }>["chunks"] = [];
        for (const body of this.sceneChunks(entry.metadata)) {
          signal.throwIfAborted();
          const path = sceneMemberPath(entry, chunks.length);
          const bytes = Buffer.byteLength(body);
          if (bytes > 8 * 1024 * 1024)
            throw new CatalogError("LIMIT_EXCEEDED", "Scene chunk exceeds package read budget");
          await mkdir(dirname(join(input.directory, path)), { recursive: true, mode: 0o700 });
          await text(path, body);
          chunks.push({ bytes, sha256: createHash("sha256").update(body).digest("hex") });
        }
        if (chunks.length !== entry.metadata.chunkCount)
          throw new CatalogError("INVALID_STORAGE", "Scene chunk inventory changed");
        resources.push({ ...entry, chunks });
        continue;
      }
      if (entry.kind === "transcript-generation") {
        const rawPath = transcriptMemberPath(entry, "raw.jsonl"),
          receiptPath = transcriptMemberPath(entry, "receipt.json");
        const raw = pinned.transcriptFiles[resourceIdentity(entry).id]!;
        await mkdir(dirname(join(input.directory, rawPath)), { recursive: true, mode: 0o700 });
        const copied = await copyImportedFile(
          raw.path,
          join(input.directory, rawPath),
          signal,
          raw,
        );
        if (
          copied.bytes !== entry.metadata.raw.bytes ||
          copied.sha256 !== entry.metadata.raw.sha256
        )
          throw new CatalogError(
            "INVALID_STORAGE",
            "Transcript raw data changed after package pin",
          );
        await add(rawPath, copied.bytes, copied.sha256);
        const body = JSON.stringify(this.owners.transcriptRecords.portableReceipt(entry.metadata));
        if (Buffer.byteLength(body) > 8 * 1024 * 1024)
          throw new CatalogError(
            "LIMIT_EXCEEDED",
            "Transcript receipt exceeds package read budget",
          );
        await text(receiptPath, body);
        resources.push({
          ...entry,
          receipt: {
            bytes: Buffer.byteLength(body),
            sha256: createHash("sha256").update(body).digest("hex"),
          },
        });
        continue;
      }
      if (entry.kind === "imported-transcript-generation") {
        const rawPath = importedTranscriptMemberPath(entry);
        const raw = pinned.importedTranscriptFiles[resourceIdentity(entry).id]!;
        await mkdir(dirname(join(input.directory, rawPath)), { recursive: true, mode: 0o700 });
        const copied = await copyImportedFile(
          raw.path,
          join(input.directory, rawPath),
          signal,
          raw,
        );
        if (copied.bytes !== entry.origin.raw.bytes || copied.sha256 !== entry.origin.raw.sha256)
          throw new CatalogError(
            "INVALID_STORAGE",
            "Imported transcript source bytes changed after package pin",
          );
        await add(rawPath, copied.bytes, copied.sha256);
        resources.push(entry);
        continue;
      }
      if (entry.kind === "index-generation") {
        resources.push(await assembleIndex(entry, this.owners.indexRecords, entry.metadata));
        continue;
      }
      if (entry.kind === "project-index-generation") {
        resources.push(await assembleIndex(entry, this.owners.projectIndexRecords, entry.metadata));
        continue;
      }
      if (
        entry.kind === "prepared-audio" ||
        entry.kind === "speaker-generation" ||
        entry.kind === "alignment-generation"
      ) {
        resources.push(entry);
        continue;
      }
      resources.push(entry);
      for (const [index, member] of resourceMembers(entry).entries()) {
        signal.throwIfAborted();
        const source =
          entry.kind === "asset"
            ? undefined
            : pinned.acquisitionFiles[entry.acquisition.id]![
                index === 0
                  ? "journal"
                  : index === 1
                    ? "normalized"
                    : (member.path.split("/").at(-1)! as AcquisitionMember)
              ];
        const path = join(input.directory, member.path);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const copied = await copyImportedFile(
          entry.kind === "asset" ? this.owners.assets.path(entry.asset.id) : source!.path,
          path,
          signal,
          source,
        );
        if (
          (member.sha256 !== null && copied.sha256 !== member.sha256) ||
          copied.bytes !== member.bytes
        )
          throw new CatalogError("INVALID_STORAGE", "Package source bytes changed");
        await add(member.path, copied.bytes, copied.sha256);
      }
    }
    await mkdir(join(input.directory, "resources"), { mode: 0o700 });
    for (const resource of resources) {
      signal.throwIfAborted();
      const metadata = resourceMetadataMember(resource);
      jsonBytes += metadata.reference.metadata.bytes;
      checkProjectJsonBytes(jsonBytes);
      await text(metadata.reference.metadata.path, metadata.body);
      resourceMetadata.set(metadata.reference.metadata.path, metadata.body);
    }
    const manifest = projectPackageManifest(
      pinned.snapshot,
      resources,
      plan.map((entry) => omit(entry, "identity")),
    );
    const body = JSON.stringify(manifest);
    validateProjectPackage(body, revisions, archiveLimits, resourceMetadata);
    await text("manifest.json", body);
    const planBody = JSON.stringify(plan);
    if (Buffer.byteLength(planBody) > archiveLimits.receiptBytes)
      throw new CatalogError("LIMIT_EXCEEDED", "Project ZIP plan exceeds metadata budget");
    const path = join(input.directory, "zip-plan.json");
    await writeFile(path, planBody, { flag: "wx", signal });
    const planFile = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return await writeArchive(
        { handle: input.handle, plan: planFile, bytes: expanded },
        zip,
        this.owners.worker,
        { signal },
      );
    } finally {
      await planFile.close();
    }
  }
}
