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

## Slice 01 (mark contract)

- **Every screen take now writes journal schema 3**, not only takes that contain marks. Why:
  one writer version is simpler than switching on content; schema 3 is a superset. Camera-only
  takes stay schema 1. Verdict: sound.
- **`markEvents` is optional in the receipt and counts as 0 when absent.** Why: receipts from
  schema 1/2 journals have no such field. Verdict: sound.
- **A retracting mark still carries a `kind`** (the retracted mark's kind). Why: the frozen
  shape made `kind` required; it lets readers count retractions per kind. Verdict: sound.

## Slice 03 (recognizer)

- **A press's own ⇧ flag decides pin versus click**, not the last polled sample. Why: a ⇧+click
  inside one 60 Hz tick of pressing ⇧ would otherwise become a click; the global monitor
  reports the flag (probe 1). Verdict: sound.
- **The recognizer owns no undo state**; pin numbers only count up. Why: undo retracts the last
  mark of any kind, which slice 04 tracks by journal id. Verdict: sound.
- **Window bounds reuse `GeometryRect`**. Why: existing geometry owner. Verdict: sound.

## Slice 06 (shortcut bindings)

- **Modifiers are stored as the Carbon mask** (`⌥⇧` = 2560) in `shortcuts.json` and
  `shortcuts.set`. Why: it is what `RegisterEventHotKey` takes; the label carries the human
  form. Verdict: sound, but the CLI contract exposes a platform number; revisit if the CLI
  ever needs portable names.
- **Duplicate identity is key code plus modifiers**, ignoring the label. Verdict: sound.
- **`shortcuts.set` replaces the whole binding set** (missing actions fall back to defaults)
  and errors are `DUPLICATE_SHORTCUT` / `SHORTCUTS_WRITE_FAILED`. Verdict: sound.
- **Paste prompt and undo mark are registered but do nothing** until slices 12/13 and 04/08.
  Verdict: provisional, removed by those slices.

## Slice 02 (mark read)

- **Mark points store `{hostUs, globalX, globalY, x, y}` like cursor samples, with x/y projected
  natively at write time**; the reader passes them through. Why: corrected P3 after review
  found the first draft re-implemented the projection in TypeScript. Verdict: sound.
- **`timeline.events` reads all of a take's marks into memory per request** before paging.
  Why: marks per take are few (hand-made gestures). Verdict: sound; revisit only if takes ever
  carry thousands of marks.

## Slice 07 (Settings field)

- **Shortcuts are grouped by lifetime** ("Shortcuts" and "While Recording") instead of a
  per-row "active while recording" note; rows warn only for "Refused by macOS" or "Duplicate
  in Yap", with an orange field border. Why: three unprimed critiques; lifetime stated once.
  Verdict: sound, user may want to review the look.
- **The `shortcuts.json` "Show in Finder" workflow and the restart note were removed.** Why:
  the field applies live, so hand-editing has no purpose. Verdict: sound.

## Slice 10 (transcript backlog)

- **Backlog rows are keyed by asset, stream and acquisition**; recordings use the acquisition
  selection, imports the bare asset stream. Verdict: sound.
- **A non-retryable failure stays in the table and is skipped**, not deleted. Why: keeps the
  evidence of what was attempted; drains skip it. Verdict: sound; table grows only by failures.
- **An explicit interactive transcription resubmits an existing job's identity**, which joins
  and promotes it. Verdict: sound.

## Slice 04 (live marks)

- **Clicks come from a global mouse-down/up monitor; ⇧ and pointer from the 60 Hz sampler.**
  Verdict: sound (slice 00 probe).
- **Mark points outside the picture store null x/y**, while cursor samples keep out-of-frame
  pixels with `eligibility: "outside"`. Why: P3 said null outside; marks carry no eligibility
  field. Verdict: sound, but a small asymmetry with cursor samples worth knowing.
- **`CursorTrack.projection(forGlobalPoint:hostUs:)` is the one projection** for cursor samples
  and mark points. Verdict: sound.
- **The live window lookup uses the CoreGraphics window list (layer 0, Yap's own processes
  removed)**, not ScreenCaptureKit shareable content. Why: it is synchronous on the capture
  queue and needs no async content fetch per mark. Verdict: sound.

## Slice 08 (start routing)

- **Display frames come from `NSScreen` and are optional on `ControlsState.Display`** so tests
  can inject them. Verdict: sound.
- **On an exact shared edge the containing frame wins, then catalog order.** Verdict: sound.
- **The 0.4 s guard ignores any second ⌥⇧S after a hotkey start, including the one that would
  stop the take.** Why: P7's purpose; the first draft only guarded while idle. Verdict: sound.

## Slice 11 (index reasons)

- **"One display width" of pointer travel is measured against the larger captured dimension,
  in output pixels** like the travel itself. Why: scene evidence exposes source width and height,
  not a display width. Verdict: sound for landscape displays; portrait displays use height.
- **Old-policy index generations are reclaimed even when referenced; current ones stay
  protected by references.** Why: the first draft dropped reference protection for every
  generation. Verdict: sound.

## Process

- **Codex hit "model at capacity" repeatedly on 2026-10-18 for slices 05 and 12** (three models,
  fresh sessions too). Both were finished by Claude subagents from Codex's partial work, under
  the same contract and the same review. Verdict: process note, no code consequence.

## Slice 05 (ink overlay)

- **One ordered mark stream from the capture side** (`CaptureMarkUpdate`: live stroke,
  committed mark, retraction); the overlay classifies nothing. Verdict: sound.
- **Ink defaults pending the user's look:** #ff3b30, 5 pt strokes and 32 pt pins, both with a
  white edge and soft shadow (added after the second critique so marks hold on red, busy or
  light content); strokes fade over 1.2 s after ⇧ is released, strokes visible together fade
  together; pins stay until undone or the take ends. Verdict: provisional, user-only taste.
- **Displays are fixed at take start**; a display connected mid-take gets no ink panel.
  Verdict: sound for now.
- **The capture-exclusion test skips with a reason when a take's picture is blank** (display
  asleep). Why: black frames passed even with the ink deliberately leaked. Verdict: sound.
