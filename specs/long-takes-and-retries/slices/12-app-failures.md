# 12 — App failures carry their action

Depends on: 06, 11.

## Contract

- A Library recording row whose import failed reads "Couldn't import your <time> recording:
  <cause>. Your recording is safe." with **Retry**, which calls `job.retry` for that source's
  job. Play and Copy prompt stay enabled. A camera publication that is "unavailable" because the
  camera was never on is not a failure.
- The capture-panel Retry wired to Start/Stop (`RecordingControls.swift:1210`) is gone.
- Every other error the app shows follows the app rows of `error-verdicts.md`: Retry (re-running
  the exact request it came from), the fix action, prevented by enabling/disabling an existing
  control, or plain status text. No new relaunch action. Don't over-engineer: a row that needs
  new machinery becomes status text.
- A failure stays until its own action resolves it or the user dismisses its surface; unrelated
  clicks and background reads don't erase it. A start Retry reuses `beginStart`/`finishStart`
  (`ControlsState.swift:645-686`); a paste failure offers Copy.
- Errors read in plain words (the ledger `cause`), not `CODE: message`.

## Seam

- `apps/macos/Sources/YapControls/LibraryState.swift` (~56-67): the job type decodes `errorCode`,
  `retryable` and `details`.
- `LibraryPresentation.swift` (~28-57): failed-import status and a `.retryImport(jobId)` action;
  status derivation (~49) reads the primary admission's job.
- `LibraryController.swift` (~255-287): runs `job.retry`, refreshes the row.
- `ControlsState.swift` (~49): `failure: String?` becomes one scoped value carrying message and
  action; `CapturePresentation.swift` (~71-85) and `CaptureView.swift` (~333-366) render it with
  its button; `RecordingControls.swift` (~438) stops clearing it on unrelated actions.
- Library-triggered failures show in the Library (`LibraryView.swift:197`), not the capture panel.

## Run or see

Offscreen shots via `apps/macos/tests/library-view-shots.mjs` and `capture-view-shots.mjs`:
failed import, retrying, recovered; a capture-panel failure with its action.

## Verification (red first)

- `apps/macos/tests/library-controls.test.mjs`: a failed import row shows Retry, calls `job.retry`
  with that admission's job id, then reads ready. Service faked only at the socket.
- `YapControlsTests`: no Retry appears after a failed playback or prompt copy; failures survive
  an unrelated toggle.
- Visual: `screenshot-critique` on the new shots as the last check, `compare-screenshots`
  before vs after, then `preview-shots`.

## Delegated

Spacing and label wording within the contract.

## Review

Checkpoint H3: row and panel shots, non-blocking.

## Stays green

Retry Delete, Retry Export/Cleanup, Retry Preview, Retry Finalization, selection handling,
focus-free tests.
