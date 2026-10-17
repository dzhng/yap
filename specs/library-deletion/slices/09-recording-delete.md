# 09 recording.delete takes its copies

**Contract (changed).** `recording.delete {recordingId, cascade?}`.
- **Whose copy is it?** A recording's copies are its capture-origin acquisitions:
  primary and camera, keyed by source (`acquisitions.ts:332, 1112-1118`). A user
  import from inside a recording folder (`acquisitions.ts:403-432`) is **not** a
  copy of the take.
- **Unused copies** are retired with the recording.
- **Used copies** make the delete refuse with `IN_USE` (users from slice 04).
  `cascade: true` also deletes those projects.
- **Check before marking.** Users are checked *before* anything is marked as
  deleting (`deletion.ts:34`).
- **Acquisition retirement** is an internal step on `LibraryDeletion`: tombstone,
  purge evidence, release references, delete its assets, remove its directory.
  There is no public operation.
- **Old markers.** A `recording_deletions` row without a plan row resumes with the
  old semantics.

**Run or see.**
- Record or import a fixture take and use it in a project.
- `recording.delete` returns `IN_USE`. With `cascade` the project goes too, and
  `freedBytes` includes the copies.
- An unused take frees its copies.

**Verify.**
- **Rewrite the tests that encode "always succeeds" to the new contract.** Don't
  loosen them:
  - `capture-source-lifetime.test.ts:368`
  - `capture.test.ts:471`
  - `project-capture.test.ts:708`
  - `lifetime.test.ts:385`
  - `deletion.test.ts`
- **New fixtures:**
  - an unused acquisition;
  - an acquisition a project keeps;
  - an import from inside the folder, which survives;
  - an old-format deletion marker resuming.
- **Update** the description at `operations.ts:781`, `apps/service/README.md:88`,
  and the skill catalog.

**Firewall.** Capture source lifetime and native `ManagedFiles` semantics change
only by gaining the new step.

**Delegated.** Internal structure of the acquisition step.
