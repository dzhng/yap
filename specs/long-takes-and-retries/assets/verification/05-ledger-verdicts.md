# Slice 05 immutable-input verdict verification

Verified on macOS, on top of `b0a92caa`, with changes left uncommitted.
No user library or recording was accessed. Capture fixtures use the production writers
with prerecorded hardware substitutes. The original INVALID_EVIDENCE take was not touched.

## Contract and red/green evidence

The ledger alone decides retryability. Immutable media/journal facts that cannot satisfy
the same request settle unavailable; implementation, access and execution failures can
remain pending. The audit and all 272 ledger entries agree; 13 verdicts changed to false.
`INVALID_EVIDENCE` and `JOB_INTERRUPTED` remain true, and all 26 retry delays still belong
to retryable codes. No Swift publication policy or fallback was added.

After rebuilding, `YAP_RECOVERY_TESTS=1 helpers/mac/.build/debug/YapCaptureTests` failed
(exit 133) with `INVALID_JOURNAL_PREFIX: Recovery differs from allocated source/device
authority.` The focused source recovery test failed through `media.recover` as well.
After the correction both pass. This checkout has no YAP_RECOVERY_TESTS dispatch branch;
that variable selects the default suite by fallthrough.

The two service finalization regression cases fail with the old compiled ledger verdicts
(expected false, received true) and pass with the corrected ledger. The source JSON stayed
correct throughout that negative control; the compiled JSON was restored in a finally block.
Existing operational permission/retry tests still pass.

## Commands

- `swift build --build-system native --package-path helpers/mac --product YapCaptureTests`: PASS.
- `swift build --build-system native --package-path helpers/mac --product yap-native`: PASS.
- `bun run --cwd packages/protocol build`: PASS; refreshes the compiled ledger consumed by TS.
- `YAP_RECOVERY_TESTS=1 helpers/mac/.build/debug/YapCaptureTests`: PASS after the red above.
- Each selector below: `env SELECTOR=1_OR_NEW_OUTPUT_DIRECTORY helpers/mac/.build/debug/YapCaptureTests`.
- `node --test --test-concurrency=1` with the eight native files below: PASS, 54 tests.
- `bun x vitest run --config packages/core/vitest.config.ts` with the six core files below,
  `--maxWorkers=1`: PASS, 59 tests. Final edited publication file: PASS, 6 tests.
- `bun x vitest run --config apps/service/vitest.config.ts` with the five service files below,
  `--maxWorkers=1`: initially 87 passed / 2 startup timeouts. The two failing cases pass in
  isolation with the prepared FFmpeg directory; the finalization file passes all 16 tests
  after adding two regression cases. All 91 distinct cases pass across these runs.
- The source-export service test file also passes all 3 cases with the built native helper.
- `node --test --test-concurrency=1` with the three service integration files below: PASS, 43 tests.
- `bun x vitest run packages/protocol/src/refusal-ledger.test.ts`: PASS, 10 tests.
- `bun x oxfmt --check` on the changed TS, MJS and JSON files: PASS.
- `git diff --check`: PASS.

Node-backed commands use Node 24.21.0 from the verified local runtime and
`YAP_NATIVE=$PWD/helpers/mac/.build/debug/yap-native`, with `YAP_PRESETS_REFRESH=0`.
The isolated service startup rerun also supplies
`YAP_FFMPEG_DIRECTORY=/Users/david/dev/screen-recorder/helpers/ffmpeg/.build/distribution`.
The first core run used stale compiled protocol JSON (58 pass / 1 fail); rebuilding protocol
resolved the expected retryability mismatch. No test deadline was relaxed.

## Every capture selector

Output directories were fresh and deleted after inspection. Operand probes reused synthetic
fixtures from this run: selected-frame video, selected-probe camera/mapping, and materializer
canonical audio (128 runs). The audio corpus is the retained synthetic `00-corpus` fixture.
Format probes use the retained synthetic stereo and float64 WAV controls from `20d-activation`;
PCM admission uses the continuous 48 kHz canonical control from `20a-sparse-storage`.
The first format/PCM attempts used unsuitable operands and failed; both pass with their
required controls. These were harness setup failures, not changed acceptance thresholds.

