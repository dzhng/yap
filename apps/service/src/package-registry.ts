import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { CatalogError } from "@yap/core/catalog";
import {
  archiveLimits,
  validateArchiveLimits,
  type ArchiveLimits,
  type ArchiveManifest,
} from "@yap/core/package-archive";
import {
  type JobQueue,
  type JobContext,
  type ContextJobRequest,
  type ContextJob,
} from "@yap/core/jobs";
import { admitArchive, type AdmittedArchive } from "./archive-input.js";
import {
  openPackageArchive,
  type RetainedPackage,
  type PackageManifestResolution,
} from "./package-archive.js";
import {
  provisionPackageWorkspace,
  recoverPackageWorkspaces,
  cleanupFailedPackageWorkspace,
} from "./package-workspace.js";
import type { MediaWorker } from "./worker.js";
import type { DerivativeDelivery } from "./delivery.js";

const packageRegistryLimits = Object.freeze({
  owners: 4,
  terminal: 32,
});
type State =
  | "queued"
  | "opening"
  | "ready"
  | "closing"
  | "cleanup_failed"
  | "failed"
  | "canceled"
  | "closed";
type Admission = {
  id: string;
  state: State;
  packageHandle: string | null;
  jobId: string;
  error: string | null;
};
type PackageAdmission = Readonly<Admission>;
type Work<T extends ArchiveManifest> = (
  context: RetainedPackage<T>,
  signal: AbortSignal,
  run: { lifetime: { readonly fd: number }; job: ContextJob },
) => Promise<string>;
type Workspace = Awaited<ReturnType<typeof provisionPackageWorkspace>>;
type Entry<T extends ArchiveManifest> = Admission & {
  terminal: "failed" | "canceled" | "closed";
  admittedBytes: number;
  input: AdmittedArchive;
  context: JobContext;
  requests: Map<string, Work<T>>;
  workspace?: Workspace;
  retained?: RetainedPackage<T>;
  provisionFailure?: unknown;
  provisionStarted: boolean;
  closing?: Promise<void>;
};
const describe = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 4096);

/** One process-local resource owner; execution capacity remains exclusively in JobQueue. */
export class PackageRegistry<
  T extends ArchiveManifest = ArchiveManifest,
  Parsed extends ArchiveManifest = T,
