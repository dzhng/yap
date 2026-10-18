import {
  boundedIssues,
  normalizeOutputRequest,
  normalizeAudioOutputRequest,
  type AudioOutputSettingsInput,
  type Issue,
  type OutputSettingsInput,
} from "@yap/composition";
import { ResourceReferences, resourceKinds, type ResourceReference } from "@yap/core/references";
import { resourceIdentity, staleTranscriptIssues } from "@yap/core/project-package";
import type { ProjectPackages, PinnedProjectPackage } from "./project-packages.js";
import type { operationSchema } from "@yap/protocol";
import { projectCaptionSidecar, type PinnedCaptionSidecar } from "@yap/core/project-window";
import type { AssetStore } from "@yap/core/assets";
import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { CatalogError, dependencyRefusal, type Catalog } from "@yap/core/catalog";
import type { DerivedCache, DirectoryIdentity } from "@yap/core/cache";
import {
  JobDependencyLost,
  ownerIdentity,
  type JobOwner,
  type Job,
  type JobAdmission,
  type JobExecution,
  type JobQueue,
  type StagedJobResult,
} from "@yap/core/jobs";
import type { ProjectStore } from "@yap/core/projects";
import type { ProjectPreviewInspection, PinnedProjectPreview } from "@yap/core/project-preview";
import {
  Publication,
  publicationDeadlineMs,
  type PublicationReceipt,
  type PublicationFile,
} from "./publication.js";
import {
  provisionPackageWorkspace,
  removePackageWorkspace,
  checkWorkspace,
  type AssemblyReservation,
} from "./package-workspace.js";
import type { ManagedFiles } from "./managed-files.js";
import type { MediaWorker } from "./worker.js";
import { pageCursor } from "@yap/core/page-cursor";

import type { MediaAudioInspection, PinnedProjectAudioExport } from "@yap/core/audio-inspection";

type Request = Extract<
  ReturnType<typeof operationSchema.parse>,
  { operation: "export.create" }
>["params"] & { exportId: string };
type ExportOwner = Extract<JobOwner, { kind: "project" }>;
type ReadyRendition = {
  cacheId: string;
  bytes: number;
  generation: number;
  /** The rendition's issues, which the export inherits; intents admitted before issues have none. */
  issues?: Issue[];
};
type Intent = {
  kind: Request["kind"];
  assembly: AssemblyReservation | null;
  exportId: string;
  targetKind: "project";
  targetId: string;
  request: string;
  snapshot:
    | PinnedProjectPreview
    | PinnedProjectAudioExport
    | PinnedProjectPackage
    | PinnedCaptionSidecar;
  destination: {
    directory: string;
    identity: DirectoryIdentity;
    leaf: string;
    replacement: PublicationFile | null;
  };
  staging: DirectoryIdentity | null;
  stagingCleared: 0 | 1;
  preview: ReadyRendition | null;
  receipt: PublicationReceipt | null;
  abandoning: boolean;
};
type Row = Omit<
  Intent,
  "snapshot" | "destination" | "staging" | "preview" | "receipt" | "abandoning" | "assembly"
> & {
  assembly: string | null;
  snapshot: string;
  destination: string;
  staging: string | null;
  preview: string | null;
  receipt: string | null;
  abandoning: number;
};
type IntentIdentity = Pick<Intent, "exportId" | "targetKind" | "targetId"> & {
  snapshot: { revisionId: string };
};
type PackageSnapshotSummary = {
  projectId: string;
  revisionId: string;
  historyThroughOrdinal: number;
  revisionCount: number;
  resourceCount: number;
};
// SQLite owns this derived immutable projection. Status reads the indexed expression,
// leaving the complete pinned snapshot authoritative for execution and recovery.
type CaptionSnapshotSummary = Omit<PinnedCaptionSidecar, "content" | "cues" | "issues"> & {
  cueCount: number;
};
const statusSnapshotSql = `CASE WHEN targetKind='project' AND kind='processed-package'
  THEN json_object('projectId',targetId,'revisionId',json_extract(snapshot,'$.revisionId'),
    'historyThroughOrdinal',json_array_length(snapshot,'$.snapshot.revisions')-1,
    'revisionCount',json_array_length(snapshot,'$.snapshot.revisions'),
    'resourceCount',json_array_length(snapshot,'$.resources'))
  WHEN kind IN ('srt','vtt') THEN json_object('projectId',targetId,'revisionId',json_extract(snapshot,'$.revisionId'),
    'kind',kind,'placementIds',json_extract(snapshot,'$.placementIds'),
    'cueCount',json_array_length(snapshot,'$.cues'))
  ELSE snapshot END`;
// Issues are facts of the pinned snapshot, so status reports them from admission onward,
// including after crash recovery commits the receipt.
const statusIssuesSql = `CASE WHEN kind IN ('srt','vtt') THEN json_extract(snapshot,'$.issues')
  WHEN targetKind='project' AND kind='processed-package' THEN json_extract(snapshot,'$.stale') END`;
function snapshotIssues(kind: string, projected: string | null): Issue[] {
  if (projected === null) return [];
  if (kind === "srt" || kind === "vtt") return JSON.parse(projected) as Issue[];
  return staleTranscriptIssues(JSON.parse(projected) as ResourceReference[]);
}
const artifact = "export-media",
  recoveryArtifact = "export-recovery";
const stageName = (id: string) => `.yap-export-${id}`;

/** The publication lock refuses a second holder of a destination directory. This service's
 * publishers instead take turns per directory, so they serialize rather than fail each other;
 * PUBLICATION_BUSY is left for another process. Holders are bounded by their worker deadlines. */
const destinationTurns = new Map<string, Promise<void>>();
async function destinationTurn(identity: DirectoryIdentity): Promise<() => void> {
  const key = `${identity.dev}:${identity.ino}`;
  const prior = destinationTurns.get(key);
  let finish!: () => void;
  const turn = new Promise<void>((resolve) => (finish = resolve));
  const queued = (prior ?? Promise.resolve()).then(() => turn);
  destinationTurns.set(key, queued);
  await prior;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    finish();
    if (destinationTurns.get(key) === queued) destinationTurns.delete(key);
  };
}

/** Lifecycle columns as stored: JSON or null for staging, assembly and receipt, 0/1 flags. */
type Lifecycle = {
  staging: unknown;
  stagingCleared: number;
  assembly: unknown;
  receipt: unknown;
  abandoning: unknown;
};
/** Staging bytes or the staging directory beside the destination may still exist. */
const stagingPending = (row: Pick<Lifecycle, "staging" | "stagingCleared">) =>
  !!row.staging && !row.stagingCleared;
