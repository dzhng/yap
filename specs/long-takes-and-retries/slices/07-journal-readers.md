# 07 — Linear journal readers with a derived record bound

Depends on: 02 (H1), 03.

## Contract

- A journal line up to the derived record bound reads in both languages; a longer line is
  reported as corrupt (schema 4) or classified exactly as before (schemas 1–3).
- Reading is linear in bytes: no per-chunk rescans or whole-buffer concatenation.
- Old journals re-export byte-for-byte, so old packages import.
- A capture whose journal holds a 68,916-byte stroke line (the origin shape) imports.

## Seam

- The record bound: `JOURNAL_RECORD_BYTES` derived in protocol from `MAXIMUM_STROKE_US`
  (18,000 points × measured bytes per point × margin, per `limit-verdicts.md`). Swift's
  `maximumRecordBytes` (`CaptureJournal.swift:93`) is checked against it by the slice 03 style
  test. Schemas 1–3 keep 1 MiB as format interpretation.
- TS: `packages/core/src/evidence.ts` `sourceEvidenceRecords` (~374-421) reads lines through the
  protocol's JSON-line owner (`packages/protocol/src/framing.ts` `JsonLineStream`, ~83) or a
  fail-fast sibling there, so there is one TS line splitter. The `65536` checks go.
  `evidence-pages.ts:38` content bound follows `limit-verdicts.md`.
- Swift: `CaptureJournal.readRecords` (~270-311) keeps a scan offset and compacts once per
  chunk. `.oversized` vs torn-tail classification for schemas 1–3 is unchanged, because
  recovered takes re-verify it (`CaptureSourcePublication.swift:255`).
- Fixture: `fixtures/journal/schema3-long-stroke.jsonl` written by the production writer with an
  11-second 60 Hz stroke (over 64 KiB). Not copied from the origin take.

## Run or see

The fixture imports through the service in a temporary `YAP_HOME`.

## Verification (red first)

- `packages/core/src/capture-acquisition.test.ts` (or the nearest production-path import test):
  the long-stroke fixture imports to ready. Fails today with `INVALID_EVIDENCE`.
- Linearity: a reader test counts bytes scanned for one large line (not wall time).
- Byte identity: `helpers/mac/Tests/source-evidence.test.mjs` exports
  `fixtures/journal/schema3-marks.jsonl`, `fixtures/launch-video/session/recording/source/*.journal.jsonl`
  and `fixtures/narrated-workbench/capture.journal.jsonl` and compares with checked-in normalized
  bytes captured before this slice changes anything. `source-admission.test.ts`: an old package
  imports.
- `CaptureJournalTests.swift`: schema-3 oversized tail still reports invalid at its sequence;
  recovered-take verification unchanged.

## Delegated

Buffer representation.

## Stays green

Prefix verification, cancellation, receipt equality, every YapCapture recovery test.

## Completion evidence

Implemented 2026-10-20, without changing the writer's schema or stroke thinning.
The [pre-change goldens](../../../helpers/mac/Tests/fixtures/journal-goldens/README.md)
retain normalized bytes and receipts from all four named journals. Rebuilt export
matches all four. The production writer's 11-second fixture retains 660 points in
a 78,316-byte journal line. Its public service import failed with
`INVALID_EVIDENCE` before the reader change and reaches `ready` afterward.

The production ingest scan assertion sees exactly 78,519 bytes scanned for
78,519 normalized bytes; restoring the concatenating/rescanning loop with its
size check lifted makes it fail at 143,840 scanned bytes. Portable checks retain
all fixture points, round-trip an exact 7,416,000-byte serialized row with a next
page, reject one extra byte, and reject multibyte content that fits a character
count but exceeds the record byte bound.
The upstream export check generates 20 strokes through the same production writer;
bounded export preserves every stroke in order. The batch regression also fills
the content budget exactly with multibyte text, isolates an oversized row, and
checks 256-row continuation parity between SQLite and portable readers. Native
TypeScript cases use explicit `YAP_NATIVE` provisioning so ordinary core tests do not require a native build.

Swift journal/lease/PCM-prefix checks and all source-publication, empty-source,
canonical and media recovery checks pass. Schema-3 tails of 1,048,576 and
1,048,577 bytes retain the torn/invalid distinction at sequence 6. Focused core
and protocol checks and the affected package typechecks pass. No full repository
run or origin-take access was performed.
The retained version-6 project package from Yap 0.1.61 also opens and adopts through
the service; source admission separately verifies the pre-change schema-3 golden
against native re-export and rejects a changed digest.

Choices: reuse `JsonLineStream` directly; it already scans fragments once and
joins only at line completion. Swift keeps a scan offset and compacts once per
chunk. Keep ordinary portable batching at 1 MiB while permitting a single larger
row, with array framing accounted separately. Export fetches at most 256 rows
within that shared ordinary content-byte budget, always admitting the first row.
SQLite windows only candidate keys and byte lengths before fetching the selected
prefix content; portable reads apply the same cutoff while scanning bounded pages.
Preserve goldens losslessly as gzip to avoid duplicating megabytes of text. Whole-file ceilings in the verdict
table all belong to slice 10 and remain unchanged; schema-4 format admission and
writing remain slice 08.

Independent Codex review found the upstream batch allocation and unconditional
native prerequisites; both were reproduced or confirmed from the task wiring
and corrected in this slice.
Follow-up review confirmed bounded ordered export and identified a PATH/GPL
encoder prerequisite in the service test; the native fixture picture writer now
produces that movie using the same provisioned test product.
The final focused review found no actionable fixture, selector or cleanup issues.

Export query amplification is measured in [export-batches.json](../assets/probes/export-batches.json).
The same production-written 4,000-second fixture contains 240,000 cursor samples;
all eight indexes export in 0.853 s with the original unbounded 256-row fetch,
18.604 s with singleton fetches, and 1.367 s with byte-bounded batches. All three
produce identical manifests and verified page digests (480,067 indexed rows in
1,877 pages). These are single sequential observations with no cache purge,
excluding generation, normalization and ingest, not a 12-hour acceptance result.
