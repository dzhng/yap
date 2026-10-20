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