/** Private obligations remain: staging beside the destination or package assembly workspaces. */
const cleanupPending = (row: Lifecycle) => !!row.assembly || stagingPending(row);
// Partial indexes and page filters need these predicates in SQL; each mirrors its TS twin above.
const stagingPendingSql = "(staging IS NOT NULL AND stagingCleared=0)";
const cleanupPendingSql = `(assembly IS NOT NULL OR ${stagingPendingSql})`;
const unfinishedSql = `(receipt IS NULL OR abandoning=1 OR ${cleanupPendingSql})`;
/** Intents that still pin prerequisites or library workspaces count against admission. */
const admittedSql = "(receipt IS NULL OR abandoning=1 OR assembly IS NOT NULL)";

/** The summary both discovery pages and status report for one intent. */
function summarize(row: Lifecycle, job: Pick<Job, "state" | "jobId"> | null) {
  return {
    jobId: job?.jobId ?? null,
    state: row.receipt
      ? ("committed" as const)
      : job?.state === "waiting"
        ? ("queued" as const)
        : (job?.state ?? ("not_requested" as const)),
    abandoning: !!row.abandoning,
    cleanupPending: cleanupPending(row),
  };
}

/** Durable external truth belongs here; execution state and retries remain in JobQueue.
 * Prerequisites wait in that queue while this owner pins their source generation. */
export class MediaExports {
  onUpdateProgress: (() => void) | undefined;
  get updateBlocked(): boolean {
    return this.creating.size > 0 || this.retiring.size > 0 || this.admittingRecovery;
  }
  /** Export intents marked for abandonment are hidden from discoverable listings. */
  listable(exportId: string): boolean {
    return Boolean(
      this.owners.catalog.catalog
        .prepare("SELECT 1 FROM export_intents WHERE exportId=? AND abandoning=0")
        .get(exportId),
    );
  }
  private readonly references: ResourceReferences;
  private readonly creating = new Map<Promise<unknown>, string>();
  private readonly lifetime = new AbortController();
  private readonly retiring = new Map<string, Promise<void>>();
  private readonly recoveryRequests = new Map<
    string,
    { exportId: string; result: ReturnType<MediaExports["status"]> }
  >();
  private closed = false;
  private admittingRecovery = false;
  constructor(
    private readonly owners: {
      catalog: Catalog;
      jobs: JobQueue;
      cache: DerivedCache;
      worker: MediaWorker;
      files: Pick<ManagedFiles, "externalDirectory">;
      project: {
        store: ProjectStore;
        assets: AssetStore;
        preview: ProjectPreviewInspection;
        audio?: MediaAudioInspection;
        package?: ProjectPackages;
      };
    },
  ) {
    this.references = new ResourceReferences(owners.catalog);
    // Recovery inputs are bounded export/attempt IDs and need ordered prefix retirement.
    owners.catalog.catalog.exec(`CREATE INDEX IF NOT EXISTS export_recovery_identity
      ON jobs(targetKind,targetId,revisionId,input) WHERE artifact='${recoveryArtifact}';
    CREATE TABLE IF NOT EXISTS export_intents (
      exportId TEXT PRIMARY KEY, targetKind TEXT NOT NULL CHECK(targetKind IN ('recording','project')), targetId TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('video','audio','processed-package','srt','vtt')),
      request TEXT NOT NULL, snapshot TEXT NOT NULL, destination TEXT NOT NULL,
      staging TEXT, stagingCleared INTEGER NOT NULL DEFAULT 0 CHECK(stagingCleared IN (0,1)),
      preview TEXT, sourceEvidence TEXT, packageEvidence TEXT, assembly TEXT, receipt TEXT,
      abandoning INTEGER NOT NULL DEFAULT 0 CHECK(abandoning IN (0,1))
    ) STRICT; CREATE INDEX IF NOT EXISTS export_intents_pending ON export_intents(targetKind,targetId) WHERE ${admittedSql};
    CREATE INDEX IF NOT EXISTS export_intents_storage ON export_intents(exportId) WHERE ${stagingPendingSql};
    CREATE INDEX IF NOT EXISTS export_intents_owner ON export_intents(targetKind,targetId,exportId);
    CREATE INDEX IF NOT EXISTS export_discovery_unfinished ON export_intents(exportId) WHERE ${unfinishedSql};
    CREATE INDEX IF NOT EXISTS export_discovery_owner_unfinished ON export_intents(targetKind,targetId,exportId) WHERE ${unfinishedSql};
    CREATE INDEX IF NOT EXISTS export_intents_destination ON export_intents(
      json_extract(destination,'$.identity.dev'),json_extract(destination,'$.identity.ino'),json_extract(destination,'$.leaf'),
      json_extract(receipt,'$.file.dev'),json_extract(receipt,'$.file.ino'),json_extract(receipt,'$.bytes'),json_extract(receipt,'$.sha256')) WHERE receipt IS NOT NULL;
    CREATE INDEX IF NOT EXISTS export_intents_status_projection ON export_intents(exportId,(${statusSnapshotSql}),targetKind,targetId,kind,destination,receipt,abandoning,
      (assembly IS NOT NULL),(staging IS NOT NULL),stagingCleared);`);
  }
  private projectAudio() {
    const audio = this.owners.project.audio;
    if (!audio) throw new CatalogError("NOT_READY", "Project audio exports are unavailable");
    return audio;
  }
  private prepareProjectMedia(
    kind: Request["kind"],
    input:
      | {
          projectId: string;
          revisionId?: string | undefined;
          settings?: OutputSettingsInput | AudioOutputSettingsInput | undefined;
        }
      | PinnedProjectPreview
      | PinnedProjectAudioExport,
  ) {
    return kind === "audio"
      ? this.projectAudio().prepareExport(
          input as Parameters<MediaAudioInspection["prepareExport"]>[0],
        )
      : this.owners.project.preview.prepare(
          input as Parameters<ProjectPreviewInspection["prepare"]>[0],
        );
  }
  private projectPackage() {
    const packages = this.owners.project.package;
    if (!packages)
      throw new CatalogError(
        "PREREQUISITE_MISSING",
        "Project packages are unavailable in this service",
      );
    return packages;
  }
  private owner(intent: Pick<Intent, "targetId">): ExportOwner {
    return { kind: "project", projectId: intent.targetId };
  }
  private assertOwner(intent: Pick<Intent, "targetId">) {
    this.owners.project.store.get(intent.targetId);
  }
  private deleting(owner: ExportOwner) {
    return this.owners.project.store.isDeleting(owner.projectId);
  }
  private matches(job: Job, intent: Intent) {
    return (
      ownerIdentity(job.target).every(
        (value, index) => value === ownerIdentity(this.owner(intent))[index],
      ) &&
      "revisionId" in job.target &&
      job.target.revisionId === intent.snapshot.revisionId
    );
  }
  private find(exportId: string): Intent | null {
    const row = this.owners.catalog.catalog
      .prepare("SELECT * FROM export_intents WHERE exportId=?")
      .get(exportId) as Row | undefined;
    if (!row) return null;
    return {
      ...row,
      abandoning: row.abandoning === 1,
      assembly: row.assembly ? JSON.parse(row.assembly) : null,
      snapshot: JSON.parse(row.snapshot),
      destination: JSON.parse(row.destination),
      staging: row.staging ? JSON.parse(row.staging) : null,
      preview: row.preview ? JSON.parse(row.preview) : null,
      receipt: row.receipt ? JSON.parse(row.receipt) : null,
    };
  }
  private require(exportId: string): Intent {
    const intent = this.find(exportId);
    if (!intent)
      throw new CatalogError("NOT_FOUND", "Export intent does not exist", {
        exportId,
      });
    return intent;
  }
  private requireActive(intent: Intent): void {
    if (intent.abandoning)
      throw new CatalogError("EXPORT_ABANDONING", "Export cleanup is pending; retry abandonment", {
        exportId: intent.exportId,
      });
  }

