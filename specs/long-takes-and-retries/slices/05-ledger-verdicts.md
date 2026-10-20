# 05 — Apply the error verdicts

Depends on: 01 (H1), 04.

## Contract

The ledger says what `error-verdicts.md` says, and it is the only place retryability is
decided.

## Seam

- Apply every verdict to `refusal-ledger.json`, including `retryAfterMs` on wait codes and
  `cause` on every code people can see. Add `JOB_INTERRUPTED`; teach the scanner single-quoted
  SQL or add it with a test that greps for it.
- Splits decided in 01 (`INVALID_EVIDENCE` for caller packages, `NOT_READY` for a vanished pinned
  implementation): new codes at their producers; `exports.ts:984` re-keyed.
- Delete the helper denylist (`CaptureTypes.swift:160`); native failures carry only a code, as
  `helpers/mac/Tests/refusal.mjs` already expects. `apps/service/src/capture.ts:566` derives
  the finalization error's retryability from the ledger; `retryable` leaves the capture wire
  schema (`packages/protocol/src/capture.ts:106-111`) because app and service ship together.
- Swift app codes are checked against the ledger by a test that reads the JSON.
- Ledger rule test: a code whose verdict differs from its category's usual verdict carries a
  `reason`.

## Run or see

The ledger diff, readable against `error-verdicts.md`.

## Verification

- `refusal-ledger.test.ts`: `INVALID_EVIDENCE` (capture case) retryable; `JOB_INTERRUPTED`
  present and retryable; every `retryAfterMs` belongs to a retryable code.
- `helpers/mac/Tests/refusal.mjs` passes without the denylist.
- `capture-finalizing.test.ts` cases for stored finalization errors updated to the ledger verdicts.

## Delegated

Names of split codes (as recorded in 01).

## Stays green

Every test that asserts a specific code's retryability, updated to the new verdicts in the same
change (list them in the commit message).

## Immutable-input review verification

Captured bytes and journals are immutable retry inputs. Their absent content or conflicting
authority settles unavailable, while reader/verifier bugs and operational access failures
remain retryable. The ledger and [audit](../error-verdicts.md) carry the corrected decisions;
Swift continues to derive the publication split from that one owner.

The rebuilt recovery gate and default suite pass. [Per-selector and per-file results](../assets/verification/05-ledger-verdicts.md)
record the red/green evidence and the one historical-donor performance probe that could not
be verified within the task's media restriction.
