import type { AcquisitionImporter, AcquisitionStore } from "@yap/core/acquisitions";
import type { Catalog } from "@yap/core/catalog";
import type { JobQueue } from "@yap/core/jobs";
import { ResourceReferences } from "@yap/core/references";
import type { DeletionRegistration } from "./library-deletion.js";

export type AcquisitionRetirementOwners = {
  catalog: Catalog;
  store: AcquisitionStore;
  importer: Pick<AcquisitionImporter, "purge">;
  jobs: JobQueue;
};

/** One acquisition retirement path shared by coordinator cascades. */
export function acquisitionRetirement(owners: AcquisitionRetirementOwners): DeletionRegistration {
  const references = new ResourceReferences(owners.catalog);
  return {
    kind: "acquisition",
    errorMode: "delete-failed",
    tombstone: (subject) => {
      try {
        owners.store.intent(subject.id);
        return true;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "NOT_FOUND") return false;
        throw error;
      }
    },
    checkUsers: (subject) =>
      references
        .dependencies({ kind: "acquisition", id: subject.id })
        .filter((resource) => resource.kind === "asset")
        .map((resource) => ({ memberKind: "asset", memberId: resource.id })),
    drain: (subject) => owners.jobs.drainOwner({ kind: "acquisition", acquisitionId: subject.id }),
    files: (subject, signal) => owners.importer.purge(subject.id, signal),
    rows: async (subject, signal) => {
      signal.throwIfAborted();
      await owners.jobs.forgetOwner({ kind: "acquisition", acquisitionId: subject.id });
      if (references.releaseOwnerPage({ kind: "acquisition", id: subject.id }) === 256)
        return false;
      const resources = owners.catalog.catalog
        .prepare(
          "DELETE FROM resource_references WHERE rowid IN (SELECT rowid FROM resource_references WHERE resourceKind='acquisition' AND resourceId=? LIMIT 256)",
        )
        .run(subject.id);
      if (Number(resources.changes) === 256) return false;
      owners.catalog.catalog.prepare("DELETE FROM acquisitions WHERE id=?").run(subject.id);
      return true;
    },
    cascadeMembers: async (_subject, members, signal, deleteMember) => {
      for (const member of members) {
        signal.throwIfAborted();
        if (member.memberKind !== "asset") continue;
        if (references.isTombstoned("asset", member.memberId)) continue;
        // Content-addressed assets can be shared by an independent import. Keep the
        // shared asset (and that import) while retiring this acquisition; otherwise
        // let the registered asset owner cascade through its remaining users.
        if (
          references.owners("asset", member.memberId).some((owner) => owner.kind === "acquisition")
        )
          continue;
        await deleteMember({ kind: member.memberKind, id: member.memberId });
      }
    },
    result: (subject) => ({ acquisitionId: subject.id, deleted: true }),
    markersPage: () => ({ subjects: [], nextAfterId: null }),
  } satisfies DeletionRegistration;
}