  abandon(exportId: string): Promise<void> {
    if (this.closed) throw new CatalogError("SERVICE_STOPPED", "Export cleanup is closed");
    this.owners.catalog.catalog
      .prepare("UPDATE export_intents SET abandoning=1 WHERE exportId=?")
      .run(exportId);
    return this.retire(exportId);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.lifetime.abort();
    await Promise.allSettled([...this.creating.keys(), ...this.retiring.values()]);
  }

  private identity(intent: IntentIdentity) {
    return {
      target: { ...this.owner(intent), revisionId: intent.snapshot.revisionId },

      artifact,
      input: intent.exportId,
    };
  }
  private recoveryIdentity(intent: IntentIdentity, attemptId: string) {
    return {
      target: { ...this.owner(intent), revisionId: intent.snapshot.revisionId },

      artifact: recoveryArtifact,
      input: `${intent.exportId}/${attemptId}`,
    };
  }

  /** One metadata-only admission turn; capacity hooks call again after real queue progress. */
  resumeRecovery(): unknown[] {
    if (this.closed || this.admittingRecovery) return [];
    this.admittingRecovery = true;
    const errors: unknown[] = [];
    try {
      const rows = this.owners.catalog.catalog
        .prepare(
          `SELECT i.exportId,j.attemptId FROM export_intents i
        JOIN jobs j ON j.targetKind=i.targetKind AND j.targetId=i.targetId AND j.artifact=? AND j.inputSha256=job_input_digest(i.exportId) AND j.input=i.exportId
        WHERE ${cleanupPendingSql} AND i.abandoning=0
        AND j.state IN ('failed','canceled','ready','unavailable')
        AND NOT EXISTS(SELECT 1 FROM projects p WHERE p.projectId=i.targetId AND p.deletedAt IS NOT NULL)
        AND NOT EXISTS(SELECT 1 FROM jobs r WHERE r.targetKind=j.targetKind AND r.targetId=j.targetId AND r.revisionId=j.revisionId
          AND r.artifact=? AND r.inputSha256=job_input_digest(i.exportId || '/' || j.attemptId) AND r.input=i.exportId || '/' || j.attemptId)
        ORDER BY i.exportId LIMIT 32`,
        )
        .all(artifact, recoveryArtifact) as {
        exportId: string;
        attemptId: string;
      }[];
      for (const row of rows) {
        try {
          const intent = this.require(row.exportId);
          this.owners.jobs.submit({
            ...this.recoveryIdentity(intent, row.attemptId),
            lane: "heavy",
          });
        } catch (error) {
          if (
            error instanceof CatalogError &&
            (error.code === "LIMIT_EXCEEDED" ||
              error.code === "CAPACITY_EXCEEDED" ||
              error.code === "SERVICE_STOPPED")
          )
            break;
          errors.push(error);
        }
      }
    } finally {
      this.admittingRecovery = false;
    }
    return errors;
  }

