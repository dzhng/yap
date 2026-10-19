# 02 Mark read: marks through `timeline.events`

**Contract unlocked:** agents, the index (slice 11) and the prompt (slice 12) read marks
through one path, with retractions already applied.

**Seam:** a core reader, `captureMarks(selection) → AsyncIterable<CaptureMark>`, next to the
existing capture-event reader that `packages/core/src/source-events.ts:126-150` resolves
through. `CaptureMark` carries the slice 01 fields plus output-pixel points projected through
the take's geometry epoch, exactly as cursor samples are (`CursorGeometry.swift:101-110,192-207`, P3).
Exposed as new row kinds on the existing `timeline.events` operation (no new operation),
requiring `acquisitionId` like the other capture rows. That means a new cursor position for the
mark kind in `captureHeads` (`packages/protocol/src/operations.ts:138-143`).

**Human can run:** `yap timeline.events` on the slice 01 fixture's acquisition and see stroke,
pin and click rows, with the retracted mark absent.

**Verify:** new `packages/core/src/source-marks.test.ts` on the slice 01 fixture: paging,
cursor stability across pages, retraction applied, epoch projection. Protocol schema test for
the new row kind. A selection without `acquisitionId` returns no mark rows, pinned as a test.

**Delegated:** internal reader structure.
**Must stay green:** existing `timeline.events` tests and cursors.
**Firewall:** no index or prompt change.
