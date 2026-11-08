# Slice 13 full-run triage

Scope: compare the prepared-input repository runs on this branch and pre-spec baseline
`a8ccc912`, then rerun affected packages only. Release, agent acceptance and origin-take
acceptance remain separate slice-13 work. Only repository fixtures and generated scratch
state were used; no user library or origin take was accessed.

The original comparison logs are `/tmp/lt-codex/{feature,baseline}-{test,tools}.log`.
Focused verification logs use `/tmp/lt-codex/triage-*.log`.

## Contract corrections

`a` means the test or fixture follows an intentional slice contract. `b` would mean a
production regression repair; none has been identified in this triage.

| Test | New or baseline | Cause | Fix | Result |
|---|---|---|---|---|
| SelectedCameraInputTests | New | Fresh take read as schema 3 | a, slice 08: use `JournalSchema.current` | Pass |
| compiled-render fractional deadline | New | Fixed deadline addend removed | a, slice 10: assert work-derived deadline | Pass |
| lifetime orphan-held workspace | New | Timed refusal envelope | a, slices 04/05: retain `retryAfterMs` | Pass |
| audio-inspection dependency rollback | New | Import readiness is `NOT_READY` | a, slice 11: assert new code and retryability; keep rollback checks | Pass |
| prepared-audio normalization identity | New | Invalid native output is retryable | a, slice 05: assert retryable failure; keep identity re-key checks | Pass |
| asset-transcript malformed native output | New | Our evidence reader's refusals are retryable | a, slices 05/06: update verdict; keep cleanup assertions | Pass |
| CLI error-envelope | New | Unfinished `recording.prompt` now succeeds | a, slice 11: request `recording.get` with no takes; preserve CLI/MCP refusal and exact resolving request checks | Pass |
| recording-prompt goldens (13), CLI wait (2), project-capture retry (1), project-service prompt/readiness (2) | New | Native fixture writers require explicit helper | a, slices 06/11: use existing Vitest `test.runIf(Boolean(process.env.YAP_NATIVE))` convention | Pass |
| project-service ready-package lifetime | New | Slice-10 streamed extraction fixture uses native worker | a, slice 10: apply same native-dependent convention | Pass |
| release input/packaging tests (4) | New | Slice-05 launcher projection absent from copied fixture | a, slice 05: stage actual projection, C source and ledger | Pass |
| motion-alpha selected-frame refusal | New, hidden by capture crash | Slice-05 exact unavailable-support code | a, slice 05: expect `UNAVAILABLE_SUPPORT` | Pass |
| source-evidence retired budget failures | New, hidden by capture crash | Slice-10 whole-file/header caps removed | a, slice 10: remove obsolete size refusals; retain malformed-header cleanup | Pass |
| video-render presentation evidence (4) | New, hidden by capture crash | Slice-10 wire contract removed `maxBytes` | a, slice 10: omit field and remove obsolete budget-refusal branch; preserve unsupported-tail refusal | Pass |
| source-evidence launch goldens (2) | Environment | Checkout held LFS pointers | Materialize only the two journal fixtures from shared cache, no source change | All four byte goldens pass unchanged |
| App service-lifetime empty-library response | New, hidden behind helper-test failures | Slice-04 safe-read resolving directive | a, slice 04: assert `details.retry` | Pass |
| release-smoke kit / bundled launcher / archive smoke | Baseline | Five-second process timeout | No change; all three pass in focused run | See verification below |
| client discovery, alignment/join/measurement/speaker, ffmpeg-*, HDR, B-frame probe | Baseline | Timing or prepared/native runtime requirements | No change | See verification below |
| consumer descendant timeout, launcher/lab timing, scratch signing identity | Baseline | Timing or local signing environment | No change | See verification below |

`TranscriptProcessing.retrySource` had no production caller after slice 06. It and its two
method-specific tests were deleted; the job queue remains the explicit retry owner. Other
processors' `retrySource` methods still have production consumers and remain intact.

## Choices

- Gate only tests that invoke native production writers/workers. Keep portable cases running
  without a helper, matching older native Vitest tests rather than inventing fixture media.
- Use the empty-library `recording.get` refusal for adapter envelope coverage, so the test stays
  portable while `recording.prompt` retains its nonblocking contract. The real ledger supplies
  the delay; the test no longer changes it.
- Copy the launcher's actual build inputs into the release fixture instead of introducing a
  second verdict table or a production fallback.
- Use Turbo `--env-mode=loose --force` for native-enabled package verification: `YAP_NATIVE`
  is not in the checked-in Turbo environment list, and cached skips would not prove execution.

## Verification

The full repository suite was not rerun. `bun run build` passed (10 tasks), followed by
`swift build --build-system native --package-path helpers/mac --product yap-native` and
`--product YapCaptureTests` (44.13 s and 10.99 s). After the schema assertion correction,
`YapCaptureTests` rebuilt in 8.20 s. A pre-rebuild native run reproduced the original schema
assertion failure; the macOS package run then passed capture, frame, audio, speech and controls
executables.

Package commands used `YAP_NATIVE=$PWD/helpers/mac/.build/debug/yap-native`,
`YAP_PRESETS_REFRESH=0`, and `npx turbo test --continue --filter=<package> --env-mode=loose`.
Core, CLI and service additionally used `--force` to prevent a cached native skip.

