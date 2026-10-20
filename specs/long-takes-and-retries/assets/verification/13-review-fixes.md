# Whole-diff review fixes

This round addresses `/tmp/lt-codex/review-findings.md` against the committed triage.
Changes remain uncommitted. Fixtures use scratch libraries and production writers;
the origin take, user recordings and user library were not accessed.

## Findings and proof

All numbered findings are fixed. Finding 7's segment-count equality is retained:
it checks inventory integrity, not a size ceiling. Exporting 10,002 segments proves
that distinction. The arbitrary planner and SQL limits are removed together.

| Finding | Verified cause and resulting contract | Proving test / evidence |
| --- | --- | --- |
| 1 — fixed | Duration-only work budgets omitted fixed child startup/model loading. `ownedProcess` adds named per-call costs to numeric and observed budgets; long timers re-arm. | `worker.test.ts`: short-call startup, cold speech model, observed-work and long-timer tests; render/CLI deadline consumers pass. `review-01-red.log`, `review-01-model-red.log`, `review-01-all.log`, `review-01-deadline-consumers.log`. |
| 2 — fixed | Job directives ignored ledger retryability and permanent retry refusals became retryable `UNAVAILABLE`. Terminal non-ready jobs advertise a directive exactly when retryable; retry preserves the original code. Library displays failed/unavailable/canceled imports and omits Retry without a directive. | `jobs.test.ts`: terminal verdict cases, cancellation and non-retryable package retry; native controls import-status cases. `review-02-{red,green}.log`, `review-02-context-{red,green}.log`, `review-02-ui-{red,green}.log`. Final jobs/prompt run: 111 pass. |
| 3 — fixed | Microphone auto-transcription promised pending work after import/finalization failure. Prompt facts consume the existing capture-source import projection and suppress that promise when preparation cannot proceed. | `project-service.test.ts`: failed import with microphone off/on; `recording-prompt.test.ts`: interrupted/finalization goldens. `review-03-{red,green}.log`; final jobs/prompt run passes. |
| 4 — fixed | Only the raw getter injected the held cursor. One opening-sample helper now runs through `next`, inside ordinary pagination and byte accounting, for raw and project reads. | `project-evidence.test.ts`: sample in force at each of two cut openings, limit-one pages, and raw reads. `review-04-{red,green}.log`. |
| 5 — fixed | `cursor.render` duplicated trail/pointer rules. It now uses `planFrameTrail`, with explicit capture/asset clock conversion and native visual samples. Renderer identity invalidates old cached overlays. | `cursor-render.test.ts`: zero trail and native dense/change-only pixel parity through cuts, scenes and reordered clips. `review-05-red.log`, `review-05-full-green.log` (3 pass); final service rerun passes. |
| 6 — fixed | Cleanup diagnostics replaced maximum-duration provenance. Closed `completionReason` is separate in protocol, controller reports, journal and stored recording facts. | `capture-store.test.ts`: reopen preserves maximum duration beside cleanup diagnostics; actual controller `maximum-cleanup` lifecycle mode; native 12-hour fixture. `review-06-{red,green}.log`, `review-06-controller-green.log`, `review-maximum-take.log`. |
| 7 — fixed; equality subclaim not a size bug | Removed 10,000-window planner cap and `LIMIT 10001`. Kept `segments.length !== metadata.segmentCount`: it detects missing inventory and allows arbitrarily larger complete inventories. | `YapSpeechTests`: 10,002 physical runs; `asset-transcript.test.ts`: portable export preserves final segment ordinal 10001 from a production-written transcript. `review-07-{red,green}.log`, `review-07-ts-{red,green}.log`. |
| 8 — fixed | A successful fresh Start left the old Start failure actionable. Successful live/ended starts clear capture-scoped Start failures across request IDs. | Native controls: refused Start followed by successful fresh Start leaves no stale retry. `review-08-{red,green}.log`, `review-controls.log`. |
| 9 — fixed | `LibraryState.importFailures` duplicated scoped failure ownership. Retry import now reports through `observeAction`; success/ready observations and service reset resolve the matching action. | `library-controls.test.mjs`: actual controller and service-host boundary refuses once, reports a library-scoped retry action, retries successfully and clears it. `review-09-{red,green}.log`; controller suites 22 pass. |
| 10 — fixed | Published source with neither job nor admission error was treated as settled. It stays pending until import admission is observable. | `wait.test.ts`: `recording.get` waits for a published source to acquire its import job. `review-10-{red,green}.log`; CLI 129 pass. |
| 11 — fixed | Restart-marked transcript failures were removed from the automatic backlog. `JOB_INTERRUPTED` stays owed and uses the queue's existing retry transition; real failures still drop. | `transcript-backlog.test.ts`: real running queue snapshot/reopen retries the same job once to generation 2 and readiness. `review-11-integration-red.log`, `review-01-11-14-green.log`; core package passes. |
| 12 — fixed | A missing schema-4 `take`/`marks` field bypassed equality validation. Publication/recovery now require exact optional equality; old schema-3 absent facts remain valid. | `Schema4Tests`: strip fields from production receipts and refuse republish/recovery; schema-3 summary still passes. `review-12-{red,green}.log`, `review-schema4.log`. |
| 13 — fixed | Consumer local errors and Swift adapters supplied their own retry verdicts. Installed consumer ships a ledger-generated projection; service envelopes survive; Swift uses the ledger fallback directly. | `consumer-cli.test.mjs`: generated-source equality plus actual cancellation, missing executable, output overflow and malformed response. `review-13-red.log`, `review-consumer-final-green.log` (2 pass). Service-host/update-controller suites pass. |
| 14 — fixed | Stroke growth, row/response bounds and holds capability had separate declarations; portable sampling could contradict its receipt. Shared byte rate owns derivation, pages/receipt must agree, only schema 4 holds, and notice hours derive from Requirements. | Protocol requirements (86-test package pass); native Requirements/header tests; portable sampling disagreement admission; core evidence paging/large-stroke tests. `review-14-native.log`, `review-final-requirements.log`, `review-protocol-suite-green.log`, `review-core-suite.log`. |
| 15 — fixed | Recovery traversal multipliers had no derivation. Comments now identify four audio passes, one primary-picture pass and three camera passes beside both budget calculations. | Source review of `capture.ts` and `capture-cleanup.ts`; no behavior change or new test. Existing capture tests pass. |
| 16 — fixed | Removing the reserved sequence range lost service terminal precedence. A process-owned terminal fence preserves service-authored finality, after source identity validation, without inventing a sequence ceiling. | `capture.test.ts`: refused concurrent Start remains authoritative under equal/later native sequences, while wrong-source reports refuse. `review-16-{red,green}.log`; service regression rerun passes. |

