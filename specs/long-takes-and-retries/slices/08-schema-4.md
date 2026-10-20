# 08 — Journal schema 4

Depends on: 03, 07.

## Contract

New takes write `schemaVersion: 4`. Readers accept 1–4 and refuse higher versions clearly. An
older app refuses schema 4 clearly instead of misreading it. Schema 4 adds:

- header `cursorSampling: {intervalUs, holds: true}`; absent means 60 Hz with every tick written;
- strokes end at `MAXIMUM_STROKE_US`: a stroke still held at 5 minutes is committed and a new
  one begins, so a stroke record never exceeds the derived record bound;
- the take summary (`source.publication.json`) gains optional `kind` (`display` / `window` /
  `area` / `camera`) and `marks: {pins: bool, strokes: bool}`, true only for marks still live
  after undo retractions.

Cursor change-only writing is slice 09; this slice only adds the header fields with
`holds: false` semantics until 09 flips them.

## Seam

- One capability table per language replaces scattered version checks: Swift `JournalSchema`
  (`isPacked`, `carriesMarks`, `cursorSampling(header)`) next to `CaptureJournal.isPacked`
  (~102); TS `journalCapabilities(header)` in `evidence.ts` next to `packedSchema` (~238).
  Replace `CaptureJournal.swift:207,445,619`, `CaptureSourcePublication.swift:402`,
  `evidence.ts:246,392`, `capture-publication.ts:33` (`layout` adds 4). A scan test forbids
  version literals outside the two tables.
- Writer: `CaptureWriter.swift:139` writes 4.
- Stroke bound: `MarkRecognizer` commits a stroke when its duration reaches
  `MAXIMUM_STROKE_US` and starts a new one if ⇧ is still held. Delete the thinning loop in
  `CaptureJournal.recordMark` (~206-226).
- Summary: optional fields on `CapturePublishedSource` (Swift, ~7-23) and the strict schema in
  `capture-publication.ts:19-44`, computed during the existing journal traversal at publish, not
  an extra scan. Never written onto an already-published record.
- New fields are optional and omitted when absent, so re-exporting old journals is unchanged.

## Run or see

Golden fixtures `fixtures/journal/schema4-*.jsonl` and `fixtures/journal/schema4-summary.json`
read by both `CaptureJournalTests.swift` and `evidence.test.ts` / `capture-publication.test.ts`.

## Verification (red first)

- A 6-minute held stroke through `PrerecordedCaptureInput` produces two stroke records, no points
  lost, each under the record bound.
- Summary reports pins/strokes for a take with marks, false after undoing them all, absent for an
  old summary.
- The byte-identity goldens from 07 still pass.
- A schema-5 header is refused with a clear error.

## Delegated

Field names (keep them short and match header style); whether `intervalUs` is an integer.

## Stays green

Marks/undo, live ink, camera companion journals (schema 1), recovery.