| Check | Result |
|---|---|
| Core package | Pass: 1,061 tests |
| CLI package | Pass: 128 tests |
| Service package | 397 pass, 37 skipped, 3 failing tests plus 3 failing setup files; failures are baseline FFmpeg/HDR/measurement issues and one CLI startup race |
| Service affected files, `bunx vitest run` with `--maxWorkers=2` | Pass: 115 tests (compiled-render, lifetime, project-capture, project-service) |
| Without `YAP_NATIVE`, `env -u YAP_NATIVE ... bunx vitest run` on prompt/wait/project-capture/project-service | Pass: 150 tests, 19 native cases skipped |
| macOS package | Native Swift executables pass; Node helper tests initially 104/113, with failures triaged above plus the baseline B-frame probe |
| App adapters, `node --test apps/macos/tests/*.test.mjs` | Initially 149/155. Corrected the empty-library retry directive; its test plus unreadable/oversized-control cases pass 3/3 focused. Overlay clock passes 1/1 focused (unchanged source/test; broad run saw one-pixel window rounding). Preview bridge passes 1/1 focused after its broad-run observation timeout. Controller compilation timed out in the broad run; focused run passes 1/1 (all six lifecycle scenarios) |
| Native affected `.mjs` files | Source-evidence and motion-alpha pass; video-render passes 4/4 after retaining its original unsupported-tail code. Across the three files, 29/29 pass, including all four byte/receipt goldens |
| `bun run test:tools` | 189 pass, 11 fail; all four corrected release-input cases pass. Baseline timeout/signing failures remain; additional runtime failures investigated below |
| `node --test scripts/release.test.mjs` | Red before fixture correction, then 4/4 pass |
| `node --test scripts/release-smoke.test.mjs` | 3/3 pass unchanged when focused |
| CLI-owner startup race, single Vitest case | 1/1 pass focused; broad run failed before CLI started |
| Updater delayed callback, single Node case | 1/1 pass focused; broad run timed out before stalled-host barrier |
| Signing interruption, single Node case | Still fails before held external command; test, signing script, native fixture and framework-identity module are byte-identical to `a8ccc912`. The original baseline checkout has been removed, so it was not rerun there |
| `node scripts/presets-index.mjs --check` | Pass; run separately because tools' failed Node stage short-circuited it |
| Core/service/CLI type checks | Pass |
| Changed TS/MJS formatting and `git diff --check` | Pass |
| Scoped lint | Pass, no errors; three existing unused-variable/parameter warnings in untouched lines |

The initial focused red run reproduced 18 failures; the corrected portable selection passed
87 tests and skipped 13 native prompt cases. After removing dead retry-test fixture controls,
the asset-transcript file passed 20/20 again. No production behavior was changed beyond
deleting the unused transcript retry method.

The service manifest's Node stage did not run because its Vitest stage retained baseline
failures. No requirement, production timeout or historical golden was weakened to obtain green.
The B-frame probe remains unchanged and has the same expected/actual time mismatch as baseline.
The fake-interpreter cases failed version discovery in the broad app run, then exercised their
intended protocol failures successfully when focused. Signing interruption still fails before
its external-command barrier. Both signing cases and all their signing/framework source inputs
are unchanged from baseline; no production workaround or longer test deadline was added.

Local shape, diff and documentation review completed. The independent read-only Codex review
returned `turn.failed`: selected model at capacity, so there is no independent review verdict.
Release, fresh-agent checks and installed origin-take acceptance remain outside this triage.


## Changed files

- `apps/cli/src/error-envelope.test.ts`: use the portable empty-library refusal and the real ledger.
- `apps/cli/src/wait.test.ts`: gate the two native capture/import cases.
- `apps/macos/tests/service-lifetime.test.mjs`: retain the safe-read resolving directive.
- `apps/service/src/compiled-render.test.ts`: remove retired fixed deadline addends.
- `apps/service/src/lifetime.test.ts`: retain the ledger delay on workspace refusal.
- `apps/service/src/project-capture.test.ts`: gate the native import-retry case.
- `apps/service/src/project-service.test.ts`: gate the native prompt/readiness and package cases.
- `helpers/mac/Tests/YapCaptureTests/SelectedCameraInputTests.swift`: read fresh takes with the capability table's current schema.
- `helpers/mac/Tests/motion-alpha.test.mjs`: expect the exact unavailable-support refusal.
- `helpers/mac/Tests/source-evidence.test.mjs`: remove retired byte-budget assertions and retain malformed-header cleanup.
- `helpers/mac/Tests/video-render.test.mjs`: use the current presentation-evidence request contract.
- `packages/core/src/asset-transcript.test.ts`: update refusal verdicts and delete obsolete retry-method tests and their fixture controls.
- `packages/core/src/audio-inspection.test.ts`: assert import readiness while preserving rollback proof.
- `packages/core/src/prepared-audio.test.ts`: assert the ledger verdict while preserving identity re-key proof.
- `packages/core/src/recording-prompt.test.ts`: gate only the native-writer goldens and import cases.
- `packages/core/src/transcript-processing.ts`: delete the unused retry method and import.
- `scripts/release.test.mjs`: stage actual launcher verdict build inputs.
- `specs/long-takes-and-retries/README.md`: route the remaining slice-13 work through this evidence.
- `specs/long-takes-and-retries/slices/13-closeout.md`: retain the scoped triage handoff.
- `specs/long-takes-and-retries/assets/verification/13-full-run-triage.md`: retain classification, choices and verification.

The only production-code diff is removal of the unused transcript retry method (22 net lines
removed); there are no new adapters, schema columns, dependencies or compatibility paths.
Scratch preview media/metadata, public updater/signing fixtures named by this run, and the
crashed native fixture were removed. Logs remain as verification evidence. The pre-existing
untracked `.husky/` directory was left untouched. No commit was made.
