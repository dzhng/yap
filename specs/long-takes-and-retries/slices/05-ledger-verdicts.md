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
