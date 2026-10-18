import type { Catalog } from "@yap/core/catalog";
import type { ProjectStore } from "@yap/core/projects";
import type { DerivedCache } from "@yap/core/cache";
import type { DerivativeDelivery } from "./delivery.js";
import type { MediaExports } from "./exports.js";
import type { ManagedFiles } from "./managed-files.js";
import type { JobQueue } from "@yap/core/jobs";
import type { ScreenshotIndexStore } from "@yap/core/screenshot-index";
import type { ProjectIndexRecords } from "@yap/core/project-index";
import type { DeletionRegistration, LibrarySubject } from "./library-deletion.js";

export type ProjectRetirementOwners = {
  catalog: Catalog;
  store: ProjectStore;
  jobs: JobQueue;
  cache: DerivedCache;
  files: Pick<ManagedFiles, "removeCacheFiles">;
  delivery: DerivativeDelivery;
  exports: Pick<MediaExports, "retireOwner">;
  index: ScreenshotIndexStore<ProjectIndexRecords>;
  freedBytes: (id: string) => number;
};

export function projectRetirement(owners: ProjectRetirementOwners): DeletionRegistration {
  return {
    kind: "project",
    errorMode: "delete-failed",
    tombstone: (subject) => {
      const retained = owners.store.markDeleting(subject.id);
      if (retained) owners.delivery.revoke({ kind: "project", id: subject.id });
      return retained;
    },
    drain: async (subject, signal) => {
      const owner = { kind: "project" as const, projectId: subject.id };
      await owners.jobs.drainOwner(owner);
      signal.throwIfAborted();
      await owners.exports.retireOwner(owner, signal);
      signal.throwIfAborted();
    },
    files: async (subject, signal) => {
      const owner = { kind: "project" as const, projectId: subject.id };
      await owners.index.reclaim(owner, () => false, signal);
      signal.throwIfAborted();
      await owners.cache.purgeOwner(owner, ({ ids, root }) =>
        owners.files.removeCacheFiles(ids, root, signal),
      );
      signal.throwIfAborted();
    },
    rows: async (subject, signal) => {
      signal.throwIfAborted();
      await owners.jobs.forgetOwner({ kind: "project", projectId: subject.id });
      return owners.store.finishDeletionPage(subject.id);
    },
    markersPage: (afterId = "") => {
      const page = owners.store.deletionsPage(afterId);
      return {
        subjects: page.projectIds.map((id) => ({ kind: "project", id }) satisfies LibrarySubject),
        nextAfterId: page.nextAfterId,
      };
    },
    result: (subject) => ({ projectId: subject.id, deleted: true }),
    freedBytes: (subject) => owners.freedBytes(subject.id),
  };
}
