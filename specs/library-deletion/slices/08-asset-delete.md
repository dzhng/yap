# 08 asset.delete

**Contract.** `asset.delete {requestId, assetId, cascade?}`.
- **In use, no cascade.** Returns `IN_USE` with slice 04's details.
- **Otherwise,** a `LibraryDeletion` subject of kind `asset` deletes, in slice 02's
  order:
  - the asset's file, under the publish lock;
  - its transcript generations and `transcripts/assets/<id>`;
  - its imported transcripts and `transcripts/imported/<id>`;
  - its scene, screenshot-index, alignment and speaker generations (probe P2's
    full list);
  - `derived_cache` entries and `asset_origins` rows (`asset_segments` cascades by
    its foreign key);
  - jobs targeting it.
- **With `cascade`,** it also deletes the users recorded in the plan: whole
  projects, derived assets (and their creating job rows, `asset-conversion.ts:267`,
  `voice-generation.ts:315`), and acquisitions through slice 09's retirement step.
- **Live reads are cut off first:** `delivery.revoke({kind:"asset"})`.
- **Result:** `{assetId, deleted: true, freedBytes}`.
- **Import replay** (`assets.ts:269-300`). Replaying an old import `requestId`
  returns `ASSET_DELETED` (not retryable). The import receipt row is kept. Importing
  the same bytes under a new `requestId` works.

**Seam.** The asset retirement step registered on `LibraryDeletion`, and the
operation schema in protocol.

**Run or see** (CLI, on a fixture library):
1. Import a clip and place it in a project.
2. `asset.delete` returns `IN_USE`, naming the project, its revision count and the bytes.
3. `cascade: true` deletes both.
4. `storage.usage` drops by exactly `freedBytes`.

**Verify.** Red tests first:
- refusal details;
- a plain delete removes every file and row listed above, checked by file and row
  counts against a temp library;
- cascade through a derived chain;
- crash and resume in the middle of a cascade (the plan is replayed, users are not
  re-checked);
- replay returning `ASSET_DELETED`, and re-import under a new request;
- the imported-transcript files that have no recovery sweep today
  (`imported-transcript.ts`) are recovered from the plan.

**Same slice:** add `asset.delete` to `skills/yap/references/capability-catalog.md`
and its help description.

**Firewall.** No project edits. No app work.

**Delegated.** How the step is split into functions, and the page size for row
deletion.
