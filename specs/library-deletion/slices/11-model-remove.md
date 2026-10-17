# 11 model.remove and model storage

**Contract.**
- **`model.remove {requestId, modelId}`:**
  - cancels or joins any in-flight `prepare` (`models.ts:531-540`);
  - refuses with `MODEL_IN_USE` (retryable) while a running job's request names
    the model (jobs have no model owner, `jobs.ts:41-46`);
  - deletes everything for that model under `models/`, including `models/.cache/<name>`
    (`models.ts:279`);
  - returns `{modelId, deleted: true, freedBytes}`.
- **The removal persists.** A new `model_removals` table records it. Startup
  auto-prepare (`models.ts:689-697`, parakeet `autoPrepare: true`) skips a removed
  model until an explicit `model.prepare` clears the record.
- **`storage.usage` gains `modelBytes`,** counting everything under `models/`.
  This replaces the skip at `storage.ts:196`.
- **CLI/MCP only.** The app's storage line shows `modelBytes`, but there is no model
  removal UI (decision D7b).

**Seam.** `Models` in `packages/core/src/models.ts`, plus `storage.ts`.

**Run or see.**
1. `model.status`, then `model.remove parakeet`.
2. Restart the service: no re-download.
3. `model.status` shows the model absent, and `storage.usage.modelBytes` has dropped.

**Verify.** Red tests first:
- remove racing an in-flight prepare (blocked-fetch fixture), then a restart;
- the `MODEL_IN_USE` refusal while a job is running;
- an unknown model returns `NOT_FOUND` with `kind: "model"`;
- byte totals include `.cache` and staging;
- explicit prepare after a removal works;
- probe P1's on-demand answer, pinned with a test.

**Same slice:** catalog entry and help text.

**Firewall.** `LibraryDeletion` is not used; models are not catalog subjects.

**Delegated.** The `model_removals` columns.