> {
  onUpdateProgress: (() => void) | undefined;
  get updateBlocked(): boolean {
    return !!this.recovering || this.entries.size > 0;
  }
  private readonly entries = new Map<string, Entry<T>>();
  private readonly handles = new Map<string, Entry<T>>();
  private readonly terminal = new Map<string, PackageAdmission>();
  private phase: "recovery" | "ready" | "disposed" = "recovery";
  private recovering: Promise<void> | undefined;
  private recoveryError: string | null = null;
  private readonly limits: ArchiveLimits;
  constructor(
    private readonly options: PackageManifestResolution<T, Parsed> & {
      parent: { directory: string; handle: FileHandle };
      inspect?: (
        retained: RetainedPackage<T>,
        signal: AbortSignal | undefined,
        lifetime: { readonly fd: number },
      ) => Promise<void>;
      jobs: JobQueue;
      worker: MediaWorker;
      delivery: DerivativeDelivery;
      limits?: ArchiveLimits;
      inlineRevisions?: boolean;
    },
  ) {
    this.limits = { ...(options.limits ?? archiveLimits) };
    validateArchiveLimits(this.limits);
  }
  usage() {
    return {
      state: this.phase,
      error: this.recoveryError,
      owners: this.entries.size,
      admittedBytes: [...this.entries.values()].reduce(
        (sum, entry) => sum + entry.admittedBytes,
        0,
      ),
      confirmedBytes: [...this.entries.values()].reduce(
        (sum, entry) =>
          sum +
          (entry.retained
            ? entry.retained.archiveUsage.copiedBytes + entry.retained.archiveUsage.expandedBytes
            : 0),
        0,
      ),
      terminalReceipts: this.terminal.size,
    };
  }
  recover(): Promise<void> {
    if (this.phase === "disposed")
      return Promise.reject(new CatalogError("OWNER_CLOSED", "Package registry is closed"));
    if (this.entries.size)
      return Promise.reject(
        new CatalogError(
          "PROCESSING_BUSY",
          "Package resources must close before startup recovery",
          {},
        ),
      );
    if (this.recovering) return this.recovering;
    this.phase = "recovery";
    this.recovering = recoverPackageWorkspaces(this.options.parent, this.options.worker)
      .then(() => {
        if (this.phase !== "disposed") this.phase = "ready";
        this.recoveryError = null;
      })
      .catch((error) => {
        this.recoveryError = describe(error);
        throw error;
      })
      .finally(() => {
        this.recovering = undefined;
      });
    return this.recovering;
  }
  async open(path: string): Promise<PackageAdmission> {
    if (this.phase === "disposed")
      throw new CatalogError("OWNER_CLOSED", "Package registry is closed");
    if (this.phase !== "ready")
      throw new CatalogError("PROCESSING_BUSY", "Package admission awaits recovery", {});
    if (this.entries.size >= packageRegistryLimits.owners)
      throw new CatalogError("CAPACITY_EXCEEDED", "Too many package resources are owned", {});
    const input = admitArchive(path);
    const admittedBytes = input.bytes;
    let entry!: Entry<T>;
    let context: JobContext;
    try {
      context = this.options.jobs.createContext(({ job, signal }) =>
        this.execute(entry, job, signal),
      );
    } catch (error) {
      input.close();
      throw error;
    }
    entry = {
      id: randomUUID(),
      state: "queued",
      packageHandle: null,
      jobId: "",
      error: null,
      terminal: "closed",
      admittedBytes,
      input,
      context,
      requests: new Map(),
      provisionStarted: false,
    };
    this.entries.set(entry.id, entry);
    try {
      entry.jobId = this.options.jobs.submitContext(context, {
        artifact: "package.open",
        lane: "heavy",
        input: "{}",
      }).jobId;
      return this.snapshot(entry);
    } catch (error) {
      entry.terminal = "failed";
      entry.error = describe(error);
      await this.closeEntry(entry);
      throw error;
    }
  }
  active(): PackageAdmission[] {
    return [...this.entries.values()].map((entry) => this.snapshot(entry));
  }
  status(id: string): PackageAdmission {
    const entry = this.entries.get(id);
    const result = entry ? this.snapshot(entry) : this.terminal.get(id);
    if (!result) throw new CatalogError("NOT_FOUND", "Package admission expired or does not exist");
    return result;
  }
  lookup(handle: string): Pick<RetainedPackage<T>, "manifest" | "files" | "archiveUsage"> {
    return this.ready(handle).retained!;
  }
  job(handle: string, jobId: string): ContextJob {
    return this.options.jobs.contextJob(this.ready(handle).context, jobId);
  }
  submit(handle: string, request: ContextJobRequest, execute: Work<T>): ContextJob {
    if (request.artifact === "package.open")
      throw new CatalogError("INVALID_REQUEST", "Package admission is owned by the registry");
    const entry = this.ready(handle);
    const job = this.options.jobs.submitContext(entry.context, request);
    if (!entry.requests.has(job.jobId)) entry.requests.set(job.jobId, execute);
    return job;
  }
  close(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (entry) {
      if (entry.state === "queued" || entry.state === "opening") entry.terminal = "canceled";
      return this.closeEntry(entry);
    }
    if (this.terminal.has(id)) return Promise.resolve();
    return Promise.reject(
      new CatalogError("NOT_FOUND", "Package admission expired or does not exist"),
    );
  }
  async dispose(): Promise<void> {
    this.phase = "disposed";
    const results = await Promise.allSettled([
      this.recovering,
      ...[...this.entries.values()].map((entry) => this.closeEntry(entry)),
    ]);
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failed) throw failed.reason;
  }
  private ready(handle: string): Entry<T> {
    const entry = this.handles.get(handle);
    if (this.phase === "disposed" || !entry || entry.state !== "ready")
      throw new CatalogError("CONTEXT_CLOSED", "Package handle is not open in this process");
    return entry;
  }
  private snapshot(entry: Entry<T>): PackageAdmission {
    return Object.freeze({
      id: entry.id,
      state: entry.state,
      packageHandle: entry.packageHandle,
      jobId: entry.jobId,
      error: entry.error,
    });
  }
  private async execute(entry: Entry<T>, job: ContextJob, signal: AbortSignal): Promise<string> {
    if (job.artifact !== "package.open") {
      const work = entry.requests.get(job.jobId);
      if (!work || entry.state !== "ready")
        throw new CatalogError("CONTEXT_CLOSED", "Package work is no longer admitted");
      return work(entry.retained!, signal, { lifetime: entry.workspace!.handle, job });
    }
    try {
      if (signal.aborted || entry.state !== "queued")
        throw new CatalogError("CANCELED", "Package opening canceled");
      entry.state = "opening";
      entry.provisionStarted = true;
      try {
        entry.workspace = await provisionPackageWorkspace(
          this.options.parent,
          this.options.worker,
          { name: entry.id, signal },
        );
      } catch (error) {
        entry.provisionFailure = error;
        throw error;
      }
      entry.retained = await openPackageArchive(
        entry.input,
        { directory: entry.workspace.directory, handle: entry.workspace.handle },
        this.options.worker,
        {
          ...this.options,
          signal,
          limits: this.limits,
        },
      );
      if (signal.aborted || entry.state !== "opening")
        throw new CatalogError("CANCELED", "Package opening canceled");
      const { copiedBytes, expandedBytes } = entry.retained.archiveUsage;
      entry.admittedBytes = copiedBytes + expandedBytes;
      entry.input.close();
      entry.packageHandle = randomUUID();
      entry.state = "ready";
      this.handles.set(entry.packageHandle, entry);
      return JSON.stringify({ packageHandle: entry.packageHandle });
    } catch (error) {
      entry.error = describe(error);
      if (!entry.closing) {
        entry.terminal = signal.aborted ? "canceled" : "failed";
        // Closing waits for this queue attempt; do not await it from inside the attempt.
        void this.closeEntry(entry).catch(() => {});
      }
      throw error;
    }
  }
  private closeEntry(entry: Entry<T>): Promise<void> {
    if (entry.closing) return entry.closing;
    entry.state = "closing";
    if (entry.packageHandle) this.handles.delete(entry.packageHandle);
    const attempt = (async () => {
      await this.options.jobs.closeContext(entry.context);
      entry.requests.clear();
      if (entry.packageHandle)
        this.options.delivery.revoke({ kind: "package", id: entry.packageHandle });
      await entry.retained?.close();
      if (entry.workspace) await entry.workspace.remove();
      else if (entry.provisionStarted)
        await cleanupFailedPackageWorkspace(
          this.options.parent,
          entry.id,
          entry.provisionFailure,
          this.options.worker,
        );
      entry.input.close();
      entry.admittedBytes = 0;
      entry.state = entry.terminal;
      this.entries.delete(entry.id);
      this.onUpdateProgress?.();
      this.terminal.set(entry.id, this.snapshot(entry));
      while (this.terminal.size > packageRegistryLimits.terminal)
        this.terminal.delete(this.terminal.keys().next().value!);
    })().catch((error) => {
      entry.state = "cleanup_failed";
      entry.error = describe(error);
      throw error;
    });
    entry.closing = attempt;
    void attempt
      .finally(() => {
        delete entry.closing;
      })
      .catch(() => {});
    return attempt;
  }
}