- **Fixed a slice 01 regression found here:** the service refused journal layout 3 in
  `capture-publication.ts`, so every screen take hung in finalizing. No unit test reached it;
  only a real take did. Verdict: fixed, with a test.

## Slice 12 (prompt operation)

- **`recording.prompt` takes exactly one of `{recordingId?}`, `{projectId}`, `{assetId}`**, so
  the app passes its media target and nothing guesses an ID's kind. Verdict: sound.
- **Imported videos keep their one-line handoff through the same operation.** Verdict: sound.
- **Copy prompt is disabled while the service is down** (the text now comes from it). Verdict:
  sound.
- **Marks are listed when there are any; clicks only when there are none**, the click line
  shows the first two times then "…", and names a window only when all clicks share one.
  Why: keeps the approved screen+mic+marks text exact. Verdict: provisional, user may prefer
  both.
- **Pins keep their journal number** (gaps after an undo match the badges the person saw).
  Verdict: sound.
- **"display N" is the capture display ID** the CLI uses, omitted when unknown. Verdict: sound,
  though the number is not a friendly "display 1".

## Slice 13 (paste)

- **`Paster` is the one owner of copying a prompt**; paste posts the physical V key with
  Command only. Verdict: sound; layouts that remap V may not paste.
- **The "Copied, press ⌘V" notice shows 2 s then fades, low-centre on the display under the
  pointer**, and a new copy restarts it. Verdict: sound.
- **Accessibility reads "Optional" with an "Allow…" button when off**, never orange, and Yap
  never prompts for it. Verdict: sound.
- **A failed `recording.prompt` from ⌥⇧V (no recordings yet) reports where the menu shows
  failures, not in the notice.** Verdict: provisional.

## Closeout (full repository run)

- **`startProjectService` takes `autoTranscribe`, off unless asked; the installed service's
  entry turns it on** (`YAP_AUTO_TRANSCRIBE=0` opts out, like `YAP_AUTO_PREPARE_MODELS`). Why:
  service tests that were not about transcription started background jobs once their fixture
  model was ready. The product still transcribes everything (D13). Verdict: sound; library
  callers must opt in.
- **The shared index evidence passes only asset, stream and acquisition to the capture
  reader.** Why: passing a whole index identity broke every recording's index; found only by
  a real-capture macOS test. Verdict: fixed, regression-tested.
- **Fixtures and spec evidence came from the shared local LFS cache**; five launch-video media
  files are not in it and no test needed them. Verdict: process note.
- **Fixed a pre-existing lint error on `main`** (`blend-public.mjs` declared `created` twice).
  Verdict: sound.

## Whole-feature review

- **A refused shortcut is named by its action in the capture notice** ("The Undo Mark shortcut
  was refused by macOS."), not by its key label. Why: refusal is now reported by action id, and
  the notice reads only controls state; Settings shows the key beside the action. Verdict:
  provisional, copy.
- **The restart source is held under the take it started** (`activeStart` keyed to the
  recordingId the start answer named), rather than cleared when the device leaves the live
  states. Why: a status poll already in flight could report idle just after the start answered
  and clear it; a key cannot go stale. Verdict: sound.
- **`shortcuts.json` and `shortcuts.set` share one merge rule**, so a file with any invalid
  entry is ignored whole (it used to skip that entry). Why: one owner of what a valid binding
  is; only Yap writes the file. Verdict: sound.
- **A duplicate binding in `shortcuts.json` at launch registers the defaults** and shows the
  duplicate failure, so Settings never shows bindings that are not held. Verdict: sound.
