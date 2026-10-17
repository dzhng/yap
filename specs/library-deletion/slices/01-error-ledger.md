# 01 Retryability per error code

**Contract.**
- **One ledger.** Every refusal code has exactly one category and one `retryable`,
  both stored in `packages/protocol/src/refusal-ledger.json`.
- **TypeScript.** `CatalogError(code, message, details)` reads its retryability
  from the ledger. The fourth constructor argument is deleted.
- **Swift.** `NativeFailure` drops its `retryable` field. The service looks native
  codes up in the same ledger.
- **Every refusal builder reads the ledger.** `operationError(code, message, details)`
  and the CLI's `failure()` and `ArtifactDeliveryError` lost their own `retryable`
  argument too, so nothing states retryability except the ledger.
- **Dependency refusals.** A refusal that reports a dependency's failure uses
  `dependencyRefusal(code, message, details, dependencyRetryable)` (`catalog.ts`). It keeps the
  dependency's code when the ledger agrees with how that dependency can be retried, and
  otherwise reports `DEPENDENCY_FAILED` (retryable) or `DEPENDENCY_REFUSED` (not), with the
  original code in `details.dependencyCode`.
- **Code changes:**
  - `UNKNOWN_MODEL` becomes `NOT_FOUND` with `details.kind: "model"`.
  - `INVALID_CURSOR` becomes `INVALID_PARAMS`.
  - `NATIVE_DECODE_FAILED` becomes non-retryable (`NativeFailure.swift:19-21`).
  - A malformed CLI reply is `INVALID_RESPONSE` (not retryable), not `MEDIA_WORKER_FAILED`.
  - A worker that cannot be spawned for any reason other than descriptor or process
    exhaustion is `MEDIA_WORKER_NOT_RUNNABLE` (not retryable).
  - `CONNECTION_CLOSED` and `CONNECTION_ERROR` are retryable, as the CLI always treated them.
  - The deletion wrappers stop re-throwing errors as retryable (`deletion.ts:53-55`
    and `project-deletion.ts`).
  - Unknown errors (not a `CatalogError`) stay retryable: they may be transient, and the
    deterministic failures are known codes in the ledger. An earlier draft of this slice
    made them non-retryable; 41 core tests showed it broke every explicit retry after an
    ordinary failure, so it was withdrawn.
- **New codes enter the ledger with the slice that first throws them.** The ledger test
  requires every code to appear in product source: `DELETE_IN_PROGRESS` (retryable) in
  slice 03, `IN_USE` and `ASSET_DELETED` (not retryable) in slices 04 and 08, and
  `MODEL_IN_USE` (retryable) in slice 11.

**Seam.** The ledger and its existing test, `refusal-ledger.test.ts`:
- every code declares `retryable`;
- the scanner also recognises single-word codes (`TIMEOUT`, `UPDATING`, `UNAVAILABLE`, ...)
  where a refusal is built, so no code silently defaults;
- every Swift `NativeFailure` code appears in the ledger;
- **recovery classification:** Swift recovery decides its own retry policy from a fixed
  deny-list (`CaptureFinalizationError`). It refuses over the wire as `RECOVERY_FAILED`
  (retryable) or `RECOVERY_REFUSED` (not), with the specific code in `details.cause`, so the
  ledger's one answer per code never contradicts a recovery decision. The service records
  the cause as the take's diagnostic code. `NativeFailure` gained string `details` for this.

Test fixtures throw real ledger codes with the retryability they need; the ledger never
holds a code that exists only in tests.

**Run or see.** `yap model.status --params '{"modelId":"nope"}'` returns
`NOT_FOUND`, `details.kind: "model"`, `retryable: false`.

**Verify.** Red tests first: one per changed code at its owner (for example, a job
failing with a plain `Error` comes back `retryable: true`), plus a Swift unit
test for the native mapping. Update `skills/yap` wherever it names a changed code.

**Firewall.** No paging, deletion or naming changes.

**Delegated.** If probe P4 finds a code thrown with both retryable values, split it
and name the two new codes. Report each split in the README ledger.

**Final splits.** Where one code meant two conditions, each condition got one code:

| Code | Retryable | Condition |
|---|---|---|
| `ARTIFACT_CHANGED` / `DEPENDENCY_LOST` | no / yes | a stale pinned identity / an evicted prerequisite that explicit retry rebuilds |
| `LIMIT_EXCEEDED` / `CAPACITY_EXCEEDED` | no / yes | a fixed size or work bound / temporary capacity (request admission, delivery leases, queue pressure) |
| `NOT_READY` / `PREREQUISITE_MISSING` | yes / no | a prerequisite that will still arrive / one retrying will not supply (a missing runtime or implementation, an unindexed generation, "prepare first") |
| `SERVICE_STOPPED` / `OWNER_CLOSED` | yes / no | a lifetime that can reopen / an owner that has closed (capture, delivery, package registry, project packages) |
| `INVALID_STORAGE` / `PACKAGE_STORAGE_UNAVAILABLE` | no / yes | invalid identity or shape / recoverable package I/O |
| `INVALID_RESPONSE` / `CONTROL_RESPONSE_INVALID` | no / yes | a malformed reply / an unreadable control answer whose outcome is unknown |
| `NOT_FOUND` / `ACQUISITION_NOT_FOUND` | no / yes | a durable absence / a donor that can reappear |
| `INVALID_PATH` / `ACQUISITION_PATH_UNAVAILABLE` | no / yes | a malformed path / donor access that can recover |
| `MEDIA_WORKER_UNAVAILABLE` / `MEDIA_WORKER_NOT_RUNNABLE` | yes / no | descriptor or process exhaustion / a worker that cannot run |
| `DEPENDENCY_FAILED` / `DEPENDENCY_REFUSED` | yes / no | a dependency failure explicit retry can repeat / one it cannot (via `dependencyRefusal`) |
| `RECOVERY_FAILED` / `RECOVERY_REFUSED` | yes / no | per Swift recovery's classification, cause in `details.cause` |

`MEDIA_WORKER_FAILED` stays retryable only for a crash or missing result; malformed worker
output is `INVALID_RESPONSE` and output past its byte bound is `LIMIT_EXCEEDED`.
`UNSUPPORTED_MEDIA` is not retryable.

**How the values were derived.** A script read every `CatalogError` and `operationError`
call at the pre-slice revision (`a82dea44`) with a literal code and retryable flag, and
compared each with the ledger. Every site whose old behaviour disagreed was renamed to the
code that keeps it, so retryability is unchanged except for the deliberate changes above.

`PROCESSING_BUSY` was not split: an active file read drains like any other busy owner.

**Stays green.** Every existing test, unless it asserts a retryable value that this
slice deliberately changes. Fix those to the new truth; never loosen a check.

**Would change this slice.** The user wanting a specific code kept retryable.
