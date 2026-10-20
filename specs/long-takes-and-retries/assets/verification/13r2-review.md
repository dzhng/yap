# Review round 13r2: dispositions and verification

Scope: `/tmp/lt-codex/review2-findings.md`, checked against the actual worktree.
Starting revision: `d3a3bef5b`. Code fixes are committed in `22ecab40c` (TypeScript)
and `353cc8518` (Swift/app). Fixed decisions and KEEP items were preserved. The origin recording and user library
were not accessed. Historical journal/media fixtures were not modified.

## Findings

| ID | Disposition | Evidence / proving check |
| --- | --- | --- |
| A1 | fixed | `json-stream.test.ts`: malformed/nonregular JSON and changing inventory; callers map SyntaxError to INVALID_NATIVE_RESPONSE / INVALID_PACKAGE. |
| A2 | fixed | `worker.test.ts`: numeric and observed deadlines include startup; `work-budget.test.ts`: scaled budgets include one allowance. Default remains 30 seconds, shared with public waiting. |
| A3 | fixed | `json-stream.test.ts`: maximum record fits, near-full transport page succeeds, oversized page refuses; `project-evidence.test.ts` bounds projected pages. |
| A4 | fixed | `capture.test.ts`: persisted queued cleanup resumes; `work-budget.test.ts`; capture recovery, cleanup and source export call captureWorkDeadlineMs. |
| A5 | fixed | `project-evidence.test.ts`, package export integration: chunked writes and returned content identities. |
| A6 | fixed; native translation not-a-bug | `evidence.test.ts`, `project-package.test.ts`: receipt admission. source-admission.ts translates native INVALID_JOURNAL / INVALID_MEDIA and related provenance refusals before normalized output exists; it does not catch validateSourceReceipt. That translation stays. |
| A7 | fixed | A13 removes the unused second policy store; receipt sampling remains authoritative (`trails.test.ts`, `journal-schema.test.ts`). |
| A8 | fixed | `journal-schema.test.ts`, `trails.test.ts`: DEFAULT_CURSOR_SAMPLING and receiptCursorSampling own defaults and receipt reads. |
| A9 | fixed | `jobs.test.ts`: context jobs derive retry verdicts from error codes. |
| A10 | fixed | `transcript-backlog.test.ts`: snapshot of an actual running job resumes once after restart with the same job identity; driver no longer decides interrupted status. |
| A11 | fixed | `cursor-render.test.ts`, `trails.test.ts`: rendering consumes the typed core sourceCursorOverlay adapter, including native available sample status. |
| A12 | fixed | `consumer-cli.test.mjs` verdict parity, `launcher.test.mjs` and `release.test.mjs`: shared ledgerVerdicts; acquisition message has no retry-delay literal. |
| A13 | fixed | Repository-wide production-consumer search found none. Deleted portable ordered/evidence pages, tests and exports; live evidence reads/export remain covered by `evidence.test.ts` and `evidence-owner.test.ts`. |
| A14 | fixed | Protocol build/tests: removed refusalCause and RetryDirective exports; stroke byte rate is local to requirements.ts. |
| A15 | fixed | `project-package.test.ts`: tests parse JSON before manifest admission; production already supplies semantic JSON. |
| A16 | fixed | `composition-pointer.test.ts`: public preparation consumes its owning limits without an unused override parameter. |
| A17 | fixed | `capture-store.test.ts`: removed unwritten/unread complete.reason from LifecycleEvent. |
| A18 | fixed | `evidence.test.ts`: both traversal APIs use the same indexed batches; query-plan checks inspect each bounded seek. |
| A19 | fixed | `compiled-render.test.ts`; removed one-argument Math.min and obsolete undefined copy argument. |
| A20 | fixed | `worker.test.ts`, service publication/archive tests: fixed deadlines are numeric; only growing archive work uses observation polling. |
| A21 | fixed | `capture-store.test.ts`: read-time retry projection survives stale stored bits; pending native bits are stripped at admission. |
| A22 | fixed | `jobs.test.ts`: one retry verdict gates details.retry. |
| A23 | fixed | `jobs.test.ts`: terminal error-code interpretation supplies the actual code; retry does not invent OWNER_DELETED. |
| A24 | fixed | `jobs.test.ts`: explicit CANCELED / OWNER_DELETED at discard call sites; historical reason interpretation remains in jobErrorCode SQL. |
| A25 | fixed; request validation not-a-bug | `capture-store.test.ts`, `operation-errors.test.ts`: typed reports only check identity. withResolvingCall receives malformed requests too (missing jobId, unknown operation, empty requestId); its safeParse prevents advertising invalid recovery requests and stays. The validated projection now attaches the directive directly, avoiding the second operation parse in operationError. |
| A26 | fixed | Core/service package archive tests: removed duplicate copied-byte floor; malformed or unsafe inventories use INVALID_* / storage diagnostics rather than fictional limits. |
| A27 | fixed | `evidence.test.ts`, capture/package tests: validated receipts use known capabilities. |
| A28 | fixed | `work-budget.test.ts`: direct byte-throughput formula; journal rate cites the retained probe results. |
| A29 | fixed | `worker.test.ts`: speech receives the requested total deadline; model loading allowance belongs to transcriptionDeadlineMs. |
| A30 | kept | Streaming transcript-import reader left unchanged, as directed. |
| A31 | fixed | `operation-errors.test.ts`: withResolvingCall names its result-wide projection. |
| A32 | fixed | `package-registry.mjs`: admittedBytes names retained/admitted bytes without implying an enforced budget. |
| A33 | fixed | `refusal-ledger.test.ts`: standing rationale replaces worksheet narrative; exact literal source counts regenerated. |
| A34 | fixed | `recording-prompt.test.ts`, native fixture integration: YAP_CAPTURE_FIXTURE / OPTIONS and explicit schema selection; prompt bytes unchanged. |
| A35 | fixed | Composition-pointer and recording-prompt comments corrected; retryablePreviewDependency names the export dependency check (`project-export-recovery.mjs`). |
| B1 | fixed | `capture-start-interruption.test.mjs`, maximum-cleanup mode: one initial finalizing transition before physical closure, no maximumDuration failure reason, exactly one completion reason; cleanup retains completion. Later publication updates legitimately have their own sequence-numbered finalizing observations. |
| B2 | fixed | Native Schema4Tests summary case with sourceKind region persists region. Prompt projection alone calls it area (`recording-prompt.test.ts`). |
| B3 | fixed | RequirementsTests loads the JSON TypeScript imports; app build bundles requirements.json; record bound computed once in YapProtocol. |
| B4 | fixed | Native/app builds, controls and refusal fixtures: YapProtocol has no media dependency; controls link only its objects. Removed the unused YapMedia library product. |
| B5 | fixed | YapControlsTests import verdict cases and `library-controls.test.mjs`: Job owns isActive and retryJobId; permanent failures remain visible without a retry action. |
| B6 | fixed | Schema4Tests summary/undo/republication: publisher returns (summary, marks); CaptureJournalSummary no longer has mutable liveMarks. |
| B7 | fixed | CursorGeometryTests: explicit flush(through:) at test boundaries; one production flush cadence. |
| B8 | kept | Schema-4 cursorSampling.holds remains in the header, as directed by Q2. |
| B9 | fixed | `service-errors.test.mjs`: wire retryable:false / retryAfterMs:1 cannot override NOT_READY ledger verdict/delay, on ordinary and terminal service failures. |
| B10 | fixed | `source-visual-samples.test.mjs`: >100,000 real decoded frames, no traversal ceiling; exact clocks and cancellation remain covered. High-density synthetic media reaches the old ceiling without recording hardware. Take length alone does not establish the cited 55-minute failure: the grid is limited to 10.2 seconds and PresentationSource starts at the first selected time. The bracketed removal still fixes the valid high-density refusal. |
| B11 | fixed | Derivations beside presentation evidence, source receipt and camera callback envelope bounds; native suites exercise the bounded encoders. |
| B12 | fixed | Archive/refusal/recovery tests and app controls: removed redundant manifestIdentity, details.cause, unread job retry bit, producerless ledger codes and default failure callback. |
| B13 | fixed | Native archive, camera and pointer tests; stale budget text removed, write failures use WRITE_FAILED; pointer observations documented as change-only writes. |
| B14 | fixed; timer guards not-a-bug | YapControlsTests: complete/non-live take with stale nonretryable error retains Start Recording. MarkRecognizer/schema tests cover removed duplicates. CaptureWriter timer runs later on its writer queue; finishing/pause/clock state can change after scheduling, so the callback rechecks stay. |
| B15 | fixed | Native camera/publication and archive tests: Codable reads/writes complete gap receipts; archive member plan is decoded once. |
| B16 | fixed | RequirementsTests checks the loaded authority and CaptureJournal bound, without re-deriving a second formula. |
| C — false statements | fixed | Checked against operation schemas, job projection, capture store and git history; prior review fixes are commit 2b664fbce. Completion is null for ordinary stops; retry details are conditional. |
| C — duplication/placement | fixed | Protocol owns envelopes; core owns terminal jobs/completion; skill owns retry guidance. Native/service/catalog keep only their boundary facts in the appropriate sections. |
| C — narrative | fixed | Historical goldens predate linear readers; probe describes the measured motion ratio; fixture instructions link the journal-import owner. |
| C — missing coverage | fixed | Requirements pointers, cursor hold/in-force semantics, consecutive long strokes, 12-hour completion, consumer verdict projection, conditional app Retry and short-prompt release note added. |
| C — links | fixed | Root AGENTS link repaired; deleted raw-cursor / portable-page paths unlinked in historical evidence. Changed-doc relative links checked. |
| C — spec contradictions | fixed | Interrupted-transcript restart exemption documented; requirement map and handoff reconciled. Next release heading preserved. Release/origin acceptance/close-spec remain future work. |

