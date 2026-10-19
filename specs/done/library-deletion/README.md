# Library deletion and one rule per API concept

Everything a user thinks of as "a video in Yap" can be deleted, and deleting it
frees the space: imported videos (assets), recordings with the copies made from
them, projects and models. Before this, imported videos and models could not be
deleted, deleting a recording left the copies a project had made of it, and the
storage total left out models, which were 95% of a real library.

The same work gave the public API one rule per concept (paging, async state,
identity and replay, errors, naming), so the new operations follow the rules
from their first version. It shipped in 0.1.60 as a breaking change for scripts,
with no compatibility aliases. [choices.md](choices.md) is the decision-by-decision
record, including what each review found.

## The delete rule

One rule covers what other things can use, `asset.delete` and `recording.delete`.
Nothing uses a project, so `project.delete` never refuses and takes no `cascade`; it
shares the same ordering, result shape and replay.

- **A delete refuses with `IN_USE` while anything uses the subject.** The details
  (`inUseDetailsSchema`, `packages/protocol/src/in-use.ts`) list the users and the
  bytes a plain delete (`freesBytes`) and a cascade (`cascadeFreesBytes`) would free.
  A non-retryable refusal: waiting doesn't change it, the caller has to decide.
- **`cascade: true` deletes the users as well, as they are when it runs.** There is
  no preview token to echo back: an item gaining a new user between the refusal and
  the cascade is rare, and the token's machinery was judged not worth it.
- **A subject's own derived data always goes with it** (transcripts, evidence,
  caches). Users are whole projects, each reported once with its revision count;
  derived assets (HDR conversions, generated voice); and, for an asset, the
  acquisition that holds it. A recording's own acquisitions are not users. Every
  revision counts, undo history included, and nothing is pruned.
- **The result is `{<noun>Id, deleted: true, freedBytes}`,** and `freedBytes` is the
  storage the delete actually removed: on a real library, `storage.usage` falls by
  exactly that much at every step.

Why refuse rather than edit: the product makes no editorial decisions. Yap never
edits a clip out of a project to free it, and a cascade only ever deletes whole
users. Deleting removes Yap's own copies; the user's original files and committed
exports are never touched. `project.duplicate` exists so a user can keep a cut
while freeing a clip that only old history holds.

## Principles and invariants

- **One coordinator orders every delete.** `LibraryDeletion`
  (`apps/service/src/library-deletion.ts`) runs check → plan → tombstone → drain →
  files → rows for every subject; each kind registers its steps
  (`*-retirement.ts` beside it). Plans live in new tables owned by `DeletionPlans`
  (`packages/core/src/deletion-plans.ts`), so an interrupted delete resumes after a
  restart and replays answer from the durable row.
- **Nothing can start using what is being deleted.** From the tombstone on,
  `ResourceReferences.retain` (`packages/core/src/references.ts`), job admission and
  asset publish refuse new uses. A recording's own acquisitions and their assets are
  fenced at the recording's tombstone, so a plain delete can't be overtaken by a
  project that starts using its copy mid-delete.
- **A cascade deletes only what the refusal could list.** Members inherit the parent's
  mode: a plain parent keeps its members plain, so a member that gained a user
  refuses instead of cascading. An asset cascade retires its acquisition without
  taking the acquisition's other assets.
- **Cascade is part of a delete's identity.** A request whose `cascade` differs from a
  planned or running delete of the same subject refuses `REQUEST_CONFLICT`.
- **One owner answers "who uses this?" and "how much would this free?"**
  `LibraryUsers` (`packages/core/src/library-users.ts`) owns `usersOf`, `hasUsers` and
  the byte counts. The refusal, the result and `media.list`'s sizes all ask it.
- **Model removal is one flight per model, and only an explicit `model.prepare`
  clears it.** `Models.remove` (`packages/core/src/models.ts`) refuses
  `MODEL_IN_USE` while a running job pins the model's content digest
  (`JobQueue.runsModel`). Transcription, rendered speech and voice pin it in their job
  input, speaker and alignment inside `engine`. The removal persists in
  `model_removals`, so startup auto-prepare stays away from a removed model.
- **The catalog format stays 29.** New state goes only in new tables created
  idempotently; no existing table is altered. Recording and project tombstones written
  by earlier releases have no plan; they are adopted as plain plans without members and
  resume through the coordinator with their old meaning.

## The API rules

Each concept has one owner, and the operation schemas are the reference:

- **Paging:** `cursor` is the previous page's opaque `nextCursor`; `limit` is 1–1000,
  default 100. `pageParams`/`pageResult` (`packages/protocol/src/paging.ts`) shape the
  schemas, and `pageCursor` (`packages/core/src/page-cursor.ts`) binds each cursor to
  its operation and filters. Library listings are newest first.
