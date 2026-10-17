# 04 Who uses this?

**Contract.**
- **The query.** `LibraryUsers.usersOf({kind: "asset"|"acquisition"|"recording", id})`
  returns:
  `{usedBy: [{kind: "project", projectId, title, revisions}], acquisitions: [...], derivedAssets: [...], freesBytes, cascadeFreesBytes}`.
- **Revisions are reported per project.** Revisions, including undo history,
  collapse into their project (`projects.ts:796-801`). Projects already being
  deleted are skipped.
- **Derived assets** (HDR conversion `asset-conversion.ts:267`, voice
  `voice-generation.ts:315`) are followed back to their source through
  `ResourceReferences` owners (`assets.ts:674-680`).
- **Jobs are never reported as users.** They're drained.
- **Byte counts.** `freesBytes` covers the subject and its own derived files.
  `cascadeFreesBytes` adds every user that a cascade would delete.
- **The details shape.** `inUseDetailsSchema` in protocol is the only shape any
  `IN_USE` refusal carries.

**Seam.** A read-only core module, tested against a seeded catalog fixture.

**Run or see.** A fixture script prints `usersOf` for the seeded cases below.

**Verify.** Red tests first, with seeded fixtures for:
- a clip held only by undo history;
- a clip used in two projects;
- a derived chain (source → HDR conversion → used in a project);
- a project that is already being deleted;
- a capture acquisition used by a project.

Assert the byte counts against the actual files.

**Firewall.** Read-only: no deletion, no public operation.

**Delegated.** Query structure and caching.

**Would change this slice.** The user wanting per-revision detail in refusals.
The decision so far is project-level only, with a revision count.
