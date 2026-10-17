# 07 Identity, naming and result shapes

**Contract (hard cutover):**
- **`requestId` on every operation that creates or changes something.**
  `speaker.bind` gains it, plus an expected-state pin like `speaker.correct`'s.
  `export.create` keys its idempotency on `requestId` instead of `exportId`.
- **Records name their ID `<noun>Id`.** Asset rows change `id` to `assetId`
  (`assets.ts:120,152`). `generation` gets one type across reads.
- **Permanent deletes** return `{<noun>Id, deleted: true, freedBytes}`. The
  existing `project.delete` and `recording.delete` move to this shape now, with
  `freedBytes` measured from what was removed.
- **`artifact.close`** returns its token. **Cancels** return the status record
  (slice 06).
- **`recording.latest` is removed.** `recording.get` without an ID returns the
  latest take, matching `revision.get`.
- **The `inspect` alias is removed;** `inspect.open` stays.
- **Every quantity carries a unit suffix.** `durationSeconds` becomes
  `durationUs`, `inferenceSeconds` becomes `inferenceUs`, and asset `bytes`
  becomes `sizeBytes`. Range parameter names are unified. The two range types
  stay: rationals where exact source clocks need them.

**Seam.** `packages/protocol/src/operations.ts` plus the handlers that produce the
renamed fields.

**Run or see.**
- `yap recording.get` (no ID) returns the latest take.
- `yap recording.latest` is an unknown operation.
- `yap asset.list` rows carry `assetId` and `sizeBytes`.

**Verify.**
- **A schema lint test** rejects: ID fields without a noun; quantity fields without
  a unit; operations that create or change something but take no `requestId`
  (using a read-only allowlist derived from the operation catalog); and removed
  aliases.
- **Downstream fixes in this slice:** app decoders (`recording.get`, `assetId`,
  delete results), CLI/MCP schema snapshots, and `skills/yap/references/capability-catalog.md`.

**Firewall.** No new operations.

**Delegated.** Splitting this slice into one commit per operation family if the
diff gets hard to review.

**Stays green.** Every test, updated to the new names. Never loosen one.
