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