  private hasPreparedInput(intent: Intent): boolean {
    // A staged attempt may already have committed; reconcile before asking dependencies again.
    if (intent.receipt || intent.assembly || (intent.staging && intent.preview)) return true;
    if (intent.preview) {
      const read = this.owners.cache.acquire(intent.preview.cacheId);
      if (read) {
        try {
          if (read.bytes !== intent.preview.bytes)
            throw new CatalogError("INVALID_CACHE", "Pinned preview size changed");
          return true;
        } finally {
          read.release();
        }
      }
    }
    return false;
  }
  admit(job: Job): ReturnType<JobAdmission> {
    const intent = this.require(job.input);
    this.requireActive(intent);
    if (job.artifact !== artifact || !this.matches(job, intent))
      throw new CatalogError("INVALID_JOB", "Export job does not match its pinned intent");
    if (this.hasPreparedInput(intent)) return { state: "ready" };
    let ready: {
      state: string;
      reason: string | null;
      retryable: boolean;
      published: {
        generation: number;
        issues: Issue[];
        preview: { cacheId: string; bytes: number };
      } | null;
    };
    if (intent.kind === "processed-package" || intent.kind === "srt" || intent.kind === "vtt")
      return { state: "ready" };
    if (intent.kind === "audio") {
      const audio = this.projectAudio().resumeExport(intent.snapshot as PinnedProjectAudioExport);
      ready = {
        ...audio,
        published: audio.published
          ? {
              generation: audio.published.generation,
              issues: audio.published.issues,
              preview: {
                ...audio.published.audio,
                bytes: (audio.published.audio as any).sizeBytes ?? audio.published.audio.bytes,
              },
            }
          : null,
      };
    } else ready = this.owners.project.preview.resume(intent.snapshot as PinnedProjectPreview);
    if (ready.state !== "ready" || !ready.published) return this.dependency(ready);
    intent.preview = {
      cacheId: ready.published.preview.cacheId,
      bytes: ready.published.preview.bytes,
      generation: ready.published.generation,
      issues: ready.published.issues,
    };
    this.owners.catalog.catalog
      .prepare("UPDATE export_intents SET preview=? WHERE exportId=?")
      .run(JSON.stringify(intent.preview), intent.exportId);
    return { state: "ready" };
  }
  private saveAssembly(intent: Intent) {
    this.owners.catalog.catalog
      .prepare("UPDATE export_intents SET assembly=? WHERE exportId=?")
      .run(intent.assembly ? JSON.stringify(intent.assembly) : null, intent.exportId);
  }
  private async cleanupAssembly(intent: Intent): Promise<void> {
    const reservation = intent.assembly;
    if (!reservation) return;
    let parent: Awaited<ReturnType<ProjectPackages["exportDirectory"]>> | undefined;
    try {
      parent = await this.projectPackage().exportDirectory();
      if (
        parent.identity.dev !== reservation.parent.dev ||
        parent.identity.ino !== reservation.parent.ino
      )
        throw new CatalogError("PACKAGE_STORAGE_UNAVAILABLE", "Assembly parent changed");
      for (const child of [reservation.input, reservation.zip])
        await removePackageWorkspace(parent, child.name, child.identity, this.owners.worker);
      intent.assembly = null;
      this.saveAssembly(intent);
    } catch (error) {
      if (error instanceof CatalogError)
        throw dependencyRefusal(error.code, error.message, error.details, true);
      throw error;
    } finally {
      await parent?.handle.close();
    }
  }
  private async preparePackage(
    intent: Intent,
    signal: AbortSignal,
    prepare: (file: { readonly fd: number }, bytes: number) => Promise<void>,
  ) {
    await this.cleanupAssembly(intent);
    const parent = await this.projectPackage().exportDirectory();
    const workspaces: Awaited<ReturnType<typeof provisionPackageWorkspace>>[] = [];
    let archive: Awaited<ReturnType<ProjectPackages["assemble"]>> | undefined;
    try {
      signal.throwIfAborted();
      this.requireActive(this.require(intent.exportId));
      this.assertOwner(intent);
      intent.assembly = {
        parent: parent.identity,
        input: { name: randomUUID(), identity: null },
        zip: { name: randomUUID(), identity: null },
      };
      this.saveAssembly(intent);
      for (const kind of ["input", "zip"] as const) {
        const workspace = await provisionPackageWorkspace(parent, this.owners.worker, {
          name: intent.assembly[kind].name,
          signal,
        });
        workspaces.push(workspace);
        intent.assembly[kind].identity = workspace.identity;
        this.saveAssembly(intent);
      }
      const input = workspaces[0]!,
        zip = workspaces[1]!;
      archive = await this.projectPackage().assemble(
        intent.snapshot as PinnedProjectPackage,
        input,
        zip,
        signal,
      );
      intent.assembly.bytes = archive.receipt.bytes;
      this.saveAssembly(intent);
      await checkWorkspace(input);
      await checkWorkspace(zip);
      await prepare(archive.file, archive.receipt.bytes);
    } finally {
      try {
        await archive?.close();
      } finally {
        await Promise.all(workspaces.map((workspace) => workspace.handle.close()));
        await parent.handle.close();
      }
    }
  }
  private dependency(status: {
    state: string;
    jobId?: string | null;
    reason: string | null;
    retryable: boolean;
  }): ReturnType<JobAdmission> {
    if (
      status.state === "failed" ||
      status.state === "unavailable" ||
      status.state === "not_requested"
    )
      throw dependencyRefusal(
        status.state === "unavailable" ? "UNAVAILABLE" : "DEPENDENCY_FAILED",
        status.reason ?? "Required evidence is unavailable",
        { dependency: status.jobId },
        status.retryable,
      );
    if (!status.jobId)
      throw new CatalogError("INVALID_STATE", "Waiting export dependency has no job identity");
    return { state: "waiting", dependency: status.jobId };
  }
  create(request: Request) {
    const pending = this.prepareIntent(request).finally(() => {
      this.creating.delete(pending);
      this.onUpdateProgress?.();
    });
    this.creating.set(pending, request.exportId);
    return pending;
  }
  private requireAdmission(exportId: string): void {
    if (this.closed) throw new CatalogError("SERVICE_STOPPED", "Export admission is closed", {});
    if (this.retiring.has(exportId))
      throw new CatalogError("EXPORT_ABANDONING", "Export cleanup is pending; retry abandonment", {
        exportId,
      });
  }
  private async prepareIntent(request: Request): Promise<ReturnType<MediaExports["status"]>> {
    this.requireAdmission(request.exportId);
    if (
      !request.exportId ||
      !request.leaf ||
      [".", ".."].includes(request.leaf) ||
      /[/\0]/.test(request.leaf) ||
      Buffer.byteLength(request.leaf) > 255
    )
      throw new CatalogError(
        "INVALID_PARAMS",
        "Export needs a request identity and destination filename",
      );
    const targetKind = "project";
    const targetId = request.projectId;
    const settings = "settings" in request ? request.settings : undefined;
    if (settings && request.kind !== "video" && request.kind !== "audio")
      throw new CatalogError("INVALID_PARAMS", "Output settings require a project media export");
    const settingsRequest =
      request.kind === "audio"
        ? normalizeAudioOutputRequest(settings as AudioOutputSettingsInput)
        : request.kind === "video"
          ? normalizeOutputRequest(settings as OutputSettingsInput)
          : {};
    const key = JSON.stringify([
      request.kind,
      targetKind,
      targetId,
      request.revisionId ?? null,
      request.directory,
      request.leaf,
      request.overwrite === true,
      ...(Object.keys(settingsRequest).length ? [settingsRequest] : []),
      ...("placementIds" in request ? [[...request.placementIds].sort()] : []),
    ]);
    const existing = this.find(request.exportId);
    if (existing) {
      if (existing.request !== key)
        throw new CatalogError("REQUEST_CONFLICT", "Export identity names a different request");
      this.requireActive(existing);
      this.assertOwner(existing);
      if (!existing.receipt) {
        if (
          (existing.kind === "video" || existing.kind === "audio") &&
          !this.hasPreparedInput(existing)
        ) {
          const prepared = await this.prepareProjectMedia(
            existing.kind,
            existing.snapshot as PinnedProjectPreview | PinnedProjectAudioExport,
          );
          prepared.submit(() => {
            this.requireAdmission(existing.exportId);
            const current = this.require(existing.exportId);
            this.requireActive(current);
            this.assertOwner(current);
            if (current.request !== key)
              throw new CatalogError(
                "REQUEST_CONFLICT",
                "Export identity names a different request",
              );
          });
        }
        this.owners.jobs.submitDeferred({ ...this.identity(existing), lane: "heavy" });
      }
      return this.status(existing.exportId);
    }
    const preparedPreview =
      request.kind === "video" || request.kind === "audio"
        ? await this.prepareProjectMedia(request.kind, {
            projectId: targetId,
            revisionId: request.revisionId,
            settings,
          })
        : undefined;
    const snapshot =
      preparedPreview?.snapshot ??
      ("placementIds" in request
        ? projectCaptionSidecar(this.owners.project.store, this.owners.project.assets, request)
        : this.projectPackage().pin(targetId, request.revisionId));
    const selected = await this.owners.files.externalDirectory(
      request.directory,
      this.lifetime.signal,
    );
    this.lifetime.signal.throwIfAborted();
    this.requireAdmission(request.exportId);
    this.assertOwner({ targetId });
    // Another request may have won while metadata/directory checks awaited. Replay its pin.
    if (this.find(request.exportId)) return this.prepareIntent(request);
    const release = await destinationTurn(selected.identity);
    const live = await Publication.inspect(
      selected.directory,
      selected.identity,
      request.leaf,
      this.owners.worker,
      this.lifetime.signal,
    )
      .catch((error: unknown) => {
        // Trust and replacement both need the complete bytes. A leaf this owner cannot read is
        // simply untrusted unless overwrite asks to pin it; commit still refuses to displace it.
        if (
          request.overwrite !== true &&
          error instanceof CatalogError &&
          error.code === "PUBLICATION_IO"
        )
          return null;
        throw error;
      })
      .finally(release);
    this.protectSource(live);
    const trusted =
      live &&
      this.owners.catalog.catalog
        .prepare(`SELECT 1 FROM export_intents INDEXED BY export_intents_destination
      WHERE json_extract(destination,'$.identity.dev')=? AND json_extract(destination,'$.identity.ino')=? AND json_extract(destination,'$.leaf')=?
      AND receipt IS NOT NULL AND json_extract(receipt,'$.file.dev')=? AND json_extract(receipt,'$.file.ino')=?
      AND json_extract(receipt,'$.bytes')=? AND json_extract(receipt,'$.sha256')=? LIMIT 1`)
        .get(
          selected.identity.dev,
          selected.identity.ino,
          request.leaf,
          live.file.dev,
          live.file.ino,
          live.bytes,
          live.sha256,
        );
    const destination = {
      ...selected,
      leaf: request.leaf,
      replacement: live && (request.overwrite === true || trusted) ? live : null,
    };
    const persist = () => {
      this.requireAdmission(request.exportId);
      this.assertOwner({ targetId });
      const existing = this.find(request.exportId);
      if (existing) {
        if (existing.request !== key)
          throw new CatalogError("REQUEST_CONFLICT", "Export identity names a different request");
        this.requireActive(existing);
        return existing;
      }
      const pending = this.owners.catalog.catalog
        .prepare(`SELECT COUNT(*) AS count FROM export_intents WHERE ${admittedSql}`)
        .get() as { count: number };
      if (pending.count >= 32)
        throw new CatalogError(
          "CAPACITY_EXCEEDED",
          "Too many uncommitted exports retain their prerequisites",
          {},
        );
      this.owners.catalog.catalog
        .prepare(
          "INSERT OR IGNORE INTO export_intents(exportId,targetKind,targetId,kind,request,snapshot,destination) VALUES (?,?,?,?,?,?,?)",
        )
        .run(
          request.exportId,
          targetKind,
          targetId,
          request.kind,
          key,
          JSON.stringify(snapshot),
          JSON.stringify(destination),
        );
      if (request.kind === "processed-package") {
        const pinned = snapshot as PinnedProjectPackage;
        this.projectPackage().checkPinned(pinned);
        for (const resource of pinned.resources) {
          const identity = resourceIdentity(resource);
          this.references.retain(identity.kind, { kind: "export", id: request.exportId }, [
            identity.id,
          ]);
        }
      }
      const admitted = this.require(request.exportId);
      if (admitted.request !== key)
        throw new CatalogError("REQUEST_CONFLICT", "Export identity names a different request");
      return admitted;
    };
    if (preparedPreview)
      preparedPreview.submit(() => {
        persist();
      });
    else this.owners.catalog.transaction(persist);
    const intent = this.require(request.exportId);
    this.owners.jobs.submitDeferred({
      ...this.identity(intent),
      lane: "heavy",
    });
    return this.status(request.exportId);
  }
  list(
    input: {
      projectId?: string | undefined;
      unfinishedOnly?: boolean | undefined;
      limit?: number | undefined;
      cursor?: string | undefined;
    } = {},
  ) {
    const projectId = input.projectId ?? null,
      unfinishedOnly = input.unfinishedOnly ?? false,
      limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new CatalogError("INVALID_PARAMS", "Export page limit must be1–1000");
    const filters = { projectId, unfinishedOnly };
    const decoded = (
      input.cursor === undefined
        ? undefined
        : pageCursor.decode("export.list", input.cursor, filters)
    ) as { rowid?: unknown } | undefined;
    const owner: ExportOwner | undefined =
      projectId !== null ? { kind: "project", projectId } : undefined;
    // Keep the bounded ID page outside the lookup; SQLite may otherwise scan every summary.
    const rows = this.owners.catalog.catalog
      .prepare(
        `SELECT selected.*,j.state,j.jobId FROM (SELECT rowid,exportId,targetKind,targetId,kind,
      json_extract(${statusSnapshotSql},'$.revisionId') AS revisionId,receipt IS NOT NULL AS receipt,abandoning,
      assembly IS NOT NULL AS assembly,staging IS NOT NULL AS staging,stagingCleared
      FROM (SELECT rowid AS selectedRowid,exportId AS selectedExportId FROM export_intents WHERE rowid<?
        ${owner ? "AND targetKind=? AND targetId=?" : ""}
        ${unfinishedOnly ? `AND ${unfinishedSql}` : ""} ORDER BY rowid DESC LIMIT ?) page
      CROSS JOIN export_intents INDEXED BY export_intents_status_projection ON rowid=page.selectedRowid) selected
      LEFT JOIN jobs j ON j.targetKind=selected.targetKind AND j.targetId=selected.targetId AND j.revisionId=selected.revisionId
      AND j.artifact=? AND j.inputSha256=job_input_digest(selected.exportId) AND j.input=selected.exportId ORDER BY selected.rowid DESC`,
      )
      .all(
        (decoded?.rowid as number | undefined) ?? 9223372036854775807,
        ...(owner ? ownerIdentity(owner) : []),
        limit + 1,
        artifact,
      ) as (Lifecycle & {
      rowid: number;
      exportId: string;
      targetKind: Intent["targetKind"];
      targetId: string;
      kind: Request["kind"];
      revisionId: string;
      state: Job["state"] | null;
      jobId: string | null;
    })[];
    const exports = rows
      .slice(0, limit)
      .map(
        ({ rowid: _rowid, exportId, targetId, kind, revisionId, state, jobId, ...lifecycle }) => ({
          exportId,
          projectId: targetId,
          kind,
          revisionId,
          ...summarize(lifecycle, state && jobId ? { state, jobId } : null),
        }),
      );
    return {
      exports,
      nextCursor:
        rows.length > limit
          ? pageCursor.encode(
              "export.list",
              { rowid: (rows[limit - 1] as { rowid: number }).rowid },
              filters,
            )
          : null,
    };
  }
  /** Reads the durable intent even while its owner is being deleted, as discovery does. */
  status(exportId: string) {
    const row = this.owners.catalog.catalog
      .prepare(`SELECT exportId,targetKind,targetId,kind,
      ${statusSnapshotSql} AS snapshot,${statusIssuesSql} AS issues,destination,receipt,abandoning,
      assembly IS NOT NULL AS assembly,staging IS NOT NULL AS staging,stagingCleared
      FROM export_intents INDEXED BY export_intents_status_projection WHERE exportId=?`)
      .get(exportId) as
      | (Pick<
          Row,
          | "exportId"
          | "targetKind"
          | "targetId"
          | "kind"
          | "snapshot"
          | "destination"
          | "receipt"
          | "abandoning"
        > & { issues: string | null } & Lifecycle)
      | undefined;
    if (!row) throw new CatalogError("NOT_FOUND", "Export intent does not exist", { exportId });
    const intent = {
      ...row,
      snapshot: JSON.parse(row.snapshot) as
        | PinnedProjectPreview
        | PinnedProjectAudioExport
        | PackageSnapshotSummary
        | CaptionSnapshotSummary,
      destination: JSON.parse(row.destination) as Intent["destination"],
      receipt: row.receipt ? (JSON.parse(row.receipt) as PublicationReceipt) : null,
    };
    const job = this.owners.jobs.status(this.identity(intent));
    const current = job.jobId ? this.owners.jobs.job(job.jobId) : null;
    const recovery = current
      ? this.owners.jobs.status(this.recoveryIdentity(intent, current.attemptId))
      : null;
    return {
      exportId,
      kind: intent.kind,
      ...summarize(intent, current),
      recovery,
      projectId: intent.targetId,
      snapshot: intent.snapshot,
      // A restarted client can describe an unfinished export from this alone; output still
      // names only a committed file.
      destination: {
        directory: intent.destination.directory,
        leaf: intent.destination.leaf,
      },
      receipt: intent.receipt,
      output: intent.receipt ? join(intent.destination.directory, intent.destination.leaf) : null,
      // Snapshot issues are pinned at admission; treatment issues arrive with the published media.
      issues: boundedIssues([
        ...snapshotIssues(intent.kind, row.issues),
        ...(job.published?.issues ?? []),
      ]),
      jobId: job.jobId,
      reason: intent.receipt ? null : job.reason,
      retryable: !intent.receipt && job.retryable,
    };
  }
  publicStatus(exportId: string) {
    const value = this.status(exportId) as Record<string, unknown>;
    const receipt = value.receipt as Record<string, unknown> | null;
    const { bytes, ...receiptWithoutBytes } = receipt ?? {};
    return {
      ...value,
      ...(receipt
        ? {
            receipt: {
              ...receiptWithoutBytes,
              ...(bytes === undefined ? {} : { sizeBytes: bytes }),
            },
          }
        : {}),
    };
  }
  /** Private staging remains attributed to its owner even when it lives beside an external destination. */
  async usage(owner: ExportOwner | undefined, signal: AbortSignal): Promise<number> {
    let after = "",
      bytes = 0;
    const query = this.owners.catalog.catalog.prepare(
      `SELECT exportId FROM export_intents WHERE ${owner === undefined ? "" : "targetKind=? AND targetId=? AND "}${stagingPendingSql} AND exportId>? ORDER BY exportId LIMIT 1`,
    );
    for (;;) {
      signal.throwIfAborted();
      const row = (
        owner === undefined ? query.get(after) : query.get(...ownerIdentity(owner), after)
      ) as { exportId: string } | undefined;
      if (!row) return bytes;
      after = row.exportId;
      const intent = this.require(row.exportId);
      let observed: number;
      try {
        observed = await Publication.usage(
          join(intent.destination.directory, stageName(intent.exportId)),
          intent.staging!,
          this.owners.worker,
          signal,
          intent.receipt !== null,
        );
      } catch (error) {
        signal.throwIfAborted();
        // Retirement can remove staging during a live observation, and a destination that is gone
        // or replaced holds nothing this library can measure. A substituted entry stays an error.
        if ((await this.stagingPresence(intent, signal)) === "present") throw error;
        observed = 0;
      }
      if (!Number.isSafeInteger(bytes + observed))
        throw new CatalogError(
          "LIMIT_EXCEEDED",
          "Export storage byte total exceeds safe integer range",
        );
      bytes += observed;
    }
  }
  async retry(exportId: string) {
    const intent = this.require(exportId);
    this.requireActive(intent);
    this.assertOwner(intent);
    // An acknowledged commit never becomes a second export because the user moved/deleted it.
    if (intent.receipt)
      return cleanupPending(intent) ? this.recover(exportId) : this.status(exportId);
    if (intent.kind === "audio" && !this.hasPreparedInput(intent)) {
      await this.projectAudio().retryExport(intent.snapshot as PinnedProjectAudioExport);
    }
    if (intent.kind === "video" && !this.hasPreparedInput(intent)) {
      const pinned = intent.snapshot as PinnedProjectPreview;
      const repairable = (job: Job) => {
        if (job.state !== "failed" || !job.retryable) return false;
        if (job.errorCode === "NOT_READY")
          return job.errorDetails?.implementationId === pinned.implementationId;
        if (
          job.errorCode !== "DEPENDENCY_FAILED" ||
          typeof job.errorDetails?.dependency !== "string"
        )
          return false;
        return (
          this.owners.jobs.job(job.errorDetails.dependency).artifact === "pointer-presentation"
        );
      };
      const prepared = await this.owners.project.preview.prepare(pinned);
      prepared.submit(() => {
        this.requireAdmission(exportId);
        this.requireActive(this.require(exportId));
        this.assertOwner(intent);
      });
      const prior = this.owners.jobs.status(this.identity(intent));
      if (prior.jobId) {
        let failure = this.owners.jobs.job(prior.jobId);
        if (
          failure.errorCode === "DEPENDENCY_FAILED" &&
          typeof failure.errorDetails?.dependency === "string"
        )
          failure = this.owners.jobs.job(failure.errorDetails.dependency);
        if (repairable(failure)) {
          const current = await this.owners.project.preview.request(pinned);
          if (current.jobId && repairable(this.owners.jobs.job(current.jobId)))
            await this.owners.project.preview.retry(pinned);
        }
      }
    }
    const job = this.owners.jobs.submitDeferred(
      {
        ...this.identity(intent),
        lane: "heavy",
      },
      () => {
        this.requireAdmission(exportId);
        const current = this.require(exportId);
        this.requireActive(current);
        this.assertOwner(current);
      },
    );
    this.owners.jobs.retry(job.jobId);
    return this.status(exportId);
  }
  cancel(exportId: string) {
    const intent = this.require(exportId);
    this.requireActive(intent);
    this.assertOwner(intent);
    const { jobId } = this.owners.jobs.status(this.identity(intent));
    if (!intent.receipt && jobId) this.owners.jobs.cancel(jobId);
    // Only runnable/active heavy jobs are returned: the shared queue bounds this set.
    const active = this.owners.catalog.catalog
      .prepare(
        `SELECT jobId FROM jobs WHERE targetKind=? AND targetId=?
      AND revisionId=? AND artifact='${recoveryArtifact}' AND input>? AND input<? AND state IN ('queued','running')`,
      )
      .all(
        intent.targetKind,
        intent.targetId,
        intent.snapshot.revisionId,
        `${exportId}/`,
        `${exportId}0`,
      ) as { jobId: string }[];
    for (const recovery of active) this.owners.jobs.cancel(recovery.jobId);
  }
  private async open(intent: Intent) {
    if (!intent.staging) {
      const identity = await Publication.allocate(
        intent.destination.directory,
        intent.destination.identity,
        stageName(intent.exportId),
        this.owners.worker,
      );
      this.owners.catalog.transaction(() =>
        this.owners.catalog.catalog
          .prepare("UPDATE export_intents SET staging=? WHERE exportId=?")
          .run(JSON.stringify(identity), intent.exportId),
      );
      intent.staging = identity;
    }
    const release = await destinationTurn(intent.destination.identity);
    try {
      return await Publication.open(
        join(intent.destination.directory, stageName(intent.exportId)),
        intent.destination.directory,
        this.owners.worker,
        {
          expected: {
            stage: intent.staging,
            destination: intent.destination.identity,
          },
          timeoutMs: publicationDeadlineMs(
            intent.receipt?.bytes ?? intent.assembly?.bytes ?? intent.preview?.bytes ?? 0,
            intent.destination.replacement?.bytes ?? 0,
          ),
          onClosed: release,
        },
      );
    } catch (error) {
      release();
      throw error;
    }
  }
  private stagingPresence(intent: Intent, signal?: AbortSignal) {
    return Publication.staging(
      intent.destination.directory,
      intent.destination.identity,
      stageName(intent.exportId),
      this.owners.worker,
      signal,
    );
  }
  /** Removes private evidence and then its directory while the publication lock is held. */
  private async retireStaging(
    intent: Intent,
    publication: Publication,
    evidence: "acknowledge" | "discard",
  ) {
    await publication[evidence]();
    await publication.retire(stageName(intent.exportId));
    this.markStagingCleared(intent.exportId);
  }
  /** The receipt is durable before private cleanup. An aborted attempt leaves that cleanup to
   * its canceling owner or to recovery rather than racing their drain. */
  private async settleCommit(
    intent: Intent,
    publication: Publication,
    receipt: PublicationReceipt,
    signal: AbortSignal,
  ) {
    this.recordCommit(intent, receipt);
    if (!signal.aborted) await this.retireStaging(intent, publication, "acknowledge");
  }
  private markStagingCleared(exportId: string) {
    this.owners.catalog.catalog
      .prepare("UPDATE export_intents SET stagingCleared=1 WHERE exportId=?")
      .run(exportId);
  }
  private recordCommit(intent: Intent, receipt: PublicationReceipt) {
    // This write is allowed during deletion/cancellation: the file already exists outside the library.
    this.owners.catalog.transaction(() => {
      this.owners.catalog.catalog
        .prepare("UPDATE export_intents SET receipt=? WHERE exportId=?")
        .run(JSON.stringify(receipt), intent.exportId);
      for (const kind of resourceKinds)
        this.references.release(kind, { kind: "export", id: intent.exportId });
    });
    intent.receipt = receipt;
  }
  private protectSource(file: PublicationFile | null) {
    if (
      file &&
      this.owners.project.assets.isImportedSource({ device: file.file.dev, inode: file.file.ino })
    )
      throw new CatalogError(
        "SOURCE_DESTINATION",
        "Export cannot replace an original imported source",
      );
  }
  async execute({ job, signal }: JobExecution): Promise<string | StagedJobResult> {
    if (job.artifact === recoveryArtifact) return this.reconcile({ job, signal });
    if (job.artifact !== artifact)
      throw new CatalogError("UNSUPPORTED_JOB", "Media exporter cannot execute this job");
    const intent = this.require(job.input);
    this.requireActive(intent);
    if (!this.matches(job, intent))
      throw new CatalogError("INVALID_JOB", "Export job does not match its pinned intent");
    // A delivered rendition carries the issues of the output it copies.
    const issues = intent.preview?.issues ?? [];
    if (intent.receipt) {
      await this.cleanupAssembly(intent);
      return { result: JSON.stringify(intent.receipt), issues };
    }
    signal.throwIfAborted();
    let publication = await this.open(intent);
    try {
      let observed = await publication.reconcile();
      if (observed.state === "unprepared") {
        signal.throwIfAborted();
        await publication.discard();
        if (intent.kind === "processed-package") {
          await publication.close();
          await this.preparePackage(intent, signal, async (file, bytes) => {
            publication = await this.open(intent);
            await publication.prepare(file, intent.destination.leaf, bytes, {
              signal,
              replacement: intent.destination.replacement,
            });
          });
        } else if (intent.kind === "srt" || intent.kind === "vtt") {
          const output = this.owners.cache.reserve(this.owner(intent));
          try {
            await writeFile(output.path, (intent.snapshot as PinnedCaptionSidecar).content, {
              flag: "wx",
              mode: 0o600,
              signal,
            });
            const cached = await this.owners.cache.publish(output.id);
            signal.throwIfAborted();
            await this.owners.cache.withDescriptor(output.id, (source) =>
              publication.prepare(source, intent.destination.leaf, Math.max(1, cached.bytes), {
                signal,
                replacement: intent.destination.replacement,
              }),
            );
          } finally {
            this.owners.cache.remove(output.id);
          }
        } else {
          try {
            if (!intent.preview) throw new JobDependencyLost("Preview is not admitted");
            const preview = intent.preview;
            await this.owners.cache.withDescriptor(preview.cacheId, async (source) => {
              if (source.bytes !== preview.bytes)
                throw new CatalogError("INVALID_CACHE", "Pinned preview size changed");
              await publication.prepare(source, intent.destination.leaf, source.bytes, {
                signal,
                replacement: intent.destination.replacement,
              });
            });
          } catch (error) {
            if (
              error instanceof JobDependencyLost ||
              (error instanceof CatalogError && error.code === "ARTIFACT_EXPIRED")
            ) {
              this.owners.catalog.catalog
                .prepare("UPDATE export_intents SET preview=NULL WHERE exportId=?")
                .run(intent.exportId);
              throw new JobDependencyLost("Preview disappeared before preparation");
            }
            throw error;
          }
        }
        this.protectSource(intent.destination.replacement);
        observed = await publication.commit({ signal });
      } else if (observed.state === "missing" || observed.state === "prepared") {
        this.protectSource(intent.destination.replacement);
        observed = await publication.commit({ signal });
      }
      if (observed.state !== "committed" || !observed.receipt)
        throw new CatalogError(
          "DESTINATION_CHANGED",
          "Export destination belongs to another file or was modified",
          {
            state: observed.state,
            ...(observed.state === "conflicted"
              ? {
                  destinationVisibility: "uncertain",
                  retainedDisplaced: join(
                    intent.destination.directory,
                    stageName(intent.exportId),
                    "swap",
                  ),
                }
              : {}),
          },
        );
      await this.settleCommit(intent, publication, observed.receipt, signal);
      await this.cleanupAssembly(intent);
      return { result: JSON.stringify(observed.receipt), issues };
    } finally {
      await publication.close();
    }
  }
  /** Status never observes publication files; this queues the job that does. */
  recover(exportId: string, requestId?: string) {
    if (requestId) {
      const prior = this.recoveryRequests.get(requestId);
      if (prior) {
        if (prior.exportId !== exportId)
          throw new CatalogError(
            "REQUEST_CONFLICT",
            "Request identity names a different export recovery",
          );
        return prior.result;
      }
    }
    const intent = this.require(exportId);
    this.requireActive(intent);
    this.assertOwner(intent);
    if (!cleanupPending(intent)) {
      const result = this.status(exportId);
      if (requestId) this.recoveryRequests.set(requestId, { exportId, result });
      return result;
    }
    const original = this.owners.jobs.status(this.identity(intent));
    if (!original.jobId)
      throw new CatalogError("INVALID_JOB", "Staged export has no publication job");
    const job = this.owners.jobs.submit({
      ...this.recoveryIdentity(intent, this.owners.jobs.job(original.jobId).attemptId),
      lane: "heavy",
    });
    if (job.state === "ready") this.owners.jobs.regenerate(job.jobId, job.generation);
    else this.owners.jobs.retry(job.jobId);
    const result = this.status(exportId);
    if (requestId) this.recoveryRequests.set(requestId, { exportId, result });
    return result;
  }

