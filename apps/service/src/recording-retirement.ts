import type { CaptureSources } from "./capture-sources.js";
import type { CaptureStore } from "@yap/core/capture-store";
import type { JobQueue } from "@yap/core/jobs";
import type { CaptureService } from "./capture.js";
import type { DerivativeDelivery } from "./delivery.js";
import type { ManagedFiles } from "./managed-files.js";
import type { DeletionRegistration, LibrarySubject } from "./library-deletion.js";
import type { LibraryUsers } from "@yap/core/library-users";
import { CatalogError } from "@yap/core/catalog";
import { hasUsers } from "./asset-retirement.js";

export type RecordingRetirementOwners = {
  store: CaptureStore;
  jobs: JobQueue;
  capture: Pick<CaptureService, "quiesce">;
  delivery: DerivativeDelivery;
  files: Pick<ManagedFiles, "removeRecordingDirectory">;
  sources: CaptureSources;
  users: Pick<LibraryUsers, "usersOf">;
  freedBytes?: (id: string, cascade: boolean) => number;
};

export function recordingRetirement(owners: RecordingRetirementOwners): DeletionRegistration {
  return {
    kind: "recording",
    errorMode: "preserve-catalog",
    checkUsers: (subject, cascade) => {
      const result = owners.users.usersOf({ kind: "recording", id: subject.id });
      if (!cascade && hasUsers(result, { excludeAcquisitions: true }))
        throw new CatalogError("IN_USE", "Recording is still used by the library", {
          recordingId: subject.id,
          ...result,
        });
      return [
        ...result.usedBy.map((project) => ({ memberKind: "project", memberId: project.projectId })),
        ...result.acquisitions.map((acquisition) => ({
          memberKind: "acquisition",
          memberId: acquisition.acquisitionId,
        })),
      ];
    },
    tombstone: (subject) => {
      const recording = owners.store.markDeleting(subject.id);
      if (recording) owners.delivery.revoke({ kind: "recording", id: subject.id });
      return recording !== null;
    },
    scope: (subject, signal, run) => owners.sources.retire(subject.id, signal, run),
    beforeScope: async (subject, signal) => {
      await owners.jobs.drainOwner({ kind: "recording", recordingId: subject.id });
      signal.throwIfAborted();
    },
    drain: async (subject, signal) => {
      await owners.capture.quiesce(subject.id);
    },
    files: (subject, signal, lifetime) =>
      owners.files.removeRecordingDirectory(subject.id, signal, lifetime),
    rows: async (subject, signal) => {
      signal.throwIfAborted();
      if (!owners.store.deleting(subject.id)) {
        owners.store.finishDeletion(subject.id);
        return true;
      }
      owners.sources.forget(subject.id);
      await owners.jobs.forgetOwner({ kind: "recording", recordingId: subject.id });
      signal.throwIfAborted();
      owners.store.finishDeletion(subject.id);
      return true;
    },
    cascadeMembers: async (_subject, members, signal, deleteMember) => {
      for (const member of members) {
        signal.throwIfAborted();
        await deleteMember({ kind: member.memberKind, id: member.memberId });
      }
    },
    cascadeMembersWithoutCascade: true,
    markersPage: (afterId = "") => {
      const page = owners.store.deletionsPage(afterId);
      return {
        subjects: page.recordings.map(
          (recording) =>
            ({
              kind: "recording",
              id: recording.recordingId,
            }) satisfies LibrarySubject,
        ),
        nextAfterId: page.nextAfterId,
      };
    },
    result: (subject) => ({ recordingId: subject.id, deleted: true }),
    freedBytes: (subject, cascade) => owners.freedBytes?.(subject.id, cascade) ?? 0,
  };
}
