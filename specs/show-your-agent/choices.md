# Choices ledger

Decisions made during implementation where the spec was silent. Each entry: the choice, why,
and a verdict (sound / provisional / user-only). Consolidated at closeout.

## Slice 09 (background priority)

- **Background jobs never block app updates, queued or running** (`jobs.ts` `updateBlocked`).
  Why: a long transcription backlog must not hold an update for hours. Consequence: an update
  can interrupt a running background transcription; slice 10's backlog resubmits it after
  restart. Verdict: sound, with that slice 10 obligation.
- **Background bound is 256 queued-or-running jobs**, refused with `CAPACITY_EXCEEDED`
  beyond it. Why: the slice delegated the value; 256 covers a large batch import's audio
  streams. Verdict: sound.
- **Existing catalogs gain the `priority` column by `ALTER TABLE … ADD COLUMN`, default
  `interactive`**. Why: follows the existing pattern in `imported-transcript.ts:109-119`; the
  catalog format stays 29. Verdict: sound.
- **Package-context jobs still count toward the interactive queued limit whatever their
  priority.** Why: context jobs are always interactive today. Verdict: sound until a
  background context job exists.