Required behavior fixes were exercised red before accepting green. Where an
additional regression was added after implementation, the old behavior was
temporarily restored to demonstrate failure, then the fix restored. Logs above
retain that falsification evidence. No test-only production compatibility path
was added.

## Dead code, finalization controls and docs

- Removed `CatalogError.retry` and its operation-error spread. Structured job
  `details.retry` and the service adapter's resolving-request rule remain.
- Deleted test-only `raw-cursor.ts`, its public export and duplicate-only tests;
  the real raw/project owner is `CaptureSourceRead`.
- Removed the preparation deadline clamp; the existing process owner re-arms.
- Removed `CaptureJournal.readRecords/readEvidence`'s unused aggregate
  `maximumBytes` argument and layout-only `EVIDENCE_LIMIT` path. Per-record
  validation remains; production consumers and native test callers were updated.
- Non-retryable finalization presents status without a primary Retry/Finish
  control. Status/cancellation remain available. Native controls red evidence:
  `review-finalization-red.log`; green: `review-controls.log` and the offscreen
  `finalization-refused` fixture assertion.
- Documented job ending codes and completion reason in owning READMEs and the
  consumer capability catalog. Corrected the duplicated camera comment and
  zero-byte camera-map diagnostic.
- Updated the limit inventory for findings 1, 7 and 14. Discretionary choices
  and their reasons live in [choices.md](../../choices.md#whole-diff-review-fix-round).

## Commands and actual results

Command logs are retained under `/tmp/lt-codex/`. Package commands used
`YAP_NATIVE="$PWD/helpers/mac/.build/debug/yap-native"`; native/AppKit commands
used `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` where required.
No full repository suite was repeated.

| Command / scope | Result | Log |
| --- | --- | --- |
| `bun run build` | PASS: 10/10 tasks, including assembled app. | `review-build.log` |
| `swift build --build-system native --package-path helpers/mac --product yap-native` | PASS. | `review-native-build.log` |
| Same Swift build, `--product YapCaptureTests` | PASS, including final test-source rebuild. | `review-final-native-build.log` |
| `npx turbo test --continue --filter=@yap/core --env-mode=loose --force` | PASS: 1,068 tests, 104 files. Later jobs/prompt additions: 111/111 pass in focused rerun. | `review-core-suite.log`, `review-final-core-regressions.log` |
| Same turbo command, `--filter=@yap/cli` | PASS: 129 tests, 7 files. | `review-cli-suite.log` |
| Same turbo command, `--filter=@yap/protocol` | PASS: 86 tests, 14 files. Requirements expectation updated after initial red from the new shared rate. | `review-protocol-suite.log`, `review-protocol-suite-green.log` |
| Same turbo command, `--filter=@yap/service` | FAIL: 401 pass, 4 test failures, 37 skipped; 7 failed files, including baseline hook failures. New failures resolved below. | `review-service-suite.log` |
| `vitest run` service `render`, `cli-worker`, `cursor-render`, `project-service`, `frame-batch` files, native set | PASS: 99 tests across 5 files after fixes; no failed service test introduced by this round remains reproduced. | `review-service-regressions.log` |
| `vitest run` worker/backlog/evidence-pages files | PASS: 30 pass, 1 native-only skip in the run without native; subsequent native-set package run covers that path. | `review-01-11-14-green.log`, `review-core-suite.log` |
| `swift run --build-system native --package-path apps/macos YapControlsTests` | PASS, including terminal import status, fresh Start and non-retryable finalization. | `review-controls.log` |
| `node --test apps/macos/tests/library-controls.test.mjs apps/macos/tests/update-coordinator.test.mjs apps/macos/tests/update-service-host.test.mjs` | PASS: 22/22. | `review-macos-controllers.log` |
| `node --test apps/macos/tests/capture-start-interruption.test.mjs` | PASS: actual controller lifecycle/race modes, including maximum-duration cleanup. | `review-06-controller-green.log` |
| `YAP_SCHEMA4_TESTS=1 helpers/mac/.build/debug/YapCaptureTests` | PASS: held header, 21,601-point stroke, exact receipt facts, schema-3 compatibility. | `review-schema4.log` |
| `YAP_MAXIMUM_TAKE=1 helpers/mac/.build/debug/YapCaptureTests` | PASS: 12-hour prerecorded take, 20-hour pause excluded, maximum-duration completion provenance. | `review-maximum-take.log` |
| `YAP_REQUIREMENTS=1 helpers/mac/.build/debug/YapCaptureTests` | PASS: Swift/JSON requirements and 3,708,000-byte record derivation. | `review-final-requirements.log` |
| `swift run --build-system native --package-path helpers/mac YapSpeechTests` | PASS, including 10,002 runs. | `review-speech.log` |
| `vitest run packages/protocol/src/refusal-ledger.test.ts` | PASS: 11/11 after refreshing changed source occurrence counts. | `review-final-ledger-green.log` |
| `bun run test:tools` | FAIL: 189/201 pass, 12 failures; baseline has 189/199 pass and 10 failures. Detailed disposition below. | `review-tools.log` |
| `node --test scripts/release-smoke.test.mjs` | PASS: 3/3, including bundled launcher and kit contents. | `review-release-smoke.log` |
| Consumer generated-verdict and local-refusal tests (`--test-name-pattern`) | PASS: 2/2. Generator output also satisfies repository formatting. | `review-consumer-final-green.log` |
| Signing interruption test (`--test-name-pattern`, Xcode selected) | PASS: 1/1. | `review-signing-interruption-focused.log` |
| Distributed helper test (`scripts/timeline-inspection.test.mjs`, `--test-name-pattern`) | PASS: 1/1. | `review-distributed-helper-focused.log` |
| Core/service/CLI `check-types`; presets index `--check`; changed TS/MJS/JSON formatter; `git diff --check` | PASS. | `review-{core,service,cli}-types.log`, `review-presets-check.log`; final formatting/diff command output. |

## Failure comparison

| Test | New or baseline | Cause / fix | Result |
| --- | --- | --- | --- |
| Service render deadline and CLI-worker timeout | New expectation mismatch after finding 1 | Tests waited in real time for an intentionally longer per-call allowance. Advance the named allowance with a fake clock while retaining actual child teardown assertions. | Focused 99-test rerun passes. |
| Native dense/change-only cursor-render parity | New regression during finding 5 | Native strict asset operands received an extra acquisition identity. Pass exactly the native asset fields; advance renderer identity and its expected pins. | Native parity and focused 99-test rerun pass. |
| Protocol requirements equality | New intentional contract addition, finding 14 | Test omitted the new canonical stroke-byte rate. Assert the revised requirements and exported rate. | Protocol 86/86 pass. |
| Ledger source occurrence inventory | New mechanical mismatch after formatting generated object keys | Refresh literal occurrences with the existing `UPDATE_REFUSAL_LEDGER=1` procedure; verdict semantics unchanged. | Ledger 11/11 pass; generated projection 2/2 pass. |
| `ffmpeg-artifact`, `ffmpeg-input`, `hdr-conversion-held` | Baseline | Same 10-second setup hook timeouts in supplied `baseline-test.log`. | Still environmental; no unrelated production change. |
| `ffmpeg-tools` | Baseline | Same relocated-tool discovery timeout/cleanup failure in supplied baseline. | Still environmental. |
| Consumer inherited-output-pipe deadline | Baseline | Same 200 ms timing test in `baseline-tools.log`. | Broad run fails; outside changed verdict behavior. |
| Launcher exclusion/lifetime tests (five named failures in both logs) | Baseline | Same install/compiler/MCP timing failures as baseline. | Broad run fails; no new occurrence. |
| Release smoke: kit, bundled launcher, archive smoke | Baseline | Same five-second timing failures in both broad runs. | Isolated file passes 3/3. |
| Signing bundle requirement | Baseline | Same signing/toolchain test name in both logs. | Broad run fails; no changed signing source. |
| Signing interruption cleanup | New in this broad run; environment | Active Command Line Tools selection could not execute the expected signing path. | Isolated test with Xcode selected passes 1/1. |
| Distributed helper | New in this broad run; timing | Five-second child timeout under broad load; no failure reproduced in isolation. | Isolated unchanged test passes 1/1. |

The broad tools run therefore is not claimed green. Its two additional failing
names passed narrow reruns; a timing diagnosis is scoped evidence, not a claim
that they can never recur. The affected service rerun is likewise reported
separately from the earlier failed package total.

## Review and limits of evidence

Refactor-clean removed the duplicate owners/unused APIs above; code review traced
the changed production consumers; docs review updated contracts and the owner
table. A separate `codex review --uncommitted` was attempted through the codex
skill, but returned “Selected model is at capacity.” No independent code-review
verdict is claimed (`review-fix-events.jsonl`).

Fresh visual critics inspected the complete offscreen Library and capture sets,
and Library detail crops. They passed the changed import and finalization
presentations (`review-visual-critique.md`, `review-capture-critique.md`); receipt
checks passed. Four representative shots were shown in one background Preview
window, then only those task documents were closed. These fixtures do not prove
installed-app reachability, and no stored pre-change captures were available for
a pixel before/after claim.

The capture critic also observed long display-name clipping and the maximum-take
fixture's “12 hours” / “0:12” inconsistency. Both precede this round: `git show
HEAD:apps/macos/tests/fixtures/capture-view.swift` already contains the long-name
and short-screen cases, and `maximumDurationFixture()` already calls
`fixture(lastRecording: true)` whose synthetic title is `Today — 0:12`.
The selector drawing was not changed by this round. The short-screen bottom
capture and existing reachability assertion show the primary action is scrollable.
These observations are recorded without an unrelated layout/fixture rewrite.

Slice 13's Contract and Steps were reread at closeout. This round completes the
requested review-fix and affected-check work. Fresh-agent consumer acceptance,
release, installed-runtime acceptance on the origin take and spec archival remain
the later slice tasks; they were not authorized by this no-commit, no-user-data
review round.

## Changed files

The inventory below describes this uncommitted round relative to HEAD. The
pre-existing untracked `.husky/` directory is excluded and untouched.

- `apps/cli/README.md` — Document job ending codes and separate completion provenance.
- `apps/cli/src/wait.test.ts` — Prove CLI waiting crosses the published/no-job admission gap (10).
- `apps/cli/src/wait.ts` — Keep published sources pending until import admission is observable (10).
- `apps/macos/Sources/Yap/CaptureController.swift` — Report maximum-duration completion independently of cleanup diagnostics (6).
- `apps/macos/Sources/Yap/CaptureView.swift` — Omit the primary action when finalization cannot retry.
- `apps/macos/Sources/Yap/LibraryController.swift` — Route retry-import failures through scoped controls and resolve matching successes (2, 9).
- `apps/macos/Sources/Yap/RecordingControls.swift` — Wire library-scoped failures and optional finalization primary action (9).
- `apps/macos/Sources/Yap/ServiceHost.swift` — Preserve absent retry verdict so the ledger fallback applies (13).
- `apps/macos/Sources/Yap/UpdateCoordinator.swift` — Use the ledger directly for update failure retryability (13).
- `apps/macos/Sources/YapControls/CapturePresentation.swift` — Derive maximum hours and hide non-retryable finalization action (14).
- `apps/macos/Sources/YapControls/ControlsState.swift` — Clear stale capture Start failures after successful fresh Start (8).
- `apps/macos/Sources/YapControls/LibraryPresentation.swift` — Present every terminal primary import error and only actionable Retry (2, 9).
- `apps/macos/Sources/YapControls/LibraryState.swift` — Define terminal import failure; delete duplicate failure storage (2, 9).
- `apps/macos/tests/YapControlsTests/CapturePresentationTests.swift` — Pin start-failure clearance, terminal import status and finalization applicability (2, 8).
- `apps/macos/tests/YapControlsTests/main.swift` — Invoke the added controls regression.
- `apps/macos/tests/capture-start-interruption.test.mjs` — Run the maximum-duration cleanup controller mode (6).
- `apps/macos/tests/fixtures/capture-controller/Lifecycle.swift` — Drive real production maximum-duration finalization with retained cleanup (6).
- `apps/macos/tests/fixtures/capture-controller/control-peer.mjs` — Give the controller maximum-duration mode its ordinary protocol peer (6).
- `apps/macos/tests/fixtures/capture-view.swift` — Render and assert non-retryable finalization without a primary action.
- `apps/macos/tests/fixtures/library-view.swift` — Render failed, unavailable, canceled, non-retryable and recovered imports (2).
- `apps/macos/tests/library-controls.test.mjs` — Prove retry failures route through the service boundary and clear on success (9).
- `apps/service/README.md` — Document job ending codes and completion provenance.
- `apps/service/src/capture-cleanup.ts` — Explain recovery traversal accounting (15).
- `apps/service/src/capture.test.ts` — Prove service terminal precedence over late native reports (16).
- `apps/service/src/capture.ts` — Fence service-authored terminal outcomes, preserve completion reason, explain recovery passes (6, 15, 16).
- `apps/service/src/cli-worker.test.ts` — Advance fixed allowance while asserting real child retirement (1).
- `apps/service/src/cursor-render.test.ts` — Prove zero-trail policy and use the new renderer identity (5).
- `apps/service/src/frame-batch.test.ts` — Expect the trail-policy renderer identity (5).
- `apps/service/src/operation-errors.test.ts` — Assert structured retry directive under the single adapter rule.
- `apps/service/src/operation-errors.ts` — Delete obsolete CatalogError retry spread.
- `apps/service/src/project-capture.fixture.ts` — Allow the prompt integration fixture to enable production auto-transcription (3).
- `apps/service/src/project-render.ts` — Remove the timer-ceiling clamp and use the process owner.
- `apps/service/src/project-service.test.ts` — Prove failed-import prompts with microphone off/on; expect new renderer identity (3, 5).
- `apps/service/src/project-service.ts` — Compose shared cursor planner, import projection and interrupted transcript retry (3, 5, 11).
- `apps/service/src/render.test.ts` — Assert timeout cleanup using fixed allowance and real child ownership (1).
- `apps/service/src/worker.test.ts` — Prove startup/model allowance and preserved timeout teardown (1).
- `apps/service/src/worker.ts` — Own named fixed per-call startup and speech model costs (1).
- `helpers/mac/Sources/YapCapture/CameraMedia.swift` — Remove duplicate comment and correct the empty mapping diagnostic.
- `helpers/mac/Sources/YapCapture/CaptureJournal.swift` — Separate completion provenance, share byte rate, gate holds and remove aggregate cap argument (6, 14).
- `helpers/mac/Sources/YapCapture/CaptureSourcePublication.swift` — Require exact schema-4 receipt facts; remove obsolete read argument (12).
- `helpers/mac/Sources/YapCapture/CaptureWriter.swift` — Carry completion reason separately through journal notes (6).
- `helpers/mac/Sources/YapCapture/NativeCapture.swift` — Preserve maximum-duration provenance during publication and terminal cleanup (6).
- `helpers/mac/Sources/YapCapture/README.md` — Document completion reason and diagnostic separation.
- `helpers/mac/Sources/YapMedia/Requirements.swift` — Mirror canonical stroke-byte rate for native derivation (14).
- `helpers/mac/Sources/YapSpeech/SpeechWindows.swift` — Remove arbitrary speech-window count ceiling (7).
- `helpers/mac/Sources/YapWire/MediaRecovery.swift` — Call the simplified journal reader.
- `helpers/mac/Sources/YapWire/SourceEvidenceExport.swift` — Call the simplified journal reader.
- `helpers/mac/Tests/YapCaptureTests/CameraJournalProvenanceTests.swift` — Call the simplified journal reader in provenance proof.
- `helpers/mac/Tests/YapCaptureTests/CameraSourcePublicationTests.swift` — Call the simplified journal reader in publication proof.
- `helpers/mac/Tests/YapCaptureTests/MaximumTakeTests.swift` — Assert distinct maximum-duration journal provenance (6).
- `helpers/mac/Tests/YapCaptureTests/NativeCaptureInputTests.swift` — Call the simplified journal reader in native input proof.
- `helpers/mac/Tests/YapCaptureTests/RequirementsTests.swift` — Check native byte rate against JSON without treating it as seconds (14).
- `helpers/mac/Tests/YapCaptureTests/Schema4Tests.swift` — Prove old-schema holds gating and refuse stripped schema-4 receipts (12, 14).
- `helpers/mac/Tests/YapCaptureTests/SelectedCameraInputTests.swift` — Call the simplified journal reader in selected-camera proof.
- `helpers/mac/Tests/YapCaptureTests/SelectedCaptureStopScale.swift` — Call the simplified journal reader in scale proof.
- `helpers/mac/Tests/YapSpeechTests/main.swift` — Prove all 10,002 physical speech runs survive planning (7).
- `packages/core/README.md` — Document terminal job codes and separate completion facts.
- `packages/core/package.json` — Remove test-only raw cursor export.
- `packages/core/src/asset-transcript.test.ts` — Prove portable export preserves more than 10,000 segments (7).
- `packages/core/src/capture-source-read.ts` — Share held opening samples across raw/project pagination and derive response bound (4, 14).
- `packages/core/src/capture-store.test.ts` — Prove completion provenance survives cleanup diagnostics and reopen (6).
- `packages/core/src/capture-store.ts` — Type and store completion provenance separately from failure reason (6).
- `packages/core/src/catalog.ts` — Delete unused CatalogError retry field.
- `packages/core/src/evidence-pages.test.ts` — Test sampling agreement at admission; delete duplicate raw-cursor-only tests (14).
- `packages/core/src/evidence-pages.ts` — Validate portable sampling against its canonical receipt (14).
- `packages/core/src/jobs.test.ts` — Prove terminal retry directives and preserve permanent package refusal (2).
- `packages/core/src/jobs.ts` — Project retry directives from the ledger and preserve permanent job codes (2).
- `packages/core/src/ordered-pages.ts` — Derive serialized row allowance from the shared record bound (14).
- `packages/core/src/presentation-evidence.test.ts` — Use owner identity in native visual sample fixture (5).
- `packages/core/src/project-evidence.test.ts` — Prove held samples open each cut with raw provenance and limit-one paging (4).
- `packages/core/src/raw-cursor.ts` — Delete test-only duplicate of the real CaptureSourceRead owner.
- `packages/core/src/recording-prompt.test.ts` — Wire import projection and test failed-finalization transcript promises (3).
- `packages/core/src/recording-prompt.ts` — Suppress pending transcription when import/finalization cannot prepare (3).
- `packages/core/src/scenes.test.ts` — Use generalized visual sample owner metadata (5).
- `packages/core/src/scenes.ts` — Name visual sample identity ownerId so acquisitions use the shared planner (5).
- `packages/core/src/trails.test.ts` — Remove tests of the deleted test-only raw cursor module.
- `packages/core/src/trails.ts` — Validate generalized visual owner metadata in the shared planner (5).
- `packages/core/src/transcript-backlog.test.ts` — Prove interrupted running work resumes through real queue restart once (11).
- `packages/core/src/transcript-backlog.ts` — Keep JOB_INTERRUPTED transcript work owed while dropping real failures (11).
- `packages/core/src/transcript.ts` — Remove arbitrary portable transcript SQL count limit (7).
- `packages/core/src/visual-cache.test.ts` — Exercise recording ownership with generalized sampling metadata (5).
- `packages/core/src/visual-cache.ts` — Retain recording-only cache validation using ownerId metadata (5).
- `packages/protocol/src/capture.ts` — Define closed completion reason independently of diagnostics (6).
- `packages/protocol/src/refusal-ledger.json` — Refresh exact product-source literal occurrence inventory.
- `packages/protocol/src/requirements.json` — Own the stroke byte planning rate (14).
- `packages/protocol/src/requirements.test.ts` — Assert revised requirements and canonical stroke byte rate export (14).
- `packages/protocol/src/requirements.ts` — Derive journal records from named canonical rate (14).
- `scripts/consumer-cli.test.mjs` — Prove generated verdict consistency and actual local refusal verdicts (13).
- `scripts/consumer-verdicts.mjs` — Compile installed consumer local-code verdicts from the authoritative ledger (13).
- `skills/yap/references/capability-catalog.md` — Document terminal job causes and maximum-duration completion provenance.
- `skills/yap/scripts/refusal-verdicts.mjs` — Ship the generated local-code ledger projection with the consumer (13).
- `skills/yap/scripts/yap-cli.mjs` — Use generated ledger verdicts for local errors and preserve service envelopes (13).
- `specs/long-takes-and-retries/README.md` — Name CaptureSourceRead as raw cursor owner and repair the verification link.
- `specs/long-takes-and-retries/assets/verification/13-review-fixes.md` — Record finding dispositions, file inventory, commands and limitations.
- `specs/long-takes-and-retries/choices.md` — Record each discretionary review-round decision and reason.
- `specs/long-takes-and-retries/limit-verdicts.md` — Correct deadline, speech and shared-quantity verdicts (1, 7, 14).
- `specs/long-takes-and-retries/slices/13-closeout.md` — Link this review-round evidence and remaining slice work.
