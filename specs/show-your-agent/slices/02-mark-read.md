# 02 Mark read: marks through `timeline.events`

**Contract unlocked:** agents, the index (slice 11) and the prompt (slice 12) read marks
through one path, every recorded mark included (P1: undo only clears the screen; a `retracts`
row removes nothing and only ends the named mark's `shownForUs` early, P8).

**Seam:** a core reader, `captureMarks(selection) → AsyncIterable<CaptureMark>`, next to the
existing capture-event reader that `packages/core/src/source-events.ts:126-150` resolves
through. `CaptureMark` carries the slice 01 fields plus output-pixel points projected through
the take's geometry epoch, exactly as cursor samples are (`CursorGeometry.swift:101-110,192-207`, P3).
Exposed as new row kinds on the existing `timeline.events` operation (no new operation),
requiring `acquisitionId` like the other capture rows. That means a new cursor position for the
mark kind in `captureHeads` (`packages/protocol/src/operations.ts:138-143`).

**Human can run:** `yap timeline.events` on the slice 01 fixture's acquisition and see stroke,
pin and click rows; a `retracts` row is not a row and removes no mark.

**Verify:** new `packages/core/src/source-marks.test.ts` on the slice 01 fixture: paging,
cursor stability across pages, a `retracts` row removing nothing, epoch projection. Protocol schema test for
the new row kind. A selection without `acquisitionId` returns no mark rows, pinned as a test.

**Delegated:** internal reader structure.
**Must stay green:** existing `timeline.events` tests and cursors.
**Firewall:** no index or prompt change.