## Regression proof

Each requested behavior regression was observed failing with its old behavior or
with that behavior deliberately restored, then restored to the fixed implementation:

| Finding | Red evidence | Green check |
| --- | --- | --- |
| A1 | Changing inventory misreported as malformed JSON | json-stream.test.ts |
| A2 | Extra worker startup padding made an explicit 1ms deadline succeed | worker.test.ts |
| A3 | Old two-record response bound rejected a transport-sized valid page | json-stream.test.ts |
| A10 | Interrupted submission omitted the retry job identity | transcript-backlog.test.ts |
| B1 | Restored maximum callback wrote a second initial finalizing transition | capture-start-interruption.test.mjs |
| B2 | Restored region→area publication failed the native region assertion | Schema4Tests |
| B9 | Restored wire overrides returned false/1 instead of ledger true/15000 | service-errors.test.mjs |
| B10 | Restored decode/traversal ceilings refused >100,000 physical frames | source-visual-samples.test.mjs |
| B14 | Restored filter omitted capture.startOrStop for a completed take | YapControlsTests |

Detailed run logs are retained under `/tmp/lt-codex/` (`red-*`, `resume-*`, `final-*`).
Initial compilation-only false reds were discarded; the rows above refer to
assertion failures demonstrating the intended regression.

## Final checks

