# Library deletion and one rule per API concept

Everything a user thinks of as "a video in Yap" can be deleted, and deleting it
actually frees the space: imported videos (assets), recordings with the copies
made from them, projects and models. The public API also gets one rule per
concept (paging, async state, identity, errors, results, naming), and the new
operations follow those rules from the start.

Before this work, only projects (app and CLI) and recordings (CLI only) could be
deleted. Deleting a recording left the copies a project had made of it. Imported
videos and models could not be deleted at all, and the storage total left out
models, which were 95% of a real library.

## Next Agent Prompt

*Last updated 2026-10-17.* You are resuming this feature. Read this README, then
the slice you pick up. Hard cutover: no compatibility aliases, no catalog
migration (format stays 29; see [Contracts](#contracts)).

**Status.** Slices 00 to 03 done. Slice 05 is in progress in its own worktree.
Choices made along the way are in [choices.md](choices.md).

Slice 01 evidence: protocol, core, CLI and service suites, every package build and
typecheck, the Swift build and the native node suites are green. The `YapCaptureTests`
camera flake seen then is fixed (`b6237bda`), outside this spec's slices.
Slice 02 adds the shared `LibraryDeletion` coordinator and idempotent deletion-plan
tables while keeping catalog format 29. Slice 03 fences tombstoned assets and
acquisitions from new references, job admission and asset publish.

**Pick up at** slice 04, alongside slice 05 or 06 in the API worktree.

**Warnings.**
- Slices 05–07 (API consistency) and 02–04 (deletion substrate) don't depend on
  each other and can run in parallel. Every new public operation (08+) needs both
  sets done first, so it follows the final rules from the start.
- The macOS app reads changed shapes (`recording.get`, `assetId`, paging). Fix its
  decoders in the slice that changes the shape, never later.
- Presets (`preset.list/get/create/update/delete`) landed from main after this spec
  was written. Slice 05 pages `preset.list` like `model.list`; slices 06 and 07 apply
  their vocabulary and naming rules to the preset operations too. A preset is a
  local file, not a catalog row, so it stays outside the deletion coordinator.
- Write the test first (red, then green) in every slice. Run the narrowest check
  per change, and the full suite once, in slice 16.

**TODO**
- [x] 00 Probes and open checks — [slices/00-probes.md](slices/00-probes.md)
- [x] 01 Retryability per error code — [slices/01-error-ledger.md](slices/01-error-ledger.md)
- [x] 02 One deletion coordinator and deletion plans — [slices/02-deletion-coordinator.md](slices/02-deletion-coordinator.md)
- [x] 03 Deletion fence and publish race — [slices/03-fence.md](slices/03-fence.md)
- [ ] 04 Who uses this? — [slices/04-users-query.md](slices/04-users-query.md)
- [ ] 05 One paging contract — [slices/05-paging.md](slices/05-paging.md)
- [ ] 06 One async vocabulary — [slices/06-async-vocabulary.md](slices/06-async-vocabulary.md)
- [ ] 07 Identity, naming and result shapes — [slices/07-identity-naming.md](slices/07-identity-naming.md)
- [ ] 08 `asset.delete` — [slices/08-asset-delete.md](slices/08-asset-delete.md)
- [ ] 09 `recording.delete` takes its copies — [slices/09-recording-delete.md](slices/09-recording-delete.md)
- [ ] 10 `project.duplicate` — [slices/10-project-duplicate.md](slices/10-project-duplicate.md)
- [ ] 11 `model.remove` and model storage — [slices/11-model-remove.md](slices/11-model-remove.md)
- [ ] 12 `media.list` — [slices/12-media-list.md](slices/12-media-list.md)
- [ ] 13 App: imported videos in the Recordings tab — [slices/13-app-library-rows.md](slices/13-app-library-rows.md)
- [ ] 14 App: one delete confirmation — [slices/14-app-delete-dialog.md](slices/14-app-delete-dialog.md)
- [ ] 15 Skill recipe and evals — [slices/15-skill-and-evals.md](slices/15-skill-and-evals.md)
- [ ] 16 Full check, review, release — [slices/16-closeout.md](slices/16-closeout.md)

Update this section before ending your pass.

## Slice graph

```
00 probes ── 01 error ledger ──┬── 02 coordinator ── 03 fence ── 04 users ──┐
                               └── 05 paging ── 06 async ── 07 identity ────┤
                                                                            ├── 08 asset.delete ── 09 recording.delete ─┐
                                                                            ├── 10 project.duplicate ───────────────────┤
                                                                            ├── 11 model.remove ────────────────────────┤
                                                                            └── 12 media.list ──────────────────────────┤
                                                       13 app rows ── 14 app dialog ── 15 skill + evals ── 16 closeout ◄┘
```

## Contracts

- **Delete rule (every subject).** A delete refuses with `IN_USE` (`retryable: false`) while anything uses the subject. The refusal's details list the users, plus `freesBytes` and `cascadeFreesBytes`. `cascade: true` also deletes whatever uses the subject *at execution time*; there's no preview token. A subject's own derived data (transcripts, evidence, cache) always goes with it. The result is `{<noun>Id, deleted: true, freedBytes}`.
- **Users.** Each project is reported once, with its revision count. Every revision counts, undo history included, and nothing is pruned. Projects already being deleted are skipped. Derived assets (HDR conversions, generated voice) count as users of their source. Running jobs are drained, not reported.
- **New operations:**
  - `asset.delete {requestId, assetId, cascade?}`
  - `project.duplicate {requestId, projectId, revisionId?, title?}`: the new project's only revision is that document, defaulting to the head revision.
  - `model.remove {requestId, modelId}`
  - `media.list {cursor?, limit?}`: recordings and user-imported videos, newest first.
- **Changed operations:**
  - `recording.delete` takes `cascade?`. Unused copies of the take go with it; copies a project uses refuse unless `cascade` is set.
  - `storage.usage` gains `modelBytes`.
  - Everything in slices 05–07.
- **API rules (one per concept).**
  - **Paging:** `cursor` is the previous page's opaque `nextCursor` string. `limit` is 1–1000, with a default of 100 declared in the schema. Results are `{<plural>, nextCursor: string|null}`. Library listings are newest first.
  - **Async:** one state vocabulary, and `job.get/retry/cancel` own polling and recovery.
  - **Identity:** `requestId` on everything that creates or changes; `<noun>Id` in records.
  - **Errors:** each code has one category and one retryability, both in the ledger.
  - **Naming:** every quantity carries a unit suffix.
  - **Kept on purpose:** rational microseconds, where exact source clocks need them.
- **No compatibility, no migration.**
  - Renamed or removed names disappear in the slice that replaces them. `skills/yap` and the help schemas change in that same slice.
  - The catalog stays at format 29 (`packages/core/src/catalog.ts` refuses any other format). New persisted state goes only in **new** tables, created idempotently; no existing table is altered. Recording deletion markers without a plan row resume with the old semantics.
- **App.**
  - Imported videos appear in the Recordings tab with an "Imported" badge, the original filename, and Play / Copy agent prompt / Delete.
  - Every Library row gets Delete.
  - One confirmation dialog: "Delete *name*? This can't be undone.", with bytes freed. For an import it adds "Your original file isn't touched". When the item has users, the same dialog lists them and its button reads **Delete all**.
  - The CLI never prompts.
  - Approved mock: [visualizations/delete-mock.html](visualizations/delete-mock.html).

## Single owners

Each concept has one owner; no slice adds a second.

| Concept | Owner |
|---|---|
| Error code, category and retryability | `packages/protocol/src/refusal-ledger.json` (gains `retryable`); `CatalogError` and the native failure mapping derive from it (slice 01) |
| Deletion ordering, plans and crash resume | `LibraryDeletion` in `apps/service` (slice 02). It replaces `RecordingDeletion` and `ProjectDeletion`, whose files are deleted |
| Deletion tombstones and plans (cascade choice + exact members) | `DeletionPlans` in `packages/core`, new tables (slice 02) |
| Refusing new uses of something being deleted | `ResourceReferences.retain`, job admission and `isAvailable`. Asset unlink shares `AssetStore.publishFile`'s per-asset lock (slice 03) |
| Who uses X, and `IN_USE` details | `LibraryUsers.usersOf` + `inUseDetailsSchema` (slice 04) |
| Retiring acquisitions | an internal step registered on `LibraryDeletion`; no public operation (slice 09) |
| Paging codec and paging schema | `pageCursor` in core, plus `pageParams()`/`pageResult()` in protocol (slice 05) |
| Async state vocabulary | `WorkState` in protocol, mapped at the protocol edge; catalog strings are unchanged (slice 06) |
| Model removal and its persistence | `Models` in `packages/core/src/models.ts` (slice 11) |
| Mixed recordings + imports listing | `MediaListing` read model in core (slice 12) |
| App delete confirmation | one `DeleteConfirmation` presentation in YapControls (slice 14) |

## Decision ledger

Settled in the planning walk (2026-10-17). "Agent" means answered by the agent on
the user's behalf, under the user's confirmed preferences: simple over defensive;
one rule per concept; explicit primitives over clever behaviour; strict only where
the loss is permanent and real; agent-facing docs matter. The user may reopen any
agent answer.

| # | Decision | Why | By |
|---|---|---|---|
| D1 | `asset.delete` refuses while in use and names the users; `cascade` deletes them too | Never breaks a project silently; the caller decides (product boundary) | user |
| D2 | Every revision, undo included, counts as using an asset; no history pruning | No new concept, and honest about what undo can bring back. Pruning (dropping old history) was rejected as a new destructive project operation that roughly doubles the scope | user |
| D2b | `project.duplicate`, a separate operation from `project.create` | Frees a clip held only by history. `project.create` keeps its promise of an empty project. A clip-level `duplicate` edit already exists inside `edit.apply`; help text says which is which | user |
| D2c | Skill gets the catalog entries and a "Removing media and reclaiming space" recipe | Agents need the recipe, and the rule that they cascade or delete projects only when the user asked | user |
| D3 | `recording.delete` follows the delete rule (contract change) | A deleted recording should free its space; one rule for everything | user |
| D4 | `cascade: true`, with no list of names to echo back | An item gaining a new user between the refusal and the cascade is rare; simplicity wins | user |
| D5 | Imported videos in the Recordings tab; every row gets Delete; only user imports listed | The gap is visible in the app, and nothing is listed twice | user (listing details: agent) |
| D6 | One confirmation dialog for every app delete; the CLI never prompts | The one place where strictness prevents real, permanent loss | user |
| D7 | `model.remove` + `modelBytes` | Models dominate disk use and were missing from the total | user |
| D7b | `model.remove` is CLI/MCP only; the app's storage line shows model bytes | The app has no models screen; parity is required only from app to CLI (`AGENTS.md`) | agent |
| D17 | `media.list`, one newest-first list with one cursor | Merging two paged lists in the app would be invisible to the CLI | user |
| P | Fix public API inconsistencies under one rule per concept, no aliases | The user asked for it explicitly | user (rules: agent) |
| C | No compatibility aliases, no catalog migration | Keeps existing libraries opening without migration code | user |
| X | Loosening library permissions is a separate spec ([../library-permissions.md](../library-permissions.md)) | Small and independent; shouldn't wait on this | agent |

Rejected along the way:
- a preview list echoed back to `cascade` (D4);
- a separate `dryRun`;
- history pruning (D2);
- cascade editing clips out of projects (an editorial decision, outside the product boundary);
- "hide now, collect later";
- interleaving two lists in the app (D17);
- a catalog migration (C).

## Firewalls

- Never alter an existing catalog table, and never bump the catalog format.
- No compatibility aliases: a renamed name disappears in the slice that renames it.
- Detection never grants permission. Yap never edits a project to free a clip, and cascade only ever deletes whole users.
- Deleting removes Yap's own copies only. Originals elsewhere on disk and committed external exports are never touched.
- Library permissions (`0o400`/`0o700`, the startup refusal at `assets.ts:210-216`) belong to the separate spec.

## Sharp edges (known, accepted)

- **Package adoption can bring back a deleted asset, acquisition or project.** That is allowed, because adopting a package is an explicit request. Adoption is blocked only while a delete is in progress.
- **A deleted asset's import receipt keeps protecting the original's inode** from being overwritten by exports (`exports.ts:1100-1108`). It goes stale if the inode is reused.
- **A large cascade can outlast the operation's wait budget** (`operations.ts:1789-1791`). The delete stays resumable from its plan, and the result says it's still pending.
- **Removing a model in the middle of a job** fails only that job. Each native call is its own short-lived process (`worker.ts:84-89`).