| Selector | Result |
| --- | --- |
| `YAP_SELECTED_FRAME_OUTPUT` | PASS |
| `YAP_SELECTED_PROBE_OUTPUT` | PASS |
| `YAP_MATERIALIZER_OUTPUT` | PASS |
| `YAP_REQUIREMENTS` | PASS |
| `YAP_CAPTURE_CLOCK` | PASS |
| `YAP_LIVE_PCM_TIMING` | PASS |
| `YAP_PRIMARY_CAMERA_INPUT_OUTPUT` | PASS |
| `YAP_PRIMARY_CAMERA_PUBLICATION_OUTPUT` | PASS |
| `YAP_CAPTURE_INPUT_AUTHORITY` | PASS |
| `YAP_RETAINED_CAMERA_PUBLICATION_OUTPUT` | BLOCKED: exact historical donor required (see below) |
| `YAP_CANCELED_CAMERA_CONTINUATION_OUTPUT` | PASS |
| `YAP_CAMERA_CONTINUATION_CLOSURE_OUTPUT` | PASS |
| `YAP_SOURCE_PUBLICATION_OVERLAP_OUTPUT` | PASS |
| `YAP_CAMERA_PUBLICATION_OVERLAP` | PASS |
| `YAP_EMPTY_CAPTURE_RECOVERY_OUTPUT` | PASS |
| `YAP_SOURCE_RECOVERY_OUTPUT` | PASS |
| `YAP_SHARED_INTERRUPTION_OUTPUT` | PASS |
| `YAP_CAMERA_AVAILABILITY_OUTPUT` | PASS |
| `YAP_CAMERA_CLOCK_OUTPUT` | PASS |
| `YAP_CAMERA_WITHOUT_PRIMARY_OUTPUT` | PASS |
| `YAP_INDEPENDENT_PUBLICATION_OUTPUT` | PASS |
| `YAP_CAMERA_PROJECT_OUTPUT` | PASS |
| `YAP_CAMERA_SOURCE_ADMISSION_OUTPUT` | PASS |
| `YAP_SELECTED_CAMERA_INPUT_OUTPUT` | PASS |
| `YAP_CAMERA_LIVE_PUBLICATION_OUTPUT` | PASS |
| `YAP_CAMERA_SOURCE_PUBLICATION_OUTPUT` | PASS |
| `YAP_CAMERA_PIXELS` | PASS |
| `YAP_SELECTED_STOP_SCALE_OUTPUT` | PASS |
| `YAP_SELECTED_STOP_OUTPUT` | PASS |
| `YAP_PROBE_REPLAY_OUTPUT` | PASS |
| `YAP_NATIVE_PUBLICATION_OUTPUT` | PASS |
| `YAP_MATERIALIZER_TESTS` | PASS |
| `YAP_MATERIALIZER_DESCRIPTOR_OUTPUT` | PASS |
| `YAP_PUBLICATION_OUTPUT` | PASS |
| `YAP_AUDIO_FORMAT_OUTPUT` | PASS |
| `YAP_JOURNAL_FAILURE_OUTPUT` | PASS |
| `YAP_PCM_WINDOWS_OUTPUT` | PASS |
| `YAP_PCM_ADMISSION_OUTPUT` | PASS |
| `YAP_CAPTURE_GAP_OUTPUT` | PASS |
| `default` | PASS |
| `YAP_SOURCE_RECOVERY_CHILD` | PASS through `YAP_SOURCE_RECOVERY_OUTPUT` (internal child entry point) |
| `YAP_JOURNAL_LEASE_CHILD` | PASS through default (internal child entry point) |

39 of the 40 top-level entries pass, including default. The retained-publication cost probe
was invoked with a freshly generated donor and refused with `INELIGIBLE_RETAINED_CAMERA`
(exit 133). It requires a historical donor with exactly 6,145 pictures and picture digest
`4e923cdd76e318daf9f131c7a1b79ee8d2b1afadc48d98bdec274c2754c517d0`.
Its retained verification points at a private physical capture outside this checkout. No
eligible generated donor is supplied here; that private recording was not accessed under
the task's fixture/media restriction. Its performance body remains unverified;
the acceptance guard was preserved. No physical hardware or performance claim is made.

## Per-file results

| File | Result |
| --- | --- |
| `helpers/mac/Tests/audio-state.test.mjs` | PASS, 1 |
| `helpers/mac/Tests/source-frame.test.mjs` | PASS, 2 |
| `helpers/mac/Tests/source-evidence.test.mjs` | PASS, 20 |
| `helpers/mac/Tests/recovery.test.mjs` | PASS, 5 |
| `helpers/mac/Tests/wire.test.mjs` | PASS, 4 |
| `helpers/mac/Tests/speech.test.mjs` | PASS, 6 |
| `helpers/mac/Tests/refusal.test.mjs` | PASS, 1 |
| `helpers/mac/Tests/publication.test.mjs` | PASS, 15 |
| `packages/core/src/capture-publication.test.ts` | PASS |
| `packages/core/src/capture-store.test.ts` | PASS |
| `packages/core/src/capture-acquisition.test.ts` | PASS |
| `packages/core/src/capture-interruption.test.ts` | PASS |
| `packages/core/src/source-admission.test.ts` | PASS |
| `packages/core/src/index-capture-evidence.test.ts` | PASS |
| `apps/service/src/capture-finalizing.test.ts` | PASS, 16 |
| `apps/service/src/capture.test.ts` | PASS: 25 initially; 2 startup cases on isolated rerun |
| `apps/service/src/capture-lifetime.test.ts` | PASS |
| `apps/service/src/capture-source-lifetime.test.ts` | PASS |
| `apps/service/src/project-capture.test.ts` | PASS |
| `apps/service/src/source-export.test.ts` | PASS, 3 |
| `apps/service/tests/project-export.mjs` | PASS, 22 |
| `apps/service/tests/package-workspace-recovery.mjs` | PASS, 8 |
| `apps/service/tests/publication.mjs` | PASS, 13 |
| `packages/protocol/src/refusal-ledger.test.ts` | PASS, 10 |

## Assertion updates

Retryability assertions changed in `CaptureAudioMaterializerTests.swift`,
`CaptureAudioPublicationTests.swift`, `EmptyCaptureRecoveryTests.swift`,
`source-evidence.test.mjs`, `capture-publication.test.ts`, and
`capture-finalizing.test.ts`. `SourcePublicationRecoveryTests.swift` now asserts unavailable
for immutable authority/media conflicts and pending only for the operational permission case.
These are production materialization, recovery, evidence export and persisted-service paths.

## Review and scope

The shape, diff and documentation self-review found no second runtime verdict owner or
unrelated production change. `jobs.ts` is unchanged. The independent
`codex exec --sandbox read-only review --uncommitted` attempt failed with
“Selected model is at capacity” and `turn.failed` (exit 1); it did not complete a review.
The slice Contract and Verification items were checked against the diff and these results.
No full repository suite was run and no commit was created.