Every build/check below used `YAP_NATIVE` pointing at this worktree's debug helper.
The package commands ran serially, using `npx turbo test --filter=@yap/<pkg> --concurrency=1`.
Native products were built with separate commands (SwiftPM only honors the final
`--product` if repeated).

| Command / stage | Result |
| --- | --- |
| `bun run build` | Pass; packaged Yap.app built again after the final cleanup. |
| `swift build --build-system native --package-path helpers/mac --product yap-native` | Pass. |
| Same command with `--product YapCaptureTests` | Pass. |
| Protocol package | Pass: 14 files, 87 tests; ledger consistency checked again after cleanup. |
| Core package | Pass: 102 files, 1,047 tests, 15 skipped; final focused cleanup: 122 tests pass. |
| CLI package | Pass: 7 files, 127 tests, 2 skipped. |
| Service package | Three baseline beforeAll timeouts (ffmpeg-artifact, ffmpeg-input, hdr-conversion-held). The one new budget expectation was corrected; 396 other tests passed, 45 skipped in the aggregate run. Final focused service regressions pass. |
| Service node integration stage, run explicitly because Vitest stopped its chain | 190/194 initially pass. All three syscall-barrier failures pass on isolated rerun (5 matching cases pass). The remaining version-6 source-index fixture fails identically in the starting-revision and worktree resolvers. |
| macOS package | All Swift capture/frame/source-audio/composition-audio/selected-audio/speech/controls suites pass. Native node stage: 113/114 pass; the B-frame preroll mismatch matches baseline. |
| macOS app node stage, run explicitly after the native stage stopped the chain | 144 pass, 11 fail, 1 skipped. Live display/window capture and source-list checks remain unavailable in this session; repeated one file at a time with the same failures. See limitations below. |
| `bun run test:tools` | 196/202 pass. Five failures match baseline families; the sixth, signing interruption, passes with full Xcode selected through DEVELOPER_DIR. |
| Signing lab with full Xcode | Interruption/cleanup passes; certificate test fails with “no identity found”, matching baseline. No global developer-directory setting changed. |
| `bun run check-types`, `bun run lint`, `bun run format:check` | All pass after final code cleanup. |
| `node scripts/presets-index.mjs --check` | Pass; run explicitly because the tool-test chain stopped before it. |
| Historical normalized journal export | 4/4 pass: schema3-marks, launch-capture, launch-source, narrated-workbench. Full bytes and receipts compared against retained goldens. |
| `git diff --check` and changed-doc relative links | Pass. |

