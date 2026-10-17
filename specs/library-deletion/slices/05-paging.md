# 05 One paging contract

**Contract.**
- **Requests.** `cursor` is the previous page's opaque `nextCursor` string. It is
  base64url, and the operation's filters and pins are bound inside it. `limit` is
  1–1000, with a default of 100 declared in the schema.
- **Results.** `{<plural>, nextCursor: string|null}` at the top level.
- **Order.** Library listings are newest first.
- **Errors.** A malformed cursor, or one from another operation or filter set, is
  `INVALID_PARAMS`. A stale pin is `ARTIFACT_CHANGED`.
- **Listings hide items being deleted,** using the tombstones from slices 02–03
  or the existing `deletedAt` markers, through one `listable()` predicate per store.

**Migrations (hard cutover, no aliases):**

| Operation | Today | After |
|---|---|---|
| project.list | `afterSequence` that actually means "before" (`projects.ts:254-262`), default 250 | opaque cursor, default 100 |
| asset.list | oldest first (`assets.ts:448-485`), rows use `id` | newest first (rows renamed in slice 07) |
| export.list | schema max 500 vs implementation 1000 (`operations.ts:683`, `exports.ts:778`), lexical order | 1–1000, newest first |
| recording.list | `beforeSequence`, max 100 | standard |
| model.list | a bare array (`models.ts:653`) | `{models, nextCursor}` |
| asset.origins | leaks a JSON row as its cursor | opaque |
| asset.segments | `afterOrdinal` | opaque; order stays by ordinal, which carries meaning |
| revision.history | structured cursor | opaque; order stays by ordinal |
| audio.pause.get | `{offset}` | opaque |
| transcript.get, transcript.disfluency.get and other evidence reads | `nextCursor` nested under `page` | top level, as the envelope; pins stay inside the cursor |

**Seam.** `pageCursor.encode(scope, position)` and `decode(scope, cursor)` in core,
plus `pageParams()` and `pageResult()` in protocol.

**Run or see.**
- `yap asset.list --params '{"limit":1}'`, then follow `nextCursor` to the end.
- Pass a forged cursor and get `INVALID_PARAMS`.

**Verify.**
- **Codec unit tests:** round trip, tampering, scope mismatch, filter binding.
- **One table-driven conformance test** that enumerates every operation whose
  schema uses `pageResult`, *from the schema*, not from a hand-written list. For
  each one it checks the limit and default, the garbage-cursor refusal, ordering,
  and that no page duplicates or skips an item.
- **Regression tests** for the reversed `project.list` cursor and the 500/1000
  mismatch.
- **App:** fix the Swift paging decoders in `LibraryController` and `LibraryState`
  in this slice.
- **Skill:** update `skills/yap` wherever it shows a cursor.

**Firewall.** No new operations. Evidence reads keep their pinned payloads; only
the envelope changes.

**Delegated.** Cursor encoding internals.

**Stays green.** Every listing test, rewritten to the new shape. Never delete one.