  private async reconcile({ job, signal }: JobExecution): Promise<string> {
    const exportId = job.input.slice(0, job.input.indexOf("/"));
    const intent = this.require(exportId);
    this.requireActive(intent);
    if (!this.matches(job, intent))
      throw new CatalogError("INVALID_JOB", "Recovery does not match the pinned export");
    signal.throwIfAborted();
    await this.cleanupAssembly(intent);
    if (!stagingPending(intent)) return JSON.stringify({ observation: null });
    if (intent.receipt) {
      // Recovery never forgets staging it cannot verify; abandonment is the explicit release.
      const presence = await this.stagingPresence(intent, signal);
      if (presence === "unreachable")
        throw new CatalogError(
          "DESTINATION_UNAVAILABLE",
          "Export destination directory is missing or replaced; restore it or abandon the export",
          { exportId },
        );
      if (presence === "absent") this.markStagingCleared(exportId);
      else {
        const publication = await this.open(intent);
        try {
          await this.retireStaging(intent, publication, "discard");
        } finally {
          await publication.close();
        }
      }
      return JSON.stringify({ observation: null });
    }
    const publication = await this.open(intent);
    try {
      const observed = await publication.reconcile({ signal });
      if (observed.state === "committed" && observed.receipt)
        await this.settleCommit(intent, publication, observed.receipt, signal);
      return JSON.stringify({ observation: observed.state });
    } finally {
      await publication.close();
    }
  }