### Baseline comparison and remaining validation

The supplied `/tmp/lt-codex/baseline-test.log` contains the same three service
fixture-compilation hook timeouts and the same native B-frame edit-list failure.
The baseline tools log contains the consumer descendant-pipe failure, production
launcher entry timeout, kit/launcher smoke failures and signing certificate failure.
Those unchanged requirements were not weakened.

The saved baseline never reached either later node stage, so their failures are
not silently labeled baseline. Additional evidence:

- Source-index version-6 package: transpiled the original `d3a3bef5b` project-package.ts
  into a temporary module and fed both resolvers the same retained ZIP members.
  Both report `INVALID_PACKAGE: Missing transitive project dependency`.
  Log: `/tmp/lt-codex/baseline-version6-proof.log`; temporary module removed.
- Three native syscall barriers: initially failed under the concurrent service
  integration stage, then all passed in the isolated 5-case run. Log:
  `/tmp/lt-codex/final-service-barriers.log`.
- App checks: display fixtures see no selected display, window takes finish with
  `NO_VIDEO` and no usable source movie, and source-list UI waits expire. These
  persist in serial file runs. CaptureInputSession.swift and the complete
  CaptureController.sources method are byte-identical to `d3a3bef5b`; CaptureWriter's
  production change is its protocol import. This is evidence of unavailable live
  capture/source discovery here, not a passing app acceptance claim. The eleven
  live app gates remain **unverified**; a working display/capture session is needed.
- Signing interruption initially failed before reaching its held codesign child
  because Command Line Tools was selected. `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`
  reaches that child and passes cleanup. The remaining scratch certificate failure
  then reproduces the baseline's missing identity.

Logs and command exit summaries: `/tmp/lt-codex/final-*.log`, `last-*.log`,
`final-results.tsv`, `corrected-results.tsv`, `remaining-results.tsv`,
`isolated-results.tsv`, `last-results.tsv`.

No source media or historical golden was rewritten. Approved prompt text and app
copy remain intact. `.husky/` remains untracked and unstaged. Release, origin-take
acceptance and close-spec were outside this review round and remain open.
