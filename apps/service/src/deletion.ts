import type { CaptureSources } from "./capture-sources.js";
import type { CaptureStore } from "@yap/core/capture-store";
import { CatalogError } from "@yap/core/catalog";
import type { JobQueue } from "@yap/core/jobs";
import type { CaptureService } from "./capture.js";
import type { DerivativeDelivery } from "./delivery.js";
import type { ManagedFiles } from "./managed-files.js";

type Owners = {
  store: CaptureStore;
  jobs: JobQueue;
  capture: Pick<CaptureService, "quiesce">;
  delivery: DerivativeDelivery;
  files: Pick<ManagedFiles, "removeRecordingDirectory">;
  sources: CaptureSources;
};
type Deleted = { recordingId: string; deleted: true };

/** Orders existing resource owners; the catalog marker is the restart journal. */
export class RecordingDeletion {
  onUpdateProgress: (() => void) | undefined;
  get updateBlocked(): boolean {
    return this.active.size > 0;
  }
  private readonly active = new Map<string, Promise<Deleted>>();
  private readonly lifetime = new AbortController();
  constructor(private readonly owners: Owners) {}

  delete(recordingId: string): Promise<Deleted> {
    if (this.lifetime.signal.aborted)
      throw new CatalogError("SERVICE_STOPPED", "Recording deletion is closed", {});
    const existing = this.active.get(recordingId);
    if (existing) return existing;
    const recording = this.owners.store.markDeleting(recordingId);
    if (!recording) return Promise.resolve({ recordingId, deleted: true });
    this.owners.delivery.revoke({ kind: "recording", id: recordingId });
    const result = this.remove(recordingId).finally(() => {
      this.active.delete(recordingId);
      this.onUpdateProgress?.();
    });
    this.active.set(recordingId, result);
    return result;
  }

  private async remove(recordingId: string): Promise<Deleted> {
    const { jobs, capture, sources } = this.owners;
    const signal = this.lifetime.signal;
    try {
      await jobs.drainOwner({ kind: "recording", recordingId });
      return await sources.retire(recordingId, signal, async (lifetime) => {
        await capture.quiesce(recordingId);
        return this.reclaim(recordingId, signal, lifetime);
      });
    } catch (error) {
      if (error instanceof CatalogError)
        throw new CatalogError(error.code, error.message, { ...error.details, recordingId });
      throw new CatalogError(
        "DELETE_FAILED",
        `Recording deletion could not finish: ${error instanceof Error ? error.message : String(error)}`,
        { recordingId },
      );
    }
  }

  private async reclaim(
    recordingId: string,
    signal: AbortSignal,
    lifetime?: { readonly fd: number },
  ): Promise<Deleted> {
    const { jobs, store, files, sources } = this.owners;
    await files.removeRecordingDirectory(recordingId, signal, lifetime);
    signal.throwIfAborted();
    sources.forget(recordingId);
    await jobs.forgetOwner({ kind: "recording", recordingId });
    signal.throwIfAborted();
    store.finishDeletion(recordingId);
    return { recordingId, deleted: true };
  }

  async resume(reportFailure: (error: unknown) => void): Promise<void> {
    let afterId: string | undefined;
    while (!this.lifetime.signal.aborted) {
      const page = this.owners.store.deletionsPage(afterId);
      for (const recording of page.recordings) {
        if (this.lifetime.signal.aborted) return;
        try {
          await this.delete(recording.recordingId);
        } catch (error) {
          reportFailure(error);
        }
      }
      if (page.nextAfterId === null) return;
      afterId = page.nextAfterId;
    }
  }

  async close(): Promise<void> {
    this.lifetime.abort();
    await Promise.allSettled(this.active.values());
  }
}
