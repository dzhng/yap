# 03 Deletion fence and publish race

**Contract.**
- **Tombstones for assets and acquisitions** are stored in slice 02's tables.
- **The fence.** While a subject is tombstoned, `ResourceReferences.retain`
  (`references.ts:42`) refuses any new reference to it with
  `DELETE_IN_PROGRESS` (retryable). Every caller is covered: revisions,
  `jobs.retainInputs` (`jobs.ts:1132`), package adoption (`projects.ts:683`) and
  asset publish (`assets.ts:674`).
- **Job admission and `isAvailable`** (`project-service.ts:418-453`) also refuse
  tombstoned assets and acquisitions. `isDeleting` learns both kinds, so
  `jobs.drainOwner` and `jobs.forgetOwner` work for them.
- **The publish race.** Asset file unlink runs under the same per-asset lock as
  `AssetStore.publishFile` (`assets.ts:611-637`). Publishing refuses
  (`DELETE_IN_PROGRESS`) while the asset is tombstoned. This closes the race that
  could leave a row with no file (`assets.ts:611-667`).

**Seam.** `ResourceReferences`, `JobTargets` and `AssetStore`, all in core. Tests
use an in-memory catalog fixture and boot no service.

**Run or see.** A fixture script races an import's publish against a tombstone
and prints whether rows and files still agree.

**Verify.** Red tests first:
- **Latched callers.** Each of the four retain paths (revision, job input,
  adoption, publish) is held at a latch, then the asset is tombstoned and the
  latch released. The late caller is refused and no reference row appears.
- **Two-latch publish/unlink.** Run in both orderings, then restart. There must
  never be a row without a file, or a file without a row.
- **Clearing the tombstone** lets each path succeed again.

**Firewall.** No public operation, and no file deletion beyond what the test
fixture needs. Recording and project markers are untouched.

**Delegated.** Lock helper structure, and the test latch mechanism.

**Stays green.** `assets`, `references`, `jobs` and `projects` tests.