  async retireOwner(owner: ExportOwner, signal?: AbortSignal) {
    if (!this.deleting(owner))
      throw new CatalogError("INVALID_STATE", "Owner deletion must be marked first");
    let after = "",
      firstFailure: unknown;
    for (;;) {
      signal?.throwIfAborted();
      const row = this.owners.catalog.catalog
        .prepare(
          "SELECT exportId FROM export_intents WHERE targetKind=? AND targetId=? AND exportId>? ORDER BY exportId LIMIT 1",
        )
        .get(...ownerIdentity(owner), after) as { exportId: string } | undefined;
      if (!row) break;
      after = row.exportId;
      try {
        await this.retire(row.exportId);
      } catch (error) {
        firstFailure ??= error;
      }
    }
    if (firstFailure) throw firstFailure;
  }

  private retire(exportId: string): Promise<void> {
    const existing = this.retiring.get(exportId);
    if (existing) return existing;
    const result = Promise.resolve()
      .then(() => this.remove(exportId))
      .catch((error) => {
        if (error instanceof CatalogError)
          throw new CatalogError(error.code, error.message, { ...error.details, exportId });
        throw new CatalogError(
          "EXPORT_CLEANUP_FAILED",
          `Export cleanup could not finish: ${error instanceof Error ? error.message : String(error)}`,
          { exportId },
        );
      })
      .finally(() => {
        this.retiring.delete(exportId);
        this.onUpdateProgress?.();
      });
    this.retiring.set(exportId, result);
    return result;
  }

