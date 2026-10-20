# Choices ledger

Decisions made during implementation where the spec was silent. Per-pass entries; consolidated
at close.

## Slice 03

- **`derivedBound` takes growth per second and rounds up.** Sampling and write rates are stated
  per second, and a bound must hold whole units. Sound.
- **Swift mirror is `YapMedia.Requirements` with `Int64` microseconds.** `YapMedia` is the
  lowest module both capture and wire code import, and native time is `Int64` µs. Sound.
- **The Swift equality check runs in the existing `YapCaptureTests` executable** (selector
  `YAP_REQUIREMENTS`, also in the default run) instead of a new test target. Matches how every
  other capture test is wired. Sound.

## Slice 07

- **The TS reader reuses protocol's `JsonLineStream`** rather than a second splitter; Swift
  keeps a scan offset and compacts once per chunk. Sound: one line splitter per language.
- **Swift restates the record-bound formula** (`60 × 103 × stroke seconds × 2`) and a test
  checks it equals protocol's `JOURNAL_RECORD_BYTES`. Sound, matching how the requirements
  themselves are mirrored.
- **Export reads batch up to 256 rows within a 1 MiB byte budget**, cut in SQL with a running
  sum, and a larger record advances alone. Sound (corrected in review: it first fetched one
  row per query, 18.6 s vs 0.85 s on 240k cursor rows; the byte-bounded version takes 1.37 s).
- **Golden pre-change exports are stored gzip-compressed** (364 KB for 6.7 MB). Sound.
- **The 1 MiB writer guard stays for all writes until slice 08** switches new takes to
  schema 4. Sound: schema 3 must keep its rule.
