# 09 Background job priority

**Contract unlocked:** automatic work can never delay work a person or agent asked for.

**Seam:** `priority: "interactive" | "background"` on job submission in `packages/core/src/jobs.ts`.
- Lane pick: the oldest interactive job first; background only when no interactive job is
  queued. The heavy lane stays one slot (`jobs.ts:29`); a running background job is not
  preempted.
- Background jobs sit outside the 32 queued / 32 waiting limits (`jobs.ts:34-35,1264-1290`)
  with their own explicit bound, and never enter `waiting` (D22), so `updateBlocked`
  (`jobs.ts:335-341`) is unaffected by work the backlog has not submitted.
- An identical interactive request joins the background job and promotes it to interactive.
- Starting a capture still stops new heavy jobs from starting (`jobs.ts:968`).

**Verify:** `jobs.test.ts`, `job-admission.test.ts`: an interactive job jumps a queued
background job; it does not preempt a running one; a join returns the same job id and
promotes it; 33 background submissions do not fail; the update gate is unchanged.

**Delegated:** the background bound's value.
**Firewall:** no change to ordering among interactive jobs or to lane concurrency.
