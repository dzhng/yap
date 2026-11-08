# App failure evidence

Slice 12 retains failure ownership with the originating surface and request. Import Retry
uses the primary admission's projected `job.retry` request. The socket-boundary check
runs the production Library controller and service host; its transport peer forwards
requests unchanged to the fake service's scratch socket. No user library or recording
was read. Media needed by neighboring checks came from their generated fixtures.

The before captures were taken before production UI changes. The native fixtures render
offscreen with synthetic observations, without device or permission reads. The after
Library shots share the same take, with failed, queued and ready primary-job observations;
the never-on camera remains unavailable in all three. Source hashes and native dimensions
sit beside each surface's captures. Unrelated shots emitted by the same renderers were
removed; their successful assertions still ran.

- [Failed row before](before/library/failed-import.png) and [after](after/library/failed-import.png).
- [Retrying row](after/library/retrying-import.png) and [recovered row](after/library/recovered-import.png).
- [Capture failure before](before/capture/failure.png) and [after](after/capture/failure.png).

[File-by-file changes](files-changed.md) record the scoped diff.

## Visual revision round

The after captures at the same paths now separate the short import state from its
metadata and explanation. “Import failed” alone uses the warning colour; duration,
microphone facts and the approved safety message use secondary text. “Importing…”
names pending work. Retry aligns with the visible text inset. Capture errors retain
the originating request’s action name, and Retry precedes Dismiss on one compact row.
All four after scenes were recaptured offscreen; the before captures were preserved.

Plain-language editing changed 158 ledger causes without changing their verdicts,
retry delays or inventory. The saved-details cause reads “Yap couldn't read the
details it saved with this recording.” The cause remains owned by the ledger;
request-action wording belongs to the app’s failure value.

Red/green checks observed the old “Attention” label, missing failed-action lead-in,
vertically stacked failure buttons and internal saved-evidence cause fail before
their fixes. The Library socket journey then passed with the approved message and
“Importing…”, exact-job Retry, enabled Play/Copy and ready recovery. The native
capture renderer asserts compact buttons on one row. Native controls passed all
32 scenario reports, the two focused Library/export test files passed 5 checks,
and the ledger passed 11 tests. The remaining affected app files listed below ran
44 checks: 43 passed and the Sparkle check lacked its framework input. Rerunning
`YAP_SPARKLE_FRAMEWORK=/Users/david/dev/screen-recorder/dist/sparkle/Sparkle.framework node --test apps/macos/tests/update-sparkle.test.mjs`
passed that check, giving 49 distinct app checks passing in this round. Both final
offscreen renderers and the final native
app build passed. One intermediate render compile failed on an ambiguous CGFloat
constant and passed after specifying its type. The app build still reports the
existing Sendable callback and camera-ID nil-coalescing warnings outside this work.

Spacing choices use the existing label inset and secondary-button styling. No
extra failure state, replay machinery or app window was introduced. Screenshot
critique, comparison and H3 remain with the orchestrator. Local shape, diff and docs
review found no further issues. A fresh read-only `codex exec ... review --uncommitted`
attempt exited 1 with `turn.failed` / “Selected model is at capacity”; it supplied
no completed independent verdict.

## Initial implementation verification

All commands ran in this checkout. No commit, installed-app launch, macOS Preview launch,
full repository test run or origin-take acceptance was performed.

- `YAP_SPARKLE_FRAMEWORK=/Users/david/dev/screen-recorder/dist/sparkle/Sparkle.framework CI=1 node scripts/build-macos.mjs`: pass. The prepared framework is an unchanged dependency input; native/app build outputs remain local to this checkout. An initial FFmpeg input symlink was preserved into the bundle and failed signing verification. Replacing it with a local APFS clone allowed the documented build to pass.
- `YAP_SPARKLE_FRAMEWORK=/Users/david/dev/screen-recorder/dist/sparkle/Sparkle.framework swift build --build-system native --package-path apps/macos --product Yap --jobs 2`: pass on final source.
- `swift run --build-system native --package-path apps/macos --jobs 2 YapControlsTests`: pass, 32 scenario reports.
- Focused `node --test --test-concurrency=1` groups: 49 distinct checks passed. Files: `app-socket`, `bundled-runtime`, `service-errors`, `library-controls`, `export-controls`, `project-export-controls`, `preview-controls`, `library-preview-bridge`, `preview-service`, `preview-player`, `preview-window`, `capture-admission`, `capture-start-interruption`, `settings-shortcut-recording`, `update-coordinator`, `update-service-host`, `update-settings`, `update-sparkle` (all under `apps/macos/tests`, with `.test.mjs` suffix). Player checks used `YAP_FIXTURE_CONTROLS=1`, keeping native test windows behind the session. The new failed-import case also passed independently after strengthening its enabled-action assertion.
- `bun run --cwd packages/protocol test src/refusal-ledger.test.ts`: pass, 10 tests. Removing the impossible Export Retry refusal made the exact inventory red on its one deleted `NOT_READY` occurrence; that count alone was removed from the ledger.
- `SHOTS=<surface-output> node apps/macos/tests/library-view-shots.mjs` and the corresponding `capture-view-shots.mjs`: pass before/after; native inline Retry dispatch is asserted in the final Library fixture.
- `oxlint` on changed JavaScript checks/helpers and `git diff --check`: pass. `oxfmt --write` was limited to changed JavaScript files.

Expected red runs preceded the fixes: the import row had only its duration; playback/prompt
errors offered a recording Retry; unrelated source reads erased a retained start; exports
without a job could retry; the row had no inline Retry; a refused start reused its terminal
request ID. Success-feedback tests were falsified by removing the controllers' resolution
reports, failed, then passed after restoration. One neighboring compile timed out while
release compilation held SwiftPM's build lock; it passed once that build completed. The
historical bridge's assertion was updated from a diagnostic code prefix to its plain message.

## Choices

- Unsupported app-error actions use plain status and Dismiss under Q12; permission fixes keep the existing permission controls. No relaunch or generalized replay mechanism was added.
- Inline Library Retry makes the repair action visible; Play, Copy prompt and Delete retain their existing menu actions.
- Start Retry preserves the failed selection and uses existing admission: uncertain starts replay, definite refusals allocate fresh admission. A successful retry resolves the notice it came from.
- Capture-panel Last recording actions keep capture-scoped failures; Library actions keep Library-scoped failures. Preview/export feedback includes the existing action identity and nil on success so unrelated actions cannot erase a notice.
- Plain causes come from the existing Swift ledger reader, exposed to controls through the media product; no copied cause table was added.

The independent Codex review found three issues: definite-refusal start identity, originating
surface for Last recording actions, and resolving preview/export notices after success. All
three were fixed, with red/green coverage for admission and resolution. Both follow-up review
attempts ended with “Selected model is at capacity” / `turn.failed`; neither is a clean review.
The [Codex procedure](../../../../.agents/skills/codex/SKILL.md) says “A timeout, `turn.failed`, or
missing verdict is incomplete, never a clean review.” Local shape/diff/docs review and focused
checks completed; an independent clean follow-up remains unverified.

Screenshot critique, before/after comparison and H3 are reserved for the orchestrator, as
requested. These captures have not been accepted by those reviews. Installed-app journeys
remain outside this no-launch pass; slice 13 owns the full run and origin-take acceptance.
