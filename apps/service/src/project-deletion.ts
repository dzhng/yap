import { setImmediate } from "node:timers/promises";
import { CatalogError } from "@yap/core/catalog";
import type { ProjectStore } from "@yap/core/projects";
import type { DerivedCache } from "@yap/core/cache";
import type { DerivativeDelivery } from "./delivery.js";
import type { MediaExports } from "./exports.js";
import type { ManagedFiles } from "./managed-files.js";
import type { JobQueue } from "@yap/core/jobs";
import type { ScreenshotIndexStore } from "@yap/core/screenshot-index";
import type { ProjectIndexRecords } from "@yap/core/project-index";

type Deleted = { projectId: string; deleted: true };

/** Orders current project resource owners; retained revisions journal unfinished retirement. */
export class ProjectDeletion {
  onUpdateProgress: (() => void) | undefined;
  get updateBlocked(): boolean {
    return this.active.size > 0;
  }
  private readonly active = new Map<string, Promise<Deleted>>();
  private readonly lifetime = new AbortController();
  constructor(
    private readonly store: ProjectStore,
    private readonly jobs: JobQueue,
    private readonly cache: DerivedCache,
    private readonly files: Pick<ManagedFiles, "removeCacheFiles">,
    private readonly delivery: DerivativeDelivery,
    private readonly exports: Pick<MediaExports, "retireOwner">,
    private readonly index: ScreenshotIndexStore<ProjectIndexRecords>,
  ) {}

  delete(projectId: string): Promise<Deleted> {
    if (this.lifetime.signal.aborted)
      throw new CatalogError("SERVICE_STOPPED", "Project deletion is closed", {});
    const existing = this.active.get(projectId);
    if (existing) return existing;
    if (!this.store.markDeleting(projectId)) return Promise.resolve({ projectId, deleted: true });
    this.delivery.revoke({ kind: "project", id: projectId });
    const result = this.remove(projectId).finally(() => {
      this.active.delete(projectId);
      this.onUpdateProgress?.();
    });
    this.active.set(projectId, result);
    return result;
  }

  private async remove(projectId: string): Promise<Deleted> {
    try {
      const owner = { kind: "project" as const, projectId };
      await this.jobs.drainOwner(owner);
      this.lifetime.signal.throwIfAborted();
      await this.exports.retireOwner(owner, this.lifetime.signal);
      this.lifetime.signal.throwIfAborted();
      await this.index.reclaim(owner, () => false, this.lifetime.signal);
      this.lifetime.signal.throwIfAborted();
      await this.cache.purgeOwner(owner, ({ ids, root }) =>
        this.files.removeCacheFiles(ids, root, this.lifetime.signal),
      );
      this.lifetime.signal.throwIfAborted();
      await this.jobs.forgetOwner(owner);
      for (;;) {
        this.lifetime.signal.throwIfAborted();
        if (this.store.finishDeletionPage(projectId)) break;
        await setImmediate();
      }
      return { projectId, deleted: true };
    } catch (error) {
      throw new CatalogError(
        "DELETE_FAILED",
        `Project deletion could not finish: ${error instanceof Error ? error.message : String(error)}`,
        { projectId },
      );
    }
  }

  async resume(reportFailure: (error: unknown) => void): Promise<void> {
    let afterId: string | undefined;
    while (!this.lifetime.signal.aborted) {
      const page = this.store.deletionsPage(afterId);
      for (const projectId of page.projectIds) {
        if (this.lifetime.signal.aborted) return;
        try {
          await this.delete(projectId);
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
