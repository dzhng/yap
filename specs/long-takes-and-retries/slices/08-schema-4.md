# 08 — Journal schema 4

Depends on: 03, 07.

## Contract

New takes write `schemaVersion: 4`. Readers accept 1–4 and refuse higher versions clearly. An
older app refuses schema 4 clearly instead of misreading it. Schema 4 adds:

- header `cursorSampling: {intervalUs, holds}`; absent means 60 Hz with every tick written;
- strokes end at `MAXIMUM_STROKE_US`: a stroke still held at 5 minutes is committed and a new
  one begins, so a stroke record never exceeds the derived record bound;
- the take summary (`source.publication.json`) gains optional `take: {kind}` (`display` / `window` /
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

## Implementation decisions

- The receipt already requires `kind: primary | camera` for source authority. Keep it and add
  optional `take: {kind}` for capture kind; the optional top-level `marks` holds live-mark facts.
  Native `region` capture is summarized as `area`. Only newly published schema-4 takes receive these facts. Existing receipts are returned unchanged.
- `intervalUs` is an integer number of microseconds, sharing the native sampler's default;
  `holds` is false until slice 09 changes writing semantics.
- A boundary tick exactly at the stroke limit ends that stroke. A later tick begins the next;
  each observation is retained once, and a delayed tick cannot extend the preceding stroke.
- `inspect` selects the persisted layout, like streaming readers, so all read entry points accept
  supported journals and report future schemas clearly. Packed inspection does not invent audio ranges.

## Verification result

Focused native schema/recognizer and journal/lease/PCM checks pass. The six-minute hardware replay
retains all 21,601 points across two bounded strokes. Publication checks live marks, undo-all,
historical omission, immutable replay and read-only recovery. Both readers consume the shared
writer-produced schema-4 fixtures; future headers identify the unsupported schema.

Core's three focused files pass 45 tests; its type check passes. All four slice-07 historical
normalized-byte and receipt goldens pass unchanged. The source scan was falsified with a stray
version check, and undo coverage with a deliberately disabled retraction, before restoring green.
No full repository suite was run; whole-file/count ceilings remain slice 10's work.

Independent Codex review found two edge cases, both reproduced red and fixed: native `region`
now reports `area`, and duration splits retain recognition so short continuation segments are
not dropped. The final native slice selector passes 18 checks and journal/lease/PCM passes 12.
The current worker still passes all four historical byte goldens after these fixes.
