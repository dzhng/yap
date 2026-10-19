import { realpathSync } from "node:fs";
import { join } from "node:path";
import { AcquisitionStore } from "@yap/core/acquisitions";
import { CatalogError } from "@yap/core/catalog";
import { CaptureStore, type Recording } from "@yap/core/capture-store";
import { JobQueue } from "@yap/core/jobs";
import type { ManagedFiles } from "./managed-files.js";
import { sourceDirectory } from "./capture.js";
import { operationFailure } from "./operation-errors.js";
import type { OperationFailure } from "@yap/protocol";

export type CaptureSourceAdmission = {
  kind: "primary" | "camera";
  sourceId: string;
  publication: NonNullable<Recording["publication"]>["primary"];
  acquisitionId: string | null;
  job: ReturnType<JobQueue["inspect"]> | null;
  admissionError: OperationFailure["error"] | null;
};

/** Owns capture-source admission and donor retirement on the shared acquisition transaction and queue. */
export class CaptureSources {
  private readonly retiring = new Map<string, number>();
  private readonly recordings: string;
  constructor(
    private readonly captures: CaptureStore,
    private readonly acquisitions: AcquisitionStore,
    private readonly jobs: JobQueue,
    private readonly home: string,
    private readonly files: Pick<ManagedFiles, "recordingDirectory" | "removeRecordingDirectory">,
  ) {
    this.recordings = join(realpathSync(home), "recordings");
  }

  resume(): void {
    let failed = false;
    let failure: unknown;
    for (const { recordingId, sourceId, kind } of this.acquisitions.pendingCaptureSources(
      this.captures,
    )) {
      if (this.retiring.has(recordingId)) continue;
      try {
        this.jobs.submit(() => {
          const intent = this.acquisitions.admitCapture(
            this.captures,
            recordingId,
            sourceDirectory(this.home, recordingId, kind),
            sourceId,
          );
          return {
            target: { kind: "acquisition", id: intent.acquisitionId },
            artifact: "acquisition.import",
            lane: "heavy",
            input: "capture",
          };
        });
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
    if (failed) throw failure;
  }

  /** Ready acquisitions own their originals; every unfinished managed donor must remain available. */
  available(acquisitionId: string): boolean {
    const donors = this.acquisitions.recordingDonors(acquisitionId, this.recordings);
    if (!donors.length) return true;
    if (
      !donors.every(
        (recordingId) => !this.retiring.has(recordingId) && this.captures.isAvailable(recordingId),
      )
    )
      return false;
    const intent = this.acquisitions.intent(acquisitionId);
    if (intent.kind === "capture") {
      try {
        this.captures.publishedSource(intent.recordingId, intent.sourceId);
      } catch (error) {
        if (
          error instanceof CatalogError &&
          ["NOT_READY", "UNAVAILABLE", "NOT_FOUND"].includes(error.code)
        )
          return false;
        throw error;
      }
    }
    return true;
  }

  private *unfinishedJobs(recordingId: string): Generator<string[]> {
    let afterId = "";
    for (;;) {
      const imports = this.acquisitions.unfinishedRecordingImports(
        recordingId,
        this.recordings,
        afterId,
      );
      if (!imports.length) return;
      yield imports.flatMap((intent) => {
        const { jobId } = this.jobs.status({
          target: { kind: "acquisition", id: intent.acquisitionId },
          artifact: "acquisition.import",
          input: intent.kind === "capture" ? "capture" : JSON.stringify(intent.files),
        });
        return jobId ? [jobId] : [];
      });
      afterId = imports.at(-1)!.acquisitionId;
    }
  }

  /** Cancel can lose to completed capture, so its transient fence cannot author a terminal state. */
  async retire<T>(
    recordingId: string,
    signal: AbortSignal,
    action: (lifetime: { readonly fd: number } | undefined) => Promise<T>,
  ): Promise<T> {
    this.retiring.set(recordingId, (this.retiring.get(recordingId) ?? 0) + 1);
    try {
      let failed = false;
      let failure: unknown;
      for (const jobs of this.unfinishedJobs(recordingId)) {
        const stopped = await Promise.allSettled(jobs.map((jobId) => this.jobs.drainJob(jobId)));
        for (const result of stopped)
          if (result.status === "rejected") {
            if (!failed) failure = result.reason;
            failed = true;
          }
      }
      if (failed) throw failure;
      signal.throwIfAborted();
      const lifetime = await this.files
        .recordingDirectory(recordingId, signal)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
      try {
        signal.throwIfAborted();
        return await action(lifetime?.handle);
      } finally {
        await lifetime?.handle.close();
      }
    } finally {
      const remaining = this.retiring.get(recordingId)! - 1;
      if (remaining === 0) this.retiring.delete(recordingId);
      else this.retiring.set(recordingId, remaining);
    }
  }

  forget(recordingId: string): void {
    for (const jobs of this.unfinishedJobs(recordingId))
      for (const jobId of jobs) this.jobs.forgetJob(jobId);
  }

  discard(
    recordingId: string,
    signal: AbortSignal,
    action: () => Promise<Recording>,
  ): Promise<Recording> {
    return this.retire(recordingId, signal, async (lifetime) => {
      const recording = await action();
      if (recording.state === "canceled") {
        await this.files.removeRecordingDirectory(recordingId, signal, lifetime);
        this.forget(recordingId);
      }
      return recording;
    });
  }

  describe(
    snapshot: Pick<Recording, "id">,
  ): Recording & { sourceAdmissions: CaptureSourceAdmission[] } {
    const recording = this.captures.get(snapshot.id);
    if (!recording.publication?.inputsClosed || recording.state === "canceled")
      return { ...recording, sourceAdmissions: [] };
    return {
      ...recording,
      sourceAdmissions: [
        this.describeSource(recording, "primary"),
        ...(recording.camera === null ? [] : [this.describeSource(recording, "camera")]),
      ],
    };
  }

  private describeSource(recording: Recording, kind: "primary" | "camera"): CaptureSourceAdmission {
    const sourceId = kind === "primary" ? recording.sourceId : recording.camera!.sourceId;
    const publication = recording.publication![kind];
    let intent: ReturnType<AcquisitionStore["captureIntent"]> = null;
    let admissionError: OperationFailure["error"] | null = null;
    try {
      intent = this.acquisitions.captureIntent(sourceId);
    } catch (error) {
      if (!(error instanceof CatalogError) || error.code !== "REQUEST_CONFLICT") throw error;
      // The conflicting row is durable refusal evidence, never this source's acquisition/job.
      admissionError = operationFailure(error).error;
    }
    const status = intent
      ? this.jobs.status({
          target: { kind: "acquisition", id: intent.acquisitionId },
          artifact: "acquisition.import",
          input: "capture",
        })
      : null;
    return {
      kind,
      sourceId,
      publication,
      acquisitionId: intent?.acquisitionId ?? null,
      job: status?.jobId ? this.jobs.inspect(status.jobId) : null,
      admissionError,
    };
  }
}
