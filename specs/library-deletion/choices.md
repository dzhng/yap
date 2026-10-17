# Choices ledger

Decisions made during implementation where the spec was silent or turned out to be
wrong. Each entry stands alone. Verdicts: **sound** (keep), **provisional** (revisit at
the named point), **user** (the user may want to weigh in; the recorded call stands
until they do).

## Slice 01: retryability per error code

- **Unknown errors stay retryable** (sound). The spec said errors that aren't a known
  refusal should become non-retryable. That broke 41 tests, each pinning a real
  contract: after an ordinary unexpected failure, an explicit retry must be possible.
  An unknown error may well be temporary. The audit's real problem was known,
  deterministic codes marked retryable, and the ledger fixes those.
- **One code per condition, not per call site** (sound). Where one code had been thrown
  both ways, the two meanings became two codes (table in
  [slices/01-error-ledger.md](slices/01-error-ledger.md)). The established name keeps
  its established meaning; the new name describes the other condition.
- **Retryability was preserved site by site** (sound). The first draft guessed ledger
  values; a script then compared every literal call at the pre-slice revision with the
  ledger and found 70 sites whose behaviour had silently changed (`UNSUPPORTED_MEDIA`
  made retryable, 23 permanent `NOT_READY`s made retryable, nine capacity limits made
  permanent, and more). Each was renamed to a code with its old meaning:
  `PREREQUISITE_MISSING`, `OWNER_CLOSED`, `CAPACITY_EXCEEDED`, `INVALID_RESPONSE`,
  `DEPENDENCY_LOST` or `PACKAGE_STORAGE_UNAVAILABLE`.
- **One code for temporary capacity** (sound). Request admission, delivery leases and
  queue pressure were three spellings of "capacity is full, retry later", so they
  share `CAPACITY_EXCEEDED`. `LIMIT_EXCEEDED` now means only a fixed bound.
- **Dependency refusals keep their cause** (sound). Eleven sites reported a
  dependency's failure under their own code, with the dependency's retryability.
  `dependencyRefusal` keeps that code when the ledger agrees, and otherwise reports
  `DEPENDENCY_FAILED` or `DEPENDENCY_REFUSED`, with the original in
  `details.dependencyCode`.
- **Recovery answers with a classified pair** (sound). Swift recovery decides retry
  policy from its own deny-list, and the same capture codes mean different things
  outside recovery. Recovery refuses as `RECOVERY_FAILED` or `RECOVERY_REFUSED`, with
  the specific code in `details.cause`, and the service records that cause as the
  take's diagnostic. `NativeFailure` gained string `details` to carry it. Rejected:
  a parity test between the deny-list and the ledger. It failed on 40 codes because
  those codes legitimately mean other things outside recovery.
- **A failed workspace creation is `PACKAGE_STORAGE_UNAVAILABLE`, retryable** (sound).
  It was `INVALID_STORAGE` with a hand-set retryable flag, which the first derivation
  missed because the flag sat on its own line. The draft compensated with a service-side
  rewrite keyed on the error *message*, now removed. A replaced or linked directory stays
  `INVALID_STORAGE`, not retryable, which native tests pin. A directory that changed
  while being opened is `STORAGE_CHANGED`, retryable, as before.
- **`ARTIFACT_CHANGED` is not retryable; an evicted prerequisite is `DEPENDENCY_LOST`**
  (sound). A stale pin never succeeds on an identical retry. Acoustic inspection's
  "prerequisite was evicted" is rebuilt by an explicit retry, which is a different
  condition.
- **Single-word codes are scanned where refusals are built** (sound). The ledger
  scanner only matched codes containing an underscore, so `TIMEOUT`, `UPDATING`,
  `UNAVAILABLE`, `ABORTED`, `CANCELED` and `CONFLICT` were missing and silently
  defaulted to not retryable. They are now recognised as the first argument of an
  `Error`, `operationError` or `NativeFailure` constructor.
- **Test fixtures throw real codes** (sound). Seven invented test codes had been
  added to the product ledger. Fixtures now throw real codes with the retryability
  they need (mostly `MEDIA_WORKER_FAILED`), and the ledger test requires every code to
  appear in product source.
- **New deletion codes arrive with their slices** (sound). The ledger test forbids codes
  that no product code throws, so `DELETE_IN_PROGRESS`, `IN_USE`, `ASSET_DELETED` and
  `MODEL_IN_USE` enter in slices 03, 04/08 and 11.
- **Malformed CLI replies are `INVALID_RESPONSE`; an unrunnable worker is
  `MEDIA_WORKER_NOT_RUNNABLE`** (sound). Both had shared a retryable code with
  temporary failures. Exhausting descriptors or processes stays
  `MEDIA_WORKER_UNAVAILABLE`, which is retryable.
- **`CONNECTION_CLOSED` and `CONNECTION_ERROR` are retryable** (sound). The CLI had
  always treated every `CONNECTION_*` error as retryable, and the ledger now records
  that.
- **Re-throws that forced retryability were checked too** (sound). The first site
  comparison only covered literal codes. A second pass found base re-throws that kept a
  dynamic code but forced `retryable: true`. Assembly cleanup stays retryable through
  `dependencyRefusal` (an export's recovery is pinned as retryable until its owned
  identity returns). `FFMPEG_UNAVAILABLE` is retryable, as it was everywhere it was thrown.
  Recording deletion, export retirement and failed workspace admission keep their pinned
  codes and take the ledger's retryability for them; their intents stay durable, so
  startup resumes them regardless.

## Slice 02: deletion coordinator and plans

- **Plan phases are `planned`, `tombstoned`, `drained`, `files` and `rows`** (sound).
  Each phase is written only after its work is complete, so a restart repeats at most
  an idempotent phase and never reports success before the plan row is cleared.
- **The test seam reports boundaries as `check`, `plan`, `tombstone`, `drain`,
  `files`, `rows` and `clear`, before and after each durable phase write** (sound).
  The hook is constructor-only and has no public operation or persisted effect.
- **Project `deletedAt` remains its durable tombstone** (sound). Project row
  retention is existing request/history behavior; clearing the deletion plan is the
  coordinator's terminal cleanup for projects, while recording tombstones are removed
  by their existing final row cleanup.
- **Existing tombstones are adopted as `tombstoned` plans** (sound). This keeps
  legacy markers on the same active-map, scoped retirement and paged resume path
  without a second cleanup implementation.
- **Recording source retirement owns one scope across all post-tombstone phases**
  (sound). Queue drain happens immediately before `CaptureSources.retire`; its
  lifetime and retiring fence then cover quiesce, file removal, row cleanup and
  finish, including retries after a phase fault.
