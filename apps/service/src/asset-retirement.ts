import type { AssetStore } from "@yap/core/assets";
import type { AlignmentEvidenceStore } from "@yap/core/alignment-evidence";
import type { Catalog } from "@yap/core/catalog";
import type { DerivedCache } from "@yap/core/cache";
import type { JobQueue } from "@yap/core/jobs";
import type { LibraryUsers, LibraryUsersResult } from "@yap/core/library-users";
import type { SceneEvidenceStore } from "@yap/core/scene-evidence";
import type { ScreenshotIndexStore } from "@yap/core/screenshot-index";
import type { SourceIndexRecords } from "@yap/core/source-index";
import type { SpeakerEvidenceStore } from "@yap/core/speaker-evidence";
import type { TranscriptStore } from "@yap/core/transcript";
import type { ImportedTranscriptStore } from "@yap/core/imported-transcript";
import { ResourceReferences } from "@yap/core/references";
import type { DerivativeDelivery } from "./delivery.js";
import type { ManagedFiles } from "./managed-files.js";
import type { DeletionRegistration } from "./library-deletion.js";
import { CatalogError as CoreCatalogError } from "@yap/core/catalog";

export type AssetRetirementOwners = {
  catalog: Catalog;
  assets: AssetStore;
  users: LibraryUsers;
  transcripts: TranscriptStore;
  importedTranscripts: ImportedTranscriptStore;
  scenes: SceneEvidenceStore;
  indexes: ScreenshotIndexStore<SourceIndexRecords>;
  alignments: AlignmentEvidenceStore;
  speakers: SpeakerEvidenceStore;
  cache: DerivedCache;
  jobs: JobQueue;
  files: Pick<ManagedFiles, "removeCacheFiles">;
  delivery: DerivativeDelivery;
};

type Member = { memberKind: string; memberId: string };

function membersFor(result: LibraryUsersResult): Member[] {
  return [
    ...result.usedBy.map((project) => ({ memberKind: "project", memberId: project.id })),
    ...result.acquisitions.map((acquisition) => ({
      memberKind: "acquisition",
      memberId: acquisition.id,
    })),
    ...result.derivedAssets.map((asset) => ({ memberKind: "asset", memberId: asset.id })),
  ];
}

/** Retires an immutable asset and every retained generation owned by it. */
export function assetRetirement(owners: AssetRetirementOwners): DeletionRegistration {
  const references = new ResourceReferences(owners.catalog);
  return {
    kind: "asset",
    errorMode: "preserve-catalog",
    checkUsers: (subject, cascade) => {
      const result = owners.users.usersOf({ kind: "asset", id: subject.id });
      if (!cascade && owners.users.hasUsers(result))
        throw new CoreCatalogError("IN_USE", "Asset is still used by the library", {
          assetId: subject.id,
          ...result,
        });
      return membersFor(result);
    },
    tombstone: (subject) => {
      if (!owners.assets.has(subject.id)) return false;
      owners.delivery.revoke({ kind: "asset", id: subject.id });
      return true;
    },
    drain: async (subject, signal) => {
      await owners.jobs.drainOwner({ kind: "asset", id: subject.id });
      signal.throwIfAborted();
    },
    files: async (subject, signal) => {
      await owners.assets.unlinkFile(subject.id);
      signal.throwIfAborted();
      await owners.transcripts.purge({ kind: "asset", id: subject.id }, signal);
      await owners.importedTranscripts.purge(subject.id, signal);
      await owners.scenes.purge({ kind: "asset", id: subject.id }, signal);
      await owners.indexes.purge({ kind: "asset", id: subject.id }, signal);
      await owners.alignments.purge(subject.id, signal);
      await owners.speakers.purge(subject.id, signal);
      await owners.cache.purgeOwner({ kind: "asset", id: subject.id }, (batch) =>
        owners.files.removeCacheFiles(batch.ids, batch.root, signal),
      );
    },
    rows: async (subject, signal) => {
      signal.throwIfAborted();
      await owners.jobs.forgetOwner({ kind: "asset", id: subject.id });
      if (references.releaseOwnerPage({ kind: "asset", id: subject.id }) === 256) return false;
      if (references.releaseResourcePage("asset", subject.id) === 256) return false;
      const origins = owners.catalog.catalog
        .prepare(
          "DELETE FROM asset_origins WHERE rowid IN (SELECT rowid FROM asset_origins WHERE assetId=? LIMIT 256)",
        )
        .run(subject.id);
      if (Number(origins.changes) === 256) return false;
      owners.catalog.transaction(() => {
        owners.catalog.catalog.prepare("DELETE FROM assets WHERE id=?").run(subject.id);
      });
      references.unfence("asset", [subject.id]);
      return true;
    },
    cascadeMembers: async (_subject, members, signal, deleteMember) => {
      for (const member of members) {
        signal.throwIfAborted();
        await deleteMember({ kind: member.memberKind, id: member.memberId });
      }
    },
    result: (subject) => ({ assetId: subject.id, deleted: true }),
    freedBytes: (subject, cascade) => {
      const users = owners.users.usersOf({ kind: "asset", id: subject.id });
      return cascade ? users.cascadeFreesBytes : users.freesBytes;
    },
  };
}
