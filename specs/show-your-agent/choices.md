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
