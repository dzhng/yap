# Slice 10 verification

Implementation evidence recorded before the initial slice commit, 2026-10-20.
No full repository run, user library or user recording was involved. The [probe report](README.md#slice-10-derived-limits-12-hour-combined-profiles)
owns the before/after measurements; [the visual receipt](slice10-visual-review.md)
owns the completion-notice review.

## Contract coverage

| Contract | Production-path evidence |
| --- | --- |
| Apply slice-10 limit verdicts | Aggregate byte/count guards removed across capture, evidence, pointer/presentation, speech and packages. Portable rows derive their allowance beside the constant; actual bytes and selected durations derive work budgets through protocol `derivedBound`. Fixed shapes, batches, authored complexity and explicit excerpt primitives retain their classified limits. |
| Clean stop, pauses excluded | `MaximumTakeTests` drives `PrerecordedCaptureInput` and the real writer/publication with only hardware ingress and host time substituted. At T−1 recording continues; at T it stops/finalizes once, publishes `complete`, has no failure code, and records lifecycle reason `maximumDuration`. A 20-hour pause consumes none of T. |
| Complete take imports normally | `maximum-take.mjs` runs that native fixture, the real source exporter, media probe, acquisition copy and evidence indexer. Result: 43,200,000,000 us, one video binding, `maximumDuration`, no interruption. |
| Retired literals disappear | `derived-limits.test.ts` scans production capture, wire, speech, core and service source; only the historical CaptureJournal record-format exception is allowed. |
| 12-hour synthetic stages | Both combined profiles export, validate and index all 2,592,000 cursors. Publication reaches its expected missing-video prerequisite; no size bound fails. Exact measurements are in `slice10-results.json`. |
| Selected-capture expectation | Deleted the artificial three-row/two-row `EVIDENCE_LIMIT` mechanism and its refusal tests. Real shared-ingress media tests pass; separate production camera tests publish 502 runs and 501 gaps. |
| Existing clocks/authority/cancellation | Focused clock, requirements, selected capture, publication ownership, archive identity/cancellation/cleanup, camera toggling and recovery checks pass. |
| Slice-08 boundary | `CaptureJournal.swift` and stroke ending are unchanged. No journal schema handling or record-bound change is included. The large journal probe still writes schema 3. |

## Focused commands and outcomes

Commands below were run from the worktree root. This is a retained task receipt,
not a new repository-wide test prescription. Passing checks were reused when
subsequent edits could not move their owners.

```sh
bun run --cwd packages/core test \
  src/derived-limits.test.ts src/json-stream.test.ts src/ordered-pages.test.ts \
  src/evidence.test.ts src/project-evidence.test.ts src/project-package.test.ts \
  src/composition-pointer.test.ts src/presentation-evidence.test.ts src/trails.test.ts \
  src/asset-transcript.test.ts src/capture-store.test.ts src/assets.test.ts \
  src/transcript-import.test.ts src/transcript-ownership.test.ts
```

Pass: 228 tests in 14 files, 19.03 s. After final parser-error normalization,
the four affected files (`derived-limits`, `json-stream`, `project-package`,
`transcript-import`) passed again: 13 tests, 0.751 s; the final scan/parser rerun passed again (13 tests, 0.808 s).

```sh
YAP_PRESETS_REFRESH=0 node_modules/.bin/vitest run --root apps/service \
  src/worker.test.ts src/source-export.test.ts src/work-budget.test.ts \
  src/publication.test.ts src/project-capture.test.ts --maxWorkers=1
node --test apps/service/tests/maximum-take.mjs
node --test apps/service/tests/archive-write.mjs
```

Pass: 40 service tests in five files, 13.45 s; automatic-stop/import proof,
one test, 9.39 s total (final rerun 8.46 s); archive writing, 11 tests, 5.74 s. Selected real archive
extraction tests passed six cases (including growing metadata and exact manifest
identity). Real package export/pin/commit/reopen passed one case; real publication
inspection/ownership and prepare/commit/reconcile/acknowledgement passed two.
Five selected service lifecycle/cancellation/unanswered-start cases passed with
`YAP_PRESETS_REFRESH=0`; an earlier run without that environment setting timed
out at service startup and was not counted as proof.

```sh
YAP_CAPTURE_CLOCK=1 helpers/mac/.build/debug/YapCaptureTests
YAP_REQUIREMENTS=1 helpers/mac/.build/debug/YapCaptureTests
node packages/test-harness/long-take/probe.mjs \
  --output /tmp/lt10-probe --hours 12 \
  --profiles combined-typical,combined-worst
```

Pass: six focused clock assertions and protocol/native requirement equality.
Selected capture media/input, camera sessions/cancellation and availability/recovery
also pass. Camera coverage includes 502 turn-ons, 501 gaps and measured Stop
work of 2,524 ms. Native `YapCaptureTests`, `yap-native`, app controls and the actual
CaptureController journey compiled; controls tests, including the ordinary
maximum-duration notice, passed.

The probe ran to completion for both profiles. Typical/worst journal bytes are
1,392,503,313 / 1,392,503,241; normalized bytes are 447,810,829 / 447,810,757.
Publication reports `INVALID_MEDIA: Source authority member is missing or replaced.`
as expected for a journal-only fixture. Its measured work is 59.830 / 78.477 s;
export is 46.719 / 56.138 s, below the 622.360 s derived journal allowance.
The successful small-media stop/import proof above complements this large-journal
measurement; it does not make the journal-only publication successful.

The final streaming-write cleanup preserved package bytes through the actual
export/pin/commit/reopen and canceled-transcript retry paths (two tests, 1.51 s).
`node --test apps/service/tests/archive-write.mjs apps/service/tests/package-archive.mjs`
passed all 54 cases, 58.51 s, including large inventory, malformed archives,
retained authority, cancellation and cleanup. Three stale registry byte-reservation
expectations were observed failing, then rewritten to the deleted-cap contract:
65 GiB sparse pending inputs have no aggregate byte pool; the four-owner rule and
actual confirmed inventory remain authoritative. The obsolete inline receipt-cap
refusal test was deleted; growing held-receipt coverage remains in the archive suite.
The focused registry command (`YAP_NATIVE=$PWD/helpers/mac/.build/debug/yap-native
node --test --test-name-pattern='registry reserves before|large pending admissions|four pending opens|partial copy cancellation'
apps/service/tests/package-registry.mjs`) passed four tests, 1.58 s.
Resource metadata and transcript receipts now write through the same incremental
serializer as manifests; package identity hashing also consumes its chunks. This
is an output-preserving refactor, checked through independent archive/reopen consumers.

Core and service `build` and `check-types` passed. `oxfmt --check` and `oxlint`
passed on all 65 changed TS/JS/JSON files, with no lint warnings.
`git diff --check` passed. Offscreen before/after captures passed layout checks;
matched unchanged controls/footer crops had zero pixel differences. The unprimed
visual review found no defects, both full images were shown in one Preview window,
and the screenshot receipt checker passed. Disposable output was removed after
this evidence was retained.

## Red/green evidence

- The retired-literal scan initially found 32 failures; it now passes.
- The automatic-stop test initially failed: “Twelve hours must run ordinary finish
  automatically.” It now publishes and imports the complete take.
- Restoring the old page owners made three large-record/continuation tests fail;
  restoring the implementation made them pass.
- The old package dependency cap rejected 25,001 entries; the admitted inventory
  now passes. Sparse asset support above 100,000 intervals similarly failed the
  old guard and now passes without merging gaps.
- Breaking incremental UTF-8 decoding made the streamed-caption boundary test
  fail; restoring it made the test pass.
- Work-budget tests exposed fixed addends and null/callback forwarding failures.
  Real publication inspection then exposed tiny byte-work deadlines expiring
  during IPC; separating the existing control allowance made that path pass.
- Reopening the catalog originally lost the completion reason; the persistence
  test now retains it separately from interruption/failure data.

## Choices and evidence limits

- The writer's existing idle/ingress path pins T and asks the ordinary native/app
  finish owner to close the take. This keeps one owner of finalization.
- Completion reason uses an additive `recording_completions` table, with no catalog
  format bump, so a successful lifecycle reason never occupies failure fields.
  Cancellation stays terminal after deleting the arbitrary reserved sequence ceiling.
- Growing JSON is parsed/serialized incrementally in its existing owners. Typed
  cue, descriptor and support inventories remain ordinary semantic values; this
  does not claim constant memory for arbitrary authored complexity. Core owns the
  shared JSON stream primitive and its `@streamparser/json` dependency.
- The private archive worker writes growing receipts through inherited fd5 and
  observed work through fd6; fd3/fd4 retain workspace/archive ownership. Its small
  wire reply confirms receipt bytes. Parsed manifest values retain the original
  manifest's exact byte/hash identity, avoiding reserialization as an identity proof.
- Unknown recovery duration reserves T until proven; actual selected roles and
  sequential traversals own media work. Existing fixed control-IPC allowance is
  separate from byte work. Archive cleanup has no guessed unlink-throughput timer;
  finite owned inventory, cancellation and process-parent lifetime own cleanup.
- Publication passes remain separate: measured journal work is below the derived
  allowance. Six nominal pass equivalents are the budget model; the additional
  original-prefix verification means seven physical scans. Admission preserves its
  separate held-source identity-checked copy. No new disk reserve or PCM evidence
  reduction was introduced, following the verdicts.
- Dense 12-hour camera/audio payload and its stop latency remain unmeasured. The
  successful stop fixture uses sparse generated video; the large fixture has no
  video. Schema-4 integration belongs to the parallel slice and later closeout.
- Independent Codex review was attempted twice in read-only mode. Both exited 1
  with `turn.failed: Selected model is at capacity. Please try a different model.`
  Neither produced a review verdict. Manual shape/diff/docs review completed;
  independent code review remains unavailable, not clean. No unchanged third retry
  or model override was made.

## Feature-branch integration

Slice commit `4b418bbd` was merged with feature head `b7fc5843` (slices 05, 08 and
09). Conflicts combine the uncapped publication summary with schema-4 live-mark
facts, cursor flush scheduling with the injectable capture clock, and all focused
native test selectors. The new cursor timer uses the writer's existing clock too.
`CaptureJournal.swift`, `trails.ts` and `FrameTypes.swift` exactly match the feature
head: schema/record bounds remain slice 08's and time-based trails remain slice 09's.

The native generators reproduced `schema3-long-stroke.jsonl` byte-for-byte and
regenerated all three schema-4 fixtures. The journals now include slice 09's
`written` cursor statistic; summary byte/hash identities came from the generated
native output. No fixture content was hand-edited.

Requested checks on the integrated tree:

| Check | Result |
| --- | --- |
| `swift build --build-system native --package-path helpers/mac --product YapCaptureTests` | Pass |
| `swift build --build-system native --package-path helpers/mac --product yap-native` | Pass |
| `YAP_SCHEMA4_TESTS=1 helpers/mac/.build/debug/YapCaptureTests` | Pass, 0.68 s |
| `YAP_JOURNAL_TESTS=1 helpers/mac/.build/debug/YapCaptureTests` | Pass, also rerun after fixture regeneration |
| `YAP_RECOVERY_TESTS=1 helpers/mac/.build/debug/YapCaptureTests` | Pass, 15.13 s |
| `YAP_CURSOR_TESTS=1 helpers/mac/.build/debug/YapCaptureTests` | Pass, 2.07 s |
| `YAP_REQUIREMENTS=1 helpers/mac/.build/debug/YapCaptureTests` | Pass |
| `YAP_MAXIMUM_TAKE=1 helpers/mac/.build/debug/YapCaptureTests` | Pass, 8.03 s; exact T, 20-hour pause excluded |
| Core requested selection plus retired-literal scan, `YAP_NATIVE` set | Pass, 104 tests in 10 files, 2.19 s |
| `UPDATE_REFUSAL_LEDGER=1 bun run --cwd packages/protocol test src/refusal-ledger.test.ts` | Pass, 10 tests; counts refreshed for nine codes |
| `bun run --cwd packages/protocol test` without update mode | Pass, 85 tests in 14 files |
| `bun run --cwd packages/core check-types` | Pass |
| Composition, protocol, core and service builds | Pass |
| `node --test apps/service/tests/maximum-take.mjs` | Pass, 8.28 s; one admitted video binding at exact T |
| `bun run --cwd apps/service check-types` | Pass |
| Service `cursor-render.test.ts`, `YAP_PRESETS_REFRESH=0`, `YAP_NATIVE` set | Pass, two tests, 6.73 s; real dense/held native render equivalence |

The core command was:

```sh
YAP_NATIVE=$PWD/helpers/mac/.build/debug/yap-native bun run --cwd packages/core test \
  src/trails.test.ts src/evidence.test.ts src/evidence-pages.test.ts \
  src/ordered-pages.test.ts src/capture-publication.test.ts src/source-admission.test.ts \
  src/journal-schema.test.ts src/project-package.test.ts src/transcript-import.test.ts \
  src/derived-limits.test.ts
```

The initial integrated core run exposed two stale calls to slice 10's deleted
pointer-budget helper and one deleted manifest-size refusal expectation. Those
three tests were reconciled with the new contracts, then all 104 passed. No
compatibility helper was restored. Exact comparison with feature-head ledger
JSON, excluding only each code's `files` map, confirms no verdict, retryability,
cause, delay or other non-count metadata changed.
The additional service typecheck exposed the same deleted pointer-budget API in
its native cursor-render fixture. A focused red run also identified the fixture's
obsolete private `maxBytes` operand. Both were removed; service type checking and
both cursor-render cases then passed with real native work.

A read-only independent review of this merge was attempted. It exited 1 with
`turn.failed: Selected model is at capacity. Please try a different model.` and
produced no verdict. Manual review and all checks above completed; the failed
independent review is not counted as a clean review.

## Files changed

One line per slice-owned changed file follows. Unrelated pre-existing `.husky/`
content is excluded and left untouched.

- [apps/macos/Sources/Yap/CaptureController.swift](../../../../apps/macos/Sources/Yap/CaptureController.swift) — Route the duration trigger through ordinary finish and retain its reason.
- [apps/macos/Sources/YapControls/CapturePresentation.swift](../../../../apps/macos/Sources/YapControls/CapturePresentation.swift) — Show maximum duration as an ordinary completion notice.
- [apps/macos/Sources/YapControls/ControlsState.swift](../../../../apps/macos/Sources/YapControls/ControlsState.swift) — Retain the successful lifecycle reason for presentation.
- [apps/macos/tests/YapControlsTests/CapturePresentationTests.swift](../../../../apps/macos/tests/YapControlsTests/CapturePresentationTests.swift) — Assert the ordinary maximum-duration notice.
- [apps/macos/tests/fixtures/capture-view.swift](../../../../apps/macos/tests/fixtures/capture-view.swift) — Render synthetic before/after completion-notice evidence.
- [apps/service/src/archive-input.ts](../../../../apps/service/src/archive-input.ts) — Remove the compressed archive byte ceiling while retaining admission identity.
- [apps/service/src/archive-write.ts](../../../../apps/service/src/archive-write.ts) — Stream the growing native assembly plan.
- [apps/service/src/capture-cleanup.ts](../../../../apps/service/src/capture-cleanup.ts) — Budget actual journal/media work and selected roles during cleanup.
- [apps/service/src/capture.test.ts](../../../../apps/service/src/capture.test.ts) — Replace reserved-sequence assumptions with terminal cancellation behavior.
- [apps/service/src/capture.ts](../../../../apps/service/src/capture.ts) — Remove sequence reservation and budget recovery from actual bytes/roles/duration.
- [apps/service/src/package-archive.ts](../../../../apps/service/src/package-archive.ts) — Read growing held receipts and derive observed archive work budgets.
- [apps/service/src/package-registry.ts](../../../../apps/service/src/package-registry.ts) — Remove aggregate retained-byte accounting while preserving handle ownership.
- [apps/service/src/project-capture.test.ts](../../../../apps/service/src/project-capture.test.ts) — Check recovery work through the production callback budget.
- [apps/service/src/project-package-metadata.ts](../../../../apps/service/src/project-package-metadata.ts) — Parse/hash each held JSON member incrementally with exact identity.
- [apps/service/src/project-packages.ts](../../../../apps/service/src/project-packages.ts) — Stream receipts/resource metadata/manifests, hash identities incrementally and close transcript chunks by bytes.
- [apps/service/src/project-render.ts](../../../../apps/service/src/project-render.ts) — Remove the obsolete pointer aggregate input.
- [apps/service/src/publication.test.ts](../../../../apps/service/src/publication.test.ts) — Assert byte-scaled work without startup addends or timer clamps.
- [apps/service/src/publication.ts](../../../../apps/service/src/publication.ts) — Own derived publication/journal work and separate fixed IPC allowance.
- [apps/service/src/source-export.test.ts](../../../../apps/service/src/source-export.test.ts) — Assert selected-media traversal budgets and held-file behavior.
- [apps/service/src/source-export.ts](../../../../apps/service/src/source-export.ts) — Budget actual journal bytes and selected canonical role traversals.
- [apps/service/src/work-budget.test.ts](../../../../apps/service/src/work-budget.test.ts) — Pin duration/byte-scaled budgets through production budget owners.
- [apps/service/src/worker.test.ts](../../../../apps/service/src/worker.test.ts) — Cover long timers, observed budgets and invalid callback/null forwarding.
- [apps/service/src/worker.ts](../../../../apps/service/src/worker.ts) — Derive duration work, rearm representationally long timers and preserve cleanup ownership.
- [apps/service/tests/archive-write.mjs](../../../../apps/service/tests/archive-write.mjs) — Retain identity/cancellation tests after removing arbitrary archive caps.
- [apps/service/tests/maximum-take.mjs](../../../../apps/service/tests/maximum-take.mjs) — Import the real automatically completed prerecorded take.
- [apps/service/tests/package-archive.mjs](../../../../apps/service/tests/package-archive.mjs) — Prove streamed inventory, manifest identity and retained structural rules.
- [bun.lock](../../../../bun.lock) — Pin the shared incremental JSON parser dependency.
- [helpers/mac/Sources/YapCapture/CameraCaptureInput.swift](../../../../helpers/mac/Sources/YapCapture/CameraCaptureInput.swift) — Delete the camera turn-on count ceiling.
- [helpers/mac/Sources/YapCapture/CameraMedia.swift](../../../../helpers/mac/Sources/YapCapture/CameraMedia.swift) — Remove aggregate mapping/gap/frame ceilings and stream growing receipts.
- [helpers/mac/Sources/YapCapture/CaptureAudioMaterializer.swift](../../../../helpers/mac/Sources/YapCapture/CaptureAudioMaterializer.swift) — Delete the total sparse-run ceiling while retaining batching.
- [helpers/mac/Sources/YapCapture/CaptureClockIngress.swift](../../../../helpers/mac/Sources/YapCapture/CaptureClockIngress.swift) — Delete the aggregate camera observation row ceiling.
- [helpers/mac/Sources/YapCapture/CaptureSourcePublication.swift](../../../../helpers/mac/Sources/YapCapture/CaptureSourcePublication.swift) — Remove the journal byte cap and retain separate authority passes.
- [helpers/mac/Sources/YapCapture/CaptureWriter.swift](../../../../helpers/mac/Sources/YapCapture/CaptureWriter.swift) — Pin the exact recorded-time endpoint and trigger ordinary finish using an injectable host clock.
- [helpers/mac/Sources/YapCapture/ClosedCameraSource.swift](../../../../helpers/mac/Sources/YapCapture/ClosedCameraSource.swift) — Admit exact closed-mapping identities without aggregate size caps.
- [helpers/mac/Sources/YapCapture/NativeCapture.swift](../../../../helpers/mac/Sources/YapCapture/NativeCapture.swift) — Complete automatically with lifecycle maximumDuration and normal publication.
- [helpers/mac/Sources/YapFrames/PreparedPointers.swift](../../../../helpers/mac/Sources/YapFrames/PreparedPointers.swift) — Remove total pointer row/byte ceilings while retaining per-record shape.
- [helpers/mac/Sources/YapFrames/PresentationEvidence.swift](../../../../helpers/mac/Sources/YapFrames/PresentationEvidence.swift) — Remove total presentation/decode/history ceilings.
- [helpers/mac/Sources/YapFrames/RetainedJSONLines.swift](../../../../helpers/mac/Sources/YapFrames/RetainedJSONLines.swift) — Allow unbounded total input with independent record scanning.
- [helpers/mac/Sources/YapMedia/DecodedAudioInspection.swift](../../../../helpers/mac/Sources/YapMedia/DecodedAudioInspection.swift) — Remove the duplicate sparse-audio run count ceiling.
- [helpers/mac/Sources/YapSpeech/SourceTranscript.swift](../../../../helpers/mac/Sources/YapSpeech/SourceTranscript.swift) — Remove the whole-transcript byte ceiling.
- [helpers/mac/Sources/YapWire/ArchiveAssembly.swift](../../../../helpers/mac/Sources/YapWire/ArchiveAssembly.swift) — Parse assembly plans incrementally and remove aggregate archive caps.
- [helpers/mac/Sources/YapWire/ArchiveExtraction.swift](../../../../helpers/mac/Sources/YapWire/ArchiveExtraction.swift) — Stream manifest/inventory receipts with exact byte/hash identities.
- [helpers/mac/Sources/YapWire/ArchiveOperation.swift](../../../../helpers/mac/Sources/YapWire/ArchiveOperation.swift) — Own inherited receipt/work descriptors and observed byte accounting.
- [helpers/mac/Sources/YapWire/MediaRecovery.swift](../../../../helpers/mac/Sources/YapWire/MediaRecovery.swift) — Recover journals without a total byte ceiling.
- [helpers/mac/Sources/YapWire/PresentationEvidenceOperation.swift](../../../../helpers/mac/Sources/YapWire/PresentationEvidenceOperation.swift) — Remove total presentation limits at the native operation boundary.
- [helpers/mac/Sources/YapWire/SourceEvidenceExport.swift](../../../../helpers/mac/Sources/YapWire/SourceEvidenceExport.swift) — Export/verify journals and normalized evidence without aggregate byte caps.
- [helpers/mac/Tests/YapCaptureTests/CameraAvailabilityTests.swift](../../../../helpers/mac/Tests/YapCaptureTests/CameraAvailabilityTests.swift) — Prove publication/recovery beyond the old gap cap.
- [helpers/mac/Tests/YapCaptureTests/MaximumTakeTests.swift](../../../../helpers/mac/Tests/YapCaptureTests/MaximumTakeTests.swift) — Prove exact T, pause exclusion and successful automatic publication.
- [helpers/mac/Tests/YapCaptureTests/PrerecordedCaptureInput.swift](../../../../helpers/mac/Tests/YapCaptureTests/PrerecordedCaptureInput.swift) — Remove the artificial observation-row cap from the hardware fixture.
- [helpers/mac/Tests/YapCaptureTests/SelectedCameraInputTests.swift](../../../../helpers/mac/Tests/YapCaptureTests/SelectedCameraInputTests.swift) — Prove 502 camera turn-ons through production session ownership.
- [helpers/mac/Tests/YapCaptureTests/SelectedCaptureMediaTests.swift](../../../../helpers/mac/Tests/YapCaptureTests/SelectedCaptureMediaTests.swift) — Delete tests for the retired row-ceiling refusal.
- [helpers/mac/Tests/YapCaptureTests/main.swift](../../../../helpers/mac/Tests/YapCaptureTests/main.swift) — Expose the focused maximum-take production-path test.
- [helpers/mac/Tests/YapFrameTests/PresentationEvidenceTests.swift](../../../../helpers/mac/Tests/YapFrameTests/PresentationEvidenceTests.swift) — Use the uncapped production presentation scanner.
- [packages/core/package.json](../../../../packages/core/package.json) — Export the shared JSON stream owner and declare its parser dependency.
- [packages/core/src/acquisitions.ts](../../../../packages/core/src/acquisitions.ts) — Remove journal/mapping/member/interval ceilings while retaining typed authority validation.
- [packages/core/src/assets.test.ts](../../../../packages/core/src/assets.test.ts) — Prove sparse support above the deleted run cap.
- [packages/core/src/assets.ts](../../../../packages/core/src/assets.ts) — Remove the duplicate sparse-run metadata ceiling.
- [packages/core/src/capture-publication.ts](../../../../packages/core/src/capture-publication.ts) — Accept exact journal identities without an aggregate byte maximum.
- [packages/core/src/capture-source-read.ts](../../../../packages/core/src/capture-source-read.ts) — Close event pages by encoded bytes with continuation.
- [packages/core/src/capture-store.test.ts](../../../../packages/core/src/capture-store.test.ts) — Prove durable completion reason and terminal cancellation.
- [packages/core/src/capture-store.ts](../../../../packages/core/src/capture-store.ts) — Persist successful reasons separately and delete reserved-sequence assumptions.
- [packages/core/src/composition-pointer.ts](../../../../packages/core/src/composition-pointer.ts) — Remove aggregate rows/bytes/operations limits and retain cancellation/yields.
- [packages/core/src/derived-limits.test.ts](../../../../packages/core/src/derived-limits.test.ts) — Scan production source for retired literals with the historical format exception.
- [packages/core/src/evidence-merge.ts](../../../../packages/core/src/evidence-merge.ts) — Support byte-driven event-page continuation.
- [packages/core/src/evidence-pages.ts](../../../../packages/core/src/evidence-pages.ts) — Derive portable row allowance and remove growing metadata caps.
- [packages/core/src/evidence-read.ts](../../../../packages/core/src/evidence-read.ts) — Iterate existing boundary/audio batches instead of refusing whole selections.
- [packages/core/src/evidence.test.ts](../../../../packages/core/src/evidence.test.ts) — Keep evidence identity validation under uncapped aggregate reads.
- [packages/core/src/evidence.ts](../../../../packages/core/src/evidence.ts) — Delete total evidence/mapping/receipt/gap ceilings without changing journal schema interpretation.
- [packages/core/src/imported-transcript.ts](../../../../packages/core/src/imported-transcript.ts) — Stream supplied transcript parsing from its retained file.
- [packages/core/src/json-stream.test.ts](../../../../packages/core/src/json-stream.test.ts) — Exercise incremental UTF-8/JSON parsing and malformed input.
- [packages/core/src/json-stream.ts](../../../../packages/core/src/json-stream.ts) — Own shared incremental JSON decoding and batched serialization.
- [packages/core/src/ordered-pages.ts](../../../../packages/core/src/ordered-pages.ts) — Stream descriptor inventories, derive single-row capacity and retain ordinary page batching; remove stale ceiling diagnostics.
- [packages/core/src/package-archive.ts](../../../../packages/core/src/package-archive.ts) — Delete aggregate archive/manifest/receipt limits and validate streamed receipt identities.
- [packages/core/src/pointer-preparation.ts](../../../../packages/core/src/pointer-preparation.ts) — Delete whole-history byte/work budgets from pointer preparation.
- [packages/core/src/pointer-schedule.ts](../../../../packages/core/src/pointer-schedule.ts) — Stream pointer schedules without aggregate byte/event ceilings.
- [packages/core/src/prepared-audio.ts](../../../../packages/core/src/prepared-audio.ts) — Remove the duplicate audio support count ceiling.
- [packages/core/src/presentation-evidence.test.ts](../../../../packages/core/src/presentation-evidence.test.ts) — Test real presentation behavior without deleted aggregate options.
- [packages/core/src/presentation-evidence.ts](../../../../packages/core/src/presentation-evidence.ts) — Remove total presentation size/count/history limits while retaining fixed thumbnail shape.
- [packages/core/src/presentation-pointer-history.ts](../../../../packages/core/src/presentation-pointer-history.ts) — Stream pointer history without an aggregate event cap.
- [packages/core/src/project-events.ts](../../../../packages/core/src/project-events.ts) — Close projected event pages by bytes and preserve continuation.
- [packages/core/src/project-evidence.test.ts](../../../../packages/core/src/project-evidence.test.ts) — Prove large records, whole-take cursor selection and project event continuation.
- [packages/core/src/project-evidence.ts](../../../../packages/core/src/project-evidence.ts) — Stream support checkpoints and budget projected responses by bytes.
- [packages/core/src/project-index.ts](../../../../packages/core/src/project-index.ts) — Remove duplicate package index inventory ceilings.
- [packages/core/src/project-package.test.ts](../../../../packages/core/src/project-package.test.ts) — Prove growing metadata/dependencies through the real parser/resolver.
- [packages/core/src/project-package.ts](../../../../packages/core/src/project-package.ts) — Resolve independently parsed typed members and compute chunked metadata identities without total JSON/inventory caps.
- [packages/core/src/projects.ts](../../../../packages/core/src/projects.ts) — Remove duplicate package member/count caps and stream retained metadata reads.
- [packages/core/src/raw-cursor.ts](../../../../packages/core/src/raw-cursor.ts) — Derive selection duration from the take requirement and allow large holds.
- [packages/core/src/source-admission.ts](../../../../packages/core/src/source-admission.ts) — Copy held journal/mapping identities without the deleted aggregate cap.
- [packages/core/src/source-index.ts](../../../../packages/core/src/source-index.ts) — Remove duplicate package index inventory ceilings.
- [packages/core/src/trails.test.ts](../../../../packages/core/src/trails.test.ts) — Remove obsolete aggregate pointer-work refusal expectations.
- [packages/core/src/transcript-import.test.ts](../../../../packages/core/src/transcript-import.test.ts) — Prove streamed supplied-caption semantics and UTF-8 boundary behavior.
- [packages/core/src/transcript-import.ts](../../../../packages/core/src/transcript-import.ts) — Parse SRT/VTT/JSON incrementally without raw byte/cue ceilings.
- [packages/core/src/transcript.ts](../../../../packages/core/src/transcript.ts) — Stream speech records and remove total bytes/support-segment ceilings.
- [packages/protocol/src/capture.ts](../../../../packages/protocol/src/capture.ts) — Delete the reserved lifecycle sequence cap, retaining exact integer admission.
- [specs/long-takes-and-retries/README.md](../../../../specs/long-takes-and-retries/README.md) — Mark slice 10 implemented and route later work to its evidence.
- [specs/long-takes-and-retries/assets/probes/README.md](../../../../specs/long-takes-and-retries/assets/probes/README.md) — Append the required combined-profile before/after table and measurement limits.
- [specs/long-takes-and-retries/assets/probes/slice10-results.json](../../../../specs/long-takes-and-retries/assets/probes/slice10-results.json) — Retain sanitized machine-readable 12-hour probe measurements.
- [specs/long-takes-and-retries/assets/probes/slice10-status-after.png](../../../../specs/long-takes-and-retries/assets/probes/slice10-status-after.png) — Retain the reviewed ordinary completion-notice candidate.
- [specs/long-takes-and-retries/assets/probes/slice10-status-before.png](../../../../specs/long-takes-and-retries/assets/probes/slice10-status-before.png) — Retain the historical visual baseline.
- [specs/long-takes-and-retries/assets/probes/slice10-verification.md](../../../../specs/long-takes-and-retries/assets/probes/slice10-verification.md) — Retain contract proofs, decisions, review limits and per-file reasons.
- [specs/long-takes-and-retries/assets/probes/slice10-visual-review.md](../../../../specs/long-takes-and-retries/assets/probes/slice10-visual-review.md) — Retain unprimed review, comparisons and image identities.

- [apps/service/tests/fixtures/project-archive.mjs](../../../../apps/service/tests/fixtures/project-archive.mjs) — Materialize only synthetic test metadata from the production chunk stream.

- [apps/service/tests/package-registry.mjs](../../../../apps/service/tests/package-registry.mjs) — Replace deleted pool reservations with actual inventory and owner/cancellation behavior.