- **Async state:** one vocabulary, `workStateSchema` (`packages/protocol/src/work.ts`),
  mapped from the owners' stored words at the service edge by one response-wide rewriter
  (see [Sharp edges](#sharp-edges-known-accepted)); `job.get`, `job.retry` and
  `job.cancel` own polling and recovery, replacing the ten `*.retry` operations. A
  take keeps its own capture lifecycle (`finalizing`, `complete`, `interrupted`).
- **Identity and replay:** every operation that creates or changes something takes a
  `requestId`; repeating it returns the first result, and reusing it with different
  parameters refuses `REQUEST_CONFLICT`. Read-only operations, and operations whose
  repeat joins the same work or changes nothing, take none; `naming.test.ts` holds every
  operation to one of the three.
- **Errors:** each code has one category and one retryability, both in
  `packages/protocol/src/refusal-ledger.json`, which the protocol tests hold to every
  literal in product source.
- **Naming:** identities are `<noun>Id` and quantities carry their unit
  (`packages/protocol/src/naming.ts`). The lint checks numeric keys whose last word names
  a quantity, outside the edit document and export settings that `@yap/composition` owns.
  Renames happen at the producer, and old stored shapes refuse `ARTIFACT_CHANGED` and are
  regenerated, not migrated. Three translations remain on purpose: one typed converter
  per record inside `audio-inspection.ts` and `acoustic-inspection.ts`, where the media
  math keeps its own field names, and `internalAudioSelection` in `project-service.ts`,
  which turns a public `sourceRange` into the core owners' `range`.

## Where it shows

- **CLI and MCP:** `asset.delete`, `project.duplicate`, `model.remove`, `media.list`
  (recordings and user imports, newest first), and `storage.usage.modelBytes`. The
  CLI never prompts.
- **App:** the Library's Recordings tab reads `media.list`, so imported videos sit beside
  takes with an "Imported" badge. Every delete goes through one confirmation
  (`apps/macos/Sources/YapControls/DeleteConfirmation.swift`), driven by the
  [library controller](../../../apps/macos/Sources/Yap/LibraryController.swift). A delete the service refuses
  becomes a second confirmation naming the projects, and only an explicit yes sends the
  cascade. Models are removed from the CLI only; the app has no models screen, and its
  storage footer shows model bytes.
- **Skill:** the "Removing media and reclaiming space" recipe in
  [skills/yap/SKILL.md](../../../skills/yap/SKILL.md) tells agents to delete what the
  user named, and to cascade or delete projects only when the user asked. The
  `refused-delete` and `authorized-free-a-clip` cases in
  [evals/cases.json](../../../evals/cases.json) pin that behaviour.

## How it diverged from the plan

- **The app asks twice when something is in use.** The plan had one dialog that listed
  users up front. The app learns the users from the service's refusal, so a plain
  confirmation comes first and the cascade confirmation follows the refusal, as its
  own request.
- **Cascades got narrower.** Reviews found a plain recording delete that could cascade
  into a project which started using the take mid-delete, and an asset cascade that
  took sibling assets it never listed. Both led to the invariants above.
- **The in-use check for models moved to content digests.** Matching a `modelId` key
  in job input never matched transcription, which names its model by repository.
- **A still screen keeps reaching disk.** Outside this spec's contract, the final full
  run found that a force-quit take of a still screen lost all of it, on main too. The
  native capture writer (`helpers/mac/Sources/YapCapture/CaptureWriter.swift`) repeats
  the last screen frame at 10 fps once the screen has been still for 100 ms.

## Dead ends

- A preview list echoed back to `cascade`, a separate `dryRun`, and history pruning (a
  new destructive operation that would roughly double the scope).
- Cascade editing clips out of projects: an editorial decision, outside the product.
- "Hide now, collect later", and merging two paged lists in the app (invisible to the
  CLI); `media.list` is one list with one cursor instead.
- Key-translating shims at the service edge for renamed fields: tried more than once
  and rejected each time in favour of renaming at the producer.
- A catalog migration: new tables only, so existing libraries open unchanged.

## Sharp edges (known, accepted)

- **Package adoption can bring back a deleted asset, acquisition or project.** Adopting
  a package is an explicit request; it is blocked only while a delete is in progress.
- **A deleted asset's import receipt keeps protecting the original's inode** from being
  overwritten by exports. It goes stale if the inode is reused.
- **A large cascade can outlast the caller's wait budget.** The call fails `TIMEOUT`
  while the delete keeps running; it resumes from its plan after a restart, and
  replaying the `requestId` returns its result.
- **Removing a model in the middle of a job** fails only that job; each native call is
  its own short-lived process.
- **`transcript.review` prepares its review model on demand**, even after
  `model.remove`. It leaves the removal recorded, so startup still skips the model.
- **Follow-ups not done:** the service maps work states with a response-wide rewriter
  that guesses from neighbouring keys, where each owner should map its own; test fault
  hooks sit in the production delete path; and the replay tables have no retention rule.
  See [choices.md](choices.md#release-review-2026-10-18).

## Visual provenance

- [visualizations/delete-mock.html](visualizations/delete-mock.html) is the mock the user
  approved while planning. It set the wording, the "Imported" badge, the bytes line and
  the **Delete all** button. The app departs from it in one place: the sidebar is too
  narrow for its one-line storage total, so the footer has three lines (total, media,
  models).
- [assets/13-app-rows](assets/13-app-rows/) holds the Library's rows before and after
  imports joined the Recordings tab, including deletion and long-title states. They are
  rendered offscreen from the real view with synthetic facts
  (`apps/macos/tests/library-view-shots.mjs`). Judged against the mock and an unprimed
  critique, they drove the dark-mode badge contrast and middle truncation of long
  import titles.
- [assets/14-delete-dialog](assets/14-delete-dialog/) holds the plain, imported and
  cascade confirmations in light and dark, from `apps/macos/tests/delete-dialog-shots.mjs`.
  The critique of these drove the hanging indent that keeps a long project line under
  its bullet.

[Library permissions](../../library-permissions.md) is the separate, smaller spec this
planning walk split off.
