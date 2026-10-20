# 03 — Requirements owner

Depends on: nothing.

## Contract

The two stated requirements have one owner in code and one explanation in the docs.

## Seam

- `packages/protocol/src/requirements.json`: `{ "maximumTakeSeconds": 43200, "maximumStrokeSeconds": 300 }`.
- `packages/protocol/src/requirements.ts`: re-exports them as microseconds
  (`MAXIMUM_TAKE_US`, `MAXIMUM_STROKE_US`) and one helper, `derivedBound(perUnit, requirementUs, margin)`,
  that later slices use beside each derived constant. Import the JSON the way
  `refusal-ledger.ts` imports its JSON.
- Swift: `Requirements.swift` in the lowest helper module both `YapCapture` and `YapWire` see
  (check `YapMedia`). A Swift test reads `requirements.json` through a `#filePath`-relative path
  (as `CaptureJournalTests` finds `fixtures/journal`) and asserts equality.
- `DEVELOPMENT.md` gains:

```markdown
## Limits come from requirements

A take can run for 12 hours, and a ⇧ stroke for 5 minutes. Those are the only limits the
product sets. Every other bound (bytes per line or file, rows, samples, pages, deadlines) is
derived from them: what that data grows at, times the requirement, times a stated margin.
Write the derivation next to the constant. A bound you can't derive is made up; delete it.
Readers stream, so a bound tells corrupt input from valid input; it never caps what a valid
take can hold, and corrupt input fails with a clear error, never a hang.
```

  Link it from `helpers/mac/Sources/YapCapture/README.md` where takes and strokes end.

## Run or see

`bun test` on the requirements test; `swift test --filter Requirements` (or the package's
equivalent runner).

## Verification

Red: the Swift equality test fails with a wrong value. Green: both languages read the same
numbers.

## Delegated

Swift module placement; exact helper name.

## Stays green

Protocol package tests; YapCapture test target.
