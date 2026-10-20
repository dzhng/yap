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

## Slice 04

- **`details.retry` is validated against `operationSchema`** and an invalid directive throws when
  the error is built. A bad directive is a programming error and should fail loudly. Sound.
- **An owner's explicit directive wins over the adapter's self-retry rule**, and the self-retry
  rule applies only to retryable failures. Sound (corrected in review: it first applied to every
  refusal, which told agents to resend `NOT_FOUND` reads).
- **The Swift app reads the bundled `service/refusal-ledger.json`** for its own errors; a missing
  ledger is a fatal error, and source-compiled test fixtures stage the file beside their binary.
  Sound (corrected in review: it first fell back to a build-machine checkout path).
- **Self-retry is attached on every adapter path** (socket, control channel), not per handler.
  Sound: one rule, one owner (`apps/service/src/operation-errors.ts`).
