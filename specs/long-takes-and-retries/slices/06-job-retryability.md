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
