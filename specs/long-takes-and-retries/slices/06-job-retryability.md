# 06 — Job retryability from the code; no automatic failure retries

Depends on: 05.

## Contract

- A job's `retryable` is `refusalRetryable(errorCode)` at read time. A failure stored as
  non-retryable becomes retryable when its code's verdict changes; this is how the origin take
  recovers, with no recovery code.
- A failed job's projection carries `details.retry: {operation: "job.retry", params: {jobId}}`.
- Retry is explicit. `submit()` keeps returning an existing failed job unchanged
  (`jobs.ts:608`); no read, poll, wait or startup path reruns a failure.
- Finishing interrupted work stays: deletions, export cleanup, stranded takes, first imports.

## Seam

- `packages/core/src/jobs.ts`: the job projection (~229), `retry()` (~676) and package retry
  (~510) read the ledger. Register `ledger_retryable(code)` on the `DatabaseSync` next to
  `job_input_digest` (~369); retention SQL (`retainInputs` ~1203, `retainsInput` ~1214,
  `releaseFinishedInputs` ~1240) calls it. The `retryable` column is still written (it is
  `NOT NULL`) but never read.
- Rows without a code: cancels write the cancel code from 01; owner-gone discards write theirs.
  Historical null-code rows are interpreted at read time from `state`/`reason` (no backfill).
- Plain executor errors and `JobDependencyLost` use the codes 01 decided.
- Remove automatic failure retries:
  - `packages/core/src/transcript-backlog.ts`: delete the retry counter logic (~33, ~130-144);
    failed or canceled work leaves the backlog; the `retries` column stays, unread. A missing
    model may still wait for readiness (that is not a failure).
  - `apps/service/src/capture.ts` `reconcileStranded()` (~294-309) and `reconcile` (~497-499):
    startup skips takes with a recorded finalization error; `capture.stop` (Retry Finalization)
    stays the explicit retry. Pin today's behaviour with a test first, then change it.
- `recording-prompt.ts:150-154` "pending" claim: a failed transcript is no longer pending once
  the backlog drops it.

## Run or see

In a temporary `YAP_HOME`, a capture fixture whose import fails, then `yap recording.get`
(shows `details.retry`) and `yap job.retry` (imports).

## Verification (red first)

- `jobs.test.ts`: a row inserted through the production failure path with a code whose verdict
  is now retryable but whose stored bit is 0 → `retry()` queues it and its inputs are retained.
- `jobs.test.ts`: a canceled job retries; an owner-gone discard does not.
- `jobs.test.ts:1678` stays: dependency admission never retries a failed dependency.
- `transcript-backlog.test.ts`: a failure is left alone.
- `capture-finalizing.test.ts`: a recorded finalization failure is not retried at startup;
  `capture.stop` retries it.
- `apps/service/src/project-capture.test.ts` (~540): failed import → `job.retry` → ready.

## Delegated

SQLite function name; historical null-code interpretation details.

## Stays green

Attempt draining and fencing, donor retention, deletion safety (`library-users.ts` ignores job
references), stranded-take recovery, first admission.

## Implementation and evidence

Implemented in the working tree, without committing. The ledger is the only read authority;
`ledger_retryable(code)` shares the connection with `job_input_digest`. Both obsolete catalog
columns remain in place; neither is selected by runtime code. Public failed-job records add
`details.retry`; the existing `errorDetails` diagnostics keep their meaning.

Discard classification follows the call paths:

- `project-service.ts` public `job.cancel` → `drainJob` → `cancel` → `discard("canceled")`,
  and `cancelContextJob`, use `CANCELED`. `CaptureSources.retire` also drains individual
  borrowers through this path: that transient donor fence does not delete their acquisition
  owner. Export retirement drains individual jobs before forgetting them.
- Recording/project/asset/acquisition retirement registrations → `drainOwner` use
  `OWNER_DELETED`. So do `resumeAdmission` when `isDeleting`, and `claim`/`settle` when
  `isAvailable` fails. These retain the owner kind and ID in diagnostics.
- `closeContext` uses `CONTEXT_CLOSED`: its process-local handle cannot be retried.

Historical null codes are interpreted by one SQL expression shared by projections and
retention: canceled + `reason=canceled` → `CANCELED`; other canceled outcomes →
`OWNER_DELETED`; failed + `reason=interrupted` → `JOB_INTERRUPTED`; other failures →
`JOB_FAILED`; unavailable → `UNAVAILABLE`; active/ready outcomes keep a null code. Unknown
canceled reasons conservatively mean an unavailable owner. No rows are backfilled.

Red/green evidence uses generated fixtures only. The capture-import test drives the public
socket with a production-written journal/video and native publication/import. A real SQLite
trigger failure produces `JOB_FAILED`; only the obsolete stored bit is then changed to zero.
Reopening leaves that attempt failed, `recording.get` supplies its resolving call, and that
exact `job.retry` imports the same acquisition. Against the original job reader this test was
red (`retryable=false`, missing `details.retry`). The core regression also sets the old bit
inside settlement, proving both input-release passes retain the inputs; restoring the old
release SQL makes it fail with lost inputs.

Startup finalization was characterized before changing it: reconciliation made a second
attempt. The revised test was red (2 attempts instead of 1), then green: startup preserves the
recorded error and `capture.stop` recovers it. Restoring the old backlog made the service
regression red with 8 native transcription attempts instead of 2. Model readiness and first
admission still proceed. No user library or origin take was accessed; final origin acceptance
remains with slice 13.

Focused verification passed: 101 core tests (jobs, backlog, prompt), 51 service capture tests
(finalizing, capture projection, source lifetime), 2 service backlog failure cases, and 16
ledger/deletion-reference tests. Core build and core/service type checks passed. Native helper
and fixture-writer builds passed with the native build system. Focused lint reported no errors
and two existing unused-parameter warnings outside the changed test. The independent read-only
Codex review returned no verdict because its selected model was at capacity; the local
shape/diff/docs review and the Contract/Verification checklist found no remaining slice gap.
