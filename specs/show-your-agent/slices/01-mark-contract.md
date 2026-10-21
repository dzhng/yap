# 01 Mark contract: journal schema 3

**Contract unlocked:** `mark` is a legal capture-journal event everywhere a journal is read,
written, exported, validated or packaged. Schema 1 and 2 journals keep reading.

**Why one slice:** the journal is strict at every layer. An unknown event sets
`invalidAtSequence` and publication refuses the take (`helpers/mac/Sources/YapCapture/CaptureJournal.swift:402-411`,
`CaptureSourcePublication.swift:320`); the exporter counts kinds (`helpers/mac/Sources/YapWire/SourceEvidenceExport.swift:114-176`);
the TS validator throws on unknown events and checks counts against the receipt
(`packages/core/src/evidence.ts:144-213,337-348`). A half-landed schema fails takes, so all
layers change in one commit.

**Seam (frozen here; a later field means schema 4):**

```
{ event: "mark", sequence, hostUs, sourceUs, epoch,
  id, kind: "stroke" | "pin" | "click", pin?: number,
  points: [{ x, y, hostUs }],          // global points, top-left origin, as cursor samples (P3)
  window?: { app, title, bounds },     // window under the first point, Yap's own windows skipped
  retracts?: id }                      // written by undo until 0.1.69 (P1); no points, read as nothing
```

- Swift: schema 3 header, `JournalMark`, `recordMark`, reader callback beside `streamEvidence`
  (`CaptureJournal.swift:288-294`); a mark in a schema 1/2 journal is invalid.
- Exporter: a `mark` kind counter; receipt gains `markEvents`.
- TS: the `mark` branch in `validateRecord` and the receipt field.
- Portable package: the acquisition evidence schema accepts schema 3. Older Yap refusing newer
  packages is accepted (L1).
- Records stay under the 1 MiB cap (`CaptureJournal.swift:93`). One stroke is one record; a
  long stroke is kept under the cap by decimating its points (delegated), with a test at the cap.

**Fixture:** one golden journal, `fixtures/journal/schema3-marks.jsonl` (follow
`fixtures/README.md` for retained fixtures), read by both the Swift and the TS tests: a stroke,
a numbered pin, a click, a retraction, an epoch change mid-take, and a pause.

**Human can see:** the fixture exported through the evidence path shows mark rows and a receipt
with the mark count; a package round-trips it.

**Verify (write tests first):** `helpers/mac/Tests/YapCaptureTests/CaptureJournalTests.swift`
(schema 3 round trip, mark in schema 2 refused, cap), `CaptureWriterTests.swift`,
`helpers/mac/Tests/source-evidence.test.mjs`, `packages/core/src/evidence.test.ts`,
`project-package.test.ts` / `portable-index.test.ts` for the package path. Existing schema 1/2
fixtures must still read.

**Delegated:** Codable field naming inside the frozen shape, point decimation.
**Must stay green:** every publication and recovery test in `YapCaptureTests`.
**Firewall:** no recognizer, overlay, index or prompt work.
