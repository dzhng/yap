# 01 — Error audit

Depends on: nothing. Changes no product behaviour.

## Contract

`specs/long-takes-and-retries/error-verdicts.md`: every error code with a reasoned verdict that
slices 04–06 and 12 apply as written.

The rule: **an error is non-retryable only when re-running the same request can never
succeed** — bad parameters, a reference that doesn't exist, something deleted. Our own files,
our code and the machine are retryable. A cancel is retryable.

## Seam

Inventory sources:
- all codes in `packages/protocol/src/refusal-ledger.json` (228 at planning time, 51 retryable);
- the helper denylist `helpers/mac/Sources/YapCapture/CaptureTypes.swift:160`;
- hand-set `retryable` literals: `apps/service/src/project-service.ts` (~1999-2068),
  `portable-speakers.ts:184`, `apps/service/src/main.ts:59`, `apps/cli/src/main.ts:426`,
  `apps/cli/src/wait.ts:173,474`;
- Swift app codes (`APP_STARTING` in `main.swift:257`, `UPDATE_BUSY` in
  `UpdateCoordinator.swift:83`, `ExportController.swift:134`, and the rest of
  `apps/macos/Sources`): extend the ledger scanner roots (`refusal-ledger.test.ts:13-20`) to
  `apps/macos/Sources` in this slice so the inventory is complete; the scanner change is the
  only code change here;
- codes the scanner misses: single-quoted SQL (`JOB_INTERRUPTED`, `jobs.ts:402,1175`), joined
  strings (`project-service.ts:1459`), backtick codes (`capture.ts:779`);
- rows without a code: cancels and `${kind}_unavailable` discards (`jobs.ts:1112,1301,1395,1449,1562`);
- capture finalization errors (`capture.ts:558-571`, wrapper vs cause in `Wire.swift:80-85`).

One row per code: code, category, producers (file:line), retryable today, verdict, one-line
reason, `retryAfterMs` if it is a "wait" code, plain-language `cause` for people, and for app
codes the treatment (Retry / fix action / prevent / status text, per decision Q12).

Must decide explicitly:
- `INVALID_EVIDENCE`: our capture journal (retryable; the origin take depends on it) vs a
  caller-supplied package (non-retryable). Split into two codes if any producer is caller input.
- `NOT_READY`: "wait" (retryable, 15 000 ms) vs "this pinned implementation is gone"
  (`frame-inspection.ts:980`, `project-preview.ts:144,254`, `index-processing.ts:337`,
  `audio-inspection.ts:606`, `acoustic-inspection.ts:767`) which gets a new code. Note
  `exports.ts:984` keys on the code.
- `JOB_FAILED` (plain executor errors) and `JobDependencyLost` (should use `DEPENDENCY_LOST`).
- Codes for cancel and owner-gone discards.
- The ~40 codes where the helper and the ledger disagree.

## Run or see

The verdict file, plus a completeness check (a throwaway script or a test) listing any ledger
code or scanned literal missing from it. It must print nothing.

## Verification

Completeness check empty; every changed verdict has a reason; the origin failure's code is
marked retryable.

## Delegated

File layout; per-code wording of `cause`.

## Stays green

`refusal-ledger.test.ts` after the scanner extension (update per-file counts it reports).

## Review

Checkpoint H1, non-blocking (see README).

## Implementation record — 2026-10-20

[Error verdicts](../error-verdicts.md) holds one row per code (273 rows: 208 retryable, 45 not,
20 non-error tokens), producer anchors, labelled inferences, the helper/ledger disagreements, the
app overrides and a completeness command that prints nothing. 129 codes move from non-retryable
to retryable; `ACQUISITION_NOT_FOUND` moves the other way. Proposed new codes:
`INVALID_INPUT_EVIDENCE` (caller evidence), `PINNED_IMPLEMENTATION_UNAVAILABLE` (vanished pin),
`OWNER_DELETED` (discarded owner). Wait codes carry an advisory 15 000 ms.

Code changes: the scanner covers `apps/macos/Sources` (40 newly classified literals; existing
verdicts untouched until slice 05), and two app messages no longer embed a code
(`ExportController.swift:261`, `LibraryController.swift:49`), which the scanner extension
exposed. `refusal-ledger.test.ts`: 7 passed.

Open for slice 06: confirm which `jobs.ts` discard sites are user cancels (retryable `CANCELED`)
and which are deleted owners (`OWNER_DELETED`); the audit lists `jobs.ts:1395` under
`OWNER_DELETED`, but the planning sweep identified it as the user-cancel path.

H1 (errors): opened for the user at 14:08 with a summary; no response by 14:13. Decision: the
verdicts stand as written, on the evidence in the verdict file. Slice 05 applies them.
