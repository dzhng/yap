# 13 — Docs, full run, release, acceptance

Depends on: all.

## Contract

The release candidate recovers the origin take with one Retry, and the docs describe the implemented contracts.

## Steps

1. Docs, alongside the behaviour they describe if not already done:
   - `skills/yap/SKILL.md` paste section (~14-26): the prompt describes; to read marks, call
     `recording.get`, wait for its import (`--wait`), then `timeline.events`. How to treat
     `retryAfterMs` and `details.retry`. Remove "a read never retries" phrasing only where it
     became untrue (it stays true).
   - `skills/yap/references/capability-catalog.md` (~50-61), `apps/cli/README.md`,
     `operations.ts` descriptions (~1631), `helpers/mac/Sources/YapCapture/README.md`.
   - `specs/show-your-agent/README.md` D2 row and slice 12: note the prompt change and link here.
   - A new `scripts/release-notes.md` entry (don't edit published entries).
2. Agent check: give a fresh Claude Code and a fresh Codex session a prompt for a take that is
   still importing (scratch take, not the origin) and confirm each waits as `retryAfterMs` says
   and reads the marks once ready. Record what each did.
3. `review` skill pass (refactor-clean, code-review, write-docs).
4. Full repository check, once. Fix failures with focused reruns.
5. Release with the `release` skill. Verify installed app, CLI, service and bundled skill versions.
6. Acceptance on the installed build: open the Library, find take
   `99099abb-fb1c-4018-a364-b263dcd58057`, press Retry. Confirm it imports, then Copy prompt
   (approved shape, pins and strokes line present) and Play. Record versions and outcome in this
   spec.
7. `close-spec`.

## Never

Touch the origin take's files or catalog rows before step 6.

## Full-run triage

The prepared-input full runs and baseline comparison were supplied to the triage pass; only
focused checks and affected-package runs were repeated. See the
[triage record](../assets/verification/13-full-run-triage.md) for contract corrections, remaining
baseline/environment failures, commands and evidence. The origin take remains untouched;
release, agent acceptance and installed acceptance are still outstanding.

The subsequent [whole-diff review fix round](../assets/verification/13-review-fixes.md)
records the prior review dispositions and evidence, committed in `2b664fbce`.


The [second review round](../assets/verification/13r2-review.md) records every finding,
regression proof and final check, including baseline and live-session limits.
