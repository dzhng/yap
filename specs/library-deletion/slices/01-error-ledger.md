# 01 Retryability per error code

**Contract.**
- **One ledger.** Every refusal code has exactly one category and one `retryable`,
  both stored in `packages/protocol/src/refusal-ledger.json`.
- **TypeScript.** `CatalogError(code, message, details)` reads its retryability
  from the ledger. The fourth constructor argument is deleted.
- **Swift.** `NativeFailure` drops its `retryable` field. The service looks native
  codes up in the same ledger.
- **Code changes:**
  - `UNKNOWN_MODEL` becomes `NOT_FOUND` with `details.kind: "model"`.
  - `INVALID_CURSOR` becomes `INVALID_PARAMS`.
  - `NATIVE_DECODE_FAILED` becomes non-retryable (`NativeFailure.swift:19-21`).
  - Errors that aren't `CatalogError`s are no longer retryable by default (`jobs.ts:306`).
  - The deletion wrappers stop re-throwing errors as retryable (`deletion.ts:53-55`
    and `project-deletion.ts`).
- **New codes:**
  - `IN_USE`: not retryable.
  - `ASSET_DELETED`: not retryable.
  - `MODEL_IN_USE`: retryable.
  - `DELETE_IN_PROGRESS`: retryable.

**Seam.** The ledger and its existing test, `refusal-ledger.test.ts`, which is
extended so that every code must declare `retryable`. A second test asserts every
Swift failure code appears in the ledger.

**Run or see.** `yap model.status --params '{"modelId":"nope"}'` returns
`NOT_FOUND`, `details.kind: "model"`, `retryable: false`.

**Verify.** Red tests first: one per changed code at its owner (for example, a job
failing with a plain `Error` comes back `retryable: false`), plus a Swift unit
test for the native mapping. Update `skills/yap` wherever it names a changed code.

**Firewall.** No paging, deletion or naming changes.

**Delegated.** If probe P4 finds a code thrown with both retryable values, split it
and name the two new codes. Report each split in the README ledger.

**Stays green.** Every existing test, unless it asserts a retryable value that this
slice deliberately changes. Fix those to the new truth; never loosen a check.

**Would change this slice.** The user wanting a specific code kept retryable.
