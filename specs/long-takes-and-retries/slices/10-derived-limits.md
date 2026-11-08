# 10 — Derived limits and the 12-hour stop

Depends on: 02 (H1), 03, 07.

## Contract

- Every bound in `limit-verdicts.md` is either computed from a requirement with
  `derivedBound(...)` in its owning module, with the derivation beside it, or deleted.
- A take ends cleanly at `MAXIMUM_TAKE_US` of recorded time: the ordinary finish path runs, the
  take is `complete`, it imports normally, and the app shows a status line (not an error) that
  the take reached 12 hours.
- A synthetic 12-hour journal passes publication, export, import and reads (00's generator).

## Seam

- Constants per `limit-verdicts.md`, in their owning modules; no shared "limits" grab-bag
  besides the two requirements.
- Stop: the writer or `CaptureClock` owner triggers the existing finish path
  (`NativeCapture` / `CaptureController.finish`) when source time reaches the requirement. The
  lifecycle records a reason such as `maximumDuration`; it is not a failure code.
- If 02 decided the stop-time passes must fold (`CaptureSourcePublication.swift:339-381`,
  `acquisitions.ts:1027`), fold them into one streamed pass here.
- If 02 decided a free-disk check, add it here with its derivation.

## Run or see

00's generator at 12 hours through each stage, with the same table format; the before/after
table goes into `assets/probes/README.md`.

## Verification (red first)

- A scan test: the retired literals (`268_435_456`, `1_048_576` outside schema ≤3
  interpretation, line `65536`) no longer appear in capture, evidence, publication or package
  source.
- `PrerecordedCaptureInput` with only the clock faked crosses 12 hours and publishes a complete
  take; pause time doesn't count.
- 12-hour synthetic stages pass within the deadlines 02 derived.
- `SelectedCaptureMediaTests` (~111-129) expectation of `EVIDENCE_LIMIT` updated to the derived
  behaviour.

## Delegated

Trigger placement; margins already fixed in 02.

## Stays green

Media clocks, publication authority, camera toggling, cancellation cleanup.

## Slice 10b package-admission verification

2026-10-20, against `513318564`; no commit or user-library access.

The ready-package lifetime test passed unchanged at `b7fc5843` and failed here
before editing: its status remained `running` with a null handle. Its simulated
`archive.extract` returned an inline receipt. Slice 10 deliberately replaced that
wire contract with a streamed receipt on an inherited descriptor and a small
`{ receiptBytes }` response. The service correctly rejected the obsolete reply,
then awaited the cleanup that the test deliberately held open.

The correction belongs to the fixture: export an empty project through
`export.create`, then open its actual ZIP with the production native worker.
Only cleanup scheduling is held; extraction, descriptor admission and removal
are real. All original readiness, update-fence and asynchronous-close assertions
remain unchanged. There is no production compatibility path or restored limit.

Commands ran from the repository root with `YAP_NATIVE` pointing to this
checkout's freshly built `helpers/mac/.build/debug/yap-native`:

- `swift build --build-system native --package-path helpers/mac --product yap-native`
  and the same command with `--product YapCaptureTests`: pass (42.48 s / 11.94 s).
- `bunx turbo run build --filter=@yap/service --filter=@yap/client`, then
  `bunx turbo run build --filter=@yap/cli`: pass, including dependency builds.
- `bunx vitest run apps/service/src/project-service.test.ts -t 'a ready package handle blocks until retained files and asynchronous cleanup close'`:
  red before correction; green with the production fixture. Final whole-file
  rerun: 64/64 pass. `bun run --cwd apps/service check-types`: pass.
- Requested service Vitest selection, plus `project-capture`, with
  `--maxWorkers=4`: 159/163 pass across eight files initially. The three startup
  timeouts in `capture.test.ts` pass together in a focused rerun (3/3). A final
  whole-file rerun with `YAP_PRESETS_REFRESH=0` passes 27/27 in 138.49 s; this
  disables startup network refresh as in the retained slice-10 verification.
  Across these checks, 162/163 pass; the remaining failure belongs to slice 11.
- `YAP_PRESETS_REFRESH=0 node --test` with all 19 `.mjs` paths from the service
  manifest's test script: 181/194 pass initially. Twelve failures were in
  `export-replacement.mjs`, whose CLI had not yet been built. After building it,
  that file passes 11/12; its remaining symlink-conflict case exceeds the CLI's
  five-second wait under load, then passes alone (4.05 s), as does baseline
  (4.85 s). Across the requested node checks and these reruns, 193/194 pass.
- `bunx vitest run packages/core/src/derived-limits.test.ts`: pass; no retired
  aggregate or line-limit literals reintroduced. `git diff --check`: pass.
- Shape, diff and documentation review: no outstanding findings. An independent
  `codex exec --sandbox read-only review --uncommitted` attempt returned
  `turn.failed` (selected model at capacity); it supplied no review verdict.

Two deterministic failures are outside slice 10 and remain unchanged:

- `package-version-6.mjs`, source-index package: both this checkout and a separately
  built `b7fc5843` service/native helper fail with
  `Missing transitive project dependency`; the other four legacy packages pass.
- `capture-source-lifetime.test.ts`, public discard: expects
  `PREREQUISITE_MISSING`, receives `NOT_READY` at the final `acquisition.get`.
  It passes at `b7fc5843`. Slice 10 still has the old error; slice 11 commit
  `d9e2f7e32` explicitly changed `AcquisitionStore.decode` to `NOT_READY`.

Contract/verification recheck: production parsers, derived budgets, take clock,
maximum-duration stop, historical schemas and selected-capture semantics are
unchanged. Their retained [slice-10 evidence](../assets/probes/slice10-verification.md)
still applies; the expensive twelve-hour probes and native media tests were not
repeated for a fixture-only correction. No repository-wide suite was run.