  private async remove(exportId: string): Promise<void> {
    // Destination admission can precede the intent row; absence is final only after those calls drain.
    await Promise.allSettled(
      [...this.creating].filter(([, id]) => id === exportId).map(([pending]) => pending),
    );
    let intent = this.find(exportId);
    if (!intent) return;
    const jobId = this.owners.jobs.status(this.identity(intent)).jobId;
    if (jobId) await this.owners.jobs.drainJob(jobId);
    // The durable intent fence stops every recovery identity before any drain begins.
    const recoveryJobs = this.owners.catalog.catalog.prepare(`SELECT jobId,input FROM jobs
      WHERE targetKind=? AND targetId=? AND revisionId=? AND artifact='${recoveryArtifact}' AND input>? AND input<? ORDER BY input LIMIT 1`);
    let after = `${exportId}/`;
    for (;;) {
      const recovery = recoveryJobs.get(
        intent.targetKind,
        intent.targetId,
        intent.snapshot.revisionId,
        after,
        `${exportId}0`,
      ) as { jobId: string; input: string } | undefined;
      if (!recovery) break;
      after = recovery.input;
      await this.owners.jobs.drainJob(recovery.jobId);
      this.owners.jobs.forgetJob(recovery.jobId);
      await setImmediate();
    }
    // A late commit may have updated the receipt while the canceled executor drained.
    intent = this.require(exportId);
    if (!intent.abandoning && !this.deleting(this.owner(intent)))
      throw new CatalogError("INVALID_STATE", "Export must be fenced before retirement");
    // Retired staging needs no destination access. Otherwise a destination that is gone or
    // replaced has nothing of this export's to clean, and a job may have allocated unregistered staging.
    const mayHaveStaging = intent.staging ? !intent.stagingCleared : jobId !== null;
    if (mayHaveStaging && (await this.stagingPresence(intent)) === "present") {
      const publication = await this.open(intent);
      try {
        // Retirement forgets status, so unreadable external files cannot gate private cleanup.
        await publication.retire(stageName(exportId));
      } finally {
        await publication.close();
      }
    }
    await this.cleanupAssembly(intent);
    if (jobId) this.owners.jobs.forgetJob(jobId);
    // A crash after job retirement is harmless: the still-fenced intent resumes private absence checking.
    this.owners.catalog.transaction(() => {
      this.owners.catalog.catalog
        .prepare("DELETE FROM export_intents WHERE exportId=?")
        .run(exportId);
      for (const kind of resourceKinds)
        this.references.release(kind, { kind: "export", id: exportId });
    });
  }
}
