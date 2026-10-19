import { join } from "node:path";
import { lstat, type FileHandle } from "node:fs/promises";
import { CatalogError } from "@yap/core/catalog";
import { openDirectoryLease } from "@yap/core/files";
import type { CaptureStore } from "@yap/core/capture-store";
import { isSettled } from "@yap/core/capture-store";
import type { JobExecution, JobQueue } from "@yap/core/jobs";
import { nativeResult, MAX_MEDIA_TIMEOUT_MS, type MediaWorker } from "./worker.js";
import { publicationDeadlineMs } from "./publication.js";

const artifact = "capture-cleanup";
type RoleResult = {
  role: "narration" | "system";
  outcome: "removed" | "alreadyClear" | "retained";
  reason: string | null;
};
function cleanupResult(value: unknown): RoleResult[] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    value.some(
      (row, i) =>
        !row ||
        typeof row !== "object" ||
        row.role !== ["narration", "system"][i] ||
        !["removed", "alreadyClear", "retained"].includes(row.outcome) ||
        !(row.reason == null || (typeof row.reason === "string" && row.reason.length <= 256)),
    )
  )
    throw new CatalogError(
      "INVALID_NATIVE_RESPONSE",
      "Cleanup did not report both recording audio roles",
    );
  return value.map(({ role, outcome, reason }) => ({ role, outcome, reason: reason ?? null }));
}

/** Recording lifetime and queue ownership stay shared with source processing and deletion. */
export class CaptureCleanup {
  constructor(
    private readonly store: CaptureStore,
    private readonly jobs: JobQueue,
    private readonly home: string,
    private readonly worker: MediaWorker,
  ) {}

  request(recordingId: string) {
    const recording = this.store.get(recordingId);
    const job = this.jobs.submit({
      target: { kind: "recording", id: recordingId, revisionId: null },
      artifact,
      lane: "heavy",
      input: recording.sourceId,
    });
    return this.jobs.work(job.jobId);
  }

  async execute({ job, signal }: JobExecution): Promise<string> {
    if (
      job.artifact !== artifact ||
      job.target.kind !== "recording" ||
      job.target.revisionId !== null
    )
      throw new CatalogError("UNSUPPORTED_JOB", "Cleanup requires a recording-owned source job");
    const recording = this.store.get(job.target.id);
    if (
      !isSettled(recording.state) ||
      recording.state === "canceled" ||
      this.store.isDeleting(recording.id)
    )
      throw new CatalogError("INVALID_STATE", "Cleanup requires a settled available recording");
    if (recording.sourceId !== job.input)
      throw new CatalogError("SOURCE_CHANGED", "Cleanup source differs from its pinned recording");
    const root = join(this.home, "recordings", recording.id);
    let lease: FileHandle | undefined;
    try {
      lease = await openDirectoryLease(root, "shared");
      signal.throwIfAborted();
      const directory = join(root, "source");
      let bytes = 0;
      for (const name of [
        "capture.journal.jsonl",
        "narration.mov",
        "system.mov",
        "narration.packed.mov",
        "system.packed.mov",
      ]) {
        const info = await lstat(join(directory, name)).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (info?.isFile()) bytes += info.size;
      }
      const value = cleanupResult(
        nativeResult(
          await this.worker(
            "media.cleanupCapture",
            { directory, sourceId: recording.sourceId },
            {
              signal,
              descriptors: [lease.fd],
              timeoutMs: Math.min(MAX_MEDIA_TIMEOUT_MS, 1_200_000 + publicationDeadlineMs(bytes)),
            },
          ),
        ),
      );
      signal.throwIfAborted();
      return JSON.stringify({
        recordingId: recording.id,
        sourceId: recording.sourceId,
        roles: value,
      });
    } catch (error) {
      if (
        !(error instanceof CatalogError) &&
        ["EACCES", "EPERM", "EIO", "EAGAIN", "EWOULDBLOCK"].includes(
          (error as NodeJS.ErrnoException)?.code ?? "",
        )
      )
        throw new CatalogError(
          "CLEANUP_UNAVAILABLE",
          "Cannot access recording cleanup inputs; retry after access is restored",
          {},
        );
      throw error;
    } finally {
      await lease?.close();
    }
  }
}
