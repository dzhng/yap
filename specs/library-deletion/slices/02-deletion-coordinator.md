# 02 One deletion coordinator and deletion plans

**Contract.**
- **One coordinator.** `LibraryDeletion` (in `apps/service`) replaces
  `RecordingDeletion` and `ProjectDeletion`, whose shared shell (active map, abort
  lifetime, paged resume, `updateBlocked`) is duplicated today.
- **Interface.** `delete(subject, {cascade})` and `resume()`. Each kind registers
  its retirement steps once.
- **Behaviour is unchanged in this slice.** Recording and project deletes act
  exactly as before.

**New tables** (`DeletionPlans` in `packages/core`, created idempotently, catalog
format stays 29):
- `deletion_plans(subjectKind, subjectId, cascade, phase, createdAt)`
- `deletion_plan_members(subjectKind, subjectId, memberKind, memberId)`

**Ordering, for every subject:**
1. Check users (slice 04 provides the query; until then the check is empty).
2. Write the plan and its members in one transaction.
3. Mark the tombstone.
4. Drain jobs.
5. Remove files.
6. Delete rows, in pages.
7. Clear the tombstone and the plan.

`resume()` replays the stored plan and never re-checks users. A
`recording_deletions` row without a plan row resumes with the old semantics.

**Seam.** `LibraryDeletion` with a fault-injection hook at every phase boundary
(test only).

**Run or see.** The existing recording and project deletion probes behave exactly
as before.

**Verify.**
- `deletion.test.ts`, `project-deletion.test.ts`, `lifetime.test.ts` and the
  deletion restart test pass unchanged.
- New: inject a failure at each phase, close and reopen, and assert that files and
  catalog rows never disagree and that success is never reported early (probe P6).
- New: a format-29 catalog opened twice (probe P5).

**Firewall.** No public schema change. No new subject kinds yet.

**Delegated.** Phase names, column types and indexes, and the hook mechanism.

**Stays green.** Every existing deletion test, unmodified.
