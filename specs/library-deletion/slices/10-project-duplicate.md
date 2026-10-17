# 10 project.duplicate

**Contract.** `project.duplicate {requestId, projectId, revisionId?, title?}`.
- **What it makes.** A new project whose first and only revision is that revision's
  document. `revisionId` defaults to the head revision, and `title` defaults to the
  source title plus " copy".
- **What it doesn't copy.** Undo history, request IDs, export intents and the
  screenshot index all start empty. Prepared audio and project-owned index
  references are re-derived, never copied, because they resolve through the
  source project (`prepared-audio.ts:388-404`, `projects.ts:774-778`).
- **References follow from the document.** Asset and acquisition references are
  taken again from the document, as `insertRevision` does.
- **Replay.** Replaying the same `requestId` returns the same project. Replaying it
  with different arguments returns `REQUEST_CONFLICT`.
- **Naming clash.** The help text distinguishes this operation from the clip-level
  `duplicate` edit in `edit.apply`.

**Seam.** `ProjectStore.duplicate` in core, plus the operation handler.

**Run or see.**
1. Duplicate a project that has undo history.
2. `revision.history` on the copy shows exactly one revision.
3. Delete the source project. The copy still previews.

**Verify.** Red tests first:
- the document is identical;
- the history is empty;
- after duplicating, `usersOf` reports the copy using only clips that are still in
  its document (the free-a-clip case);
- the copy keeps working after the source is deleted;
- replay and conflict;
- a failure partway leaves no half-created project.

**Same slice:** catalog entry and help text.

**Firewall.** No editorial changes, and no cascade involvement.

**Delegated.** The default title wording.
