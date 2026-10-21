# Choices ledger (final)

Every decision made during implementation where the spec was silent, checked against the
shipped code. Decisions the user made are in the [README](README.md), not here. Grouped by
verdict, least confident first.

## Yours to decide (taste or copy; reversible)

- **Ink look.** #ff3b30; 5 pt strokes and 32 pt pins, each with a white edge and a soft
  shadow so they hold on red, busy or light content; a stroke fades over 1.2 s after ⇧ is
  released, strokes visible together fade together. Pins first stayed until undone or the take
  ended; on 2026-10-21 the user asked for them to clear on their own, so each pin is gone 5 s
  after it is dropped, fading over its last 1.2 s like a stroke. Only the screen forgets: the
  recording keeps every mark. Two unprimed critiques shaped the look
  ([shots](assets/ink/README.md)).
- **Settings shortcut look.** Two groups, "Shortcuts" and "While Recording", so the lifetime
  is stated once; a row warns only when macOS refused its key or another action uses it, with
  an orange field border ([shots](assets/settings/README.md)).
- **Paste notice.** "Copied, press ⌘V" in a capsule, 2 s then a short fade, low on the display
  under the pointer; a new copy restarts it. Offscreen, the light notice's text renders dimmer
  than intended (material vibrancy); check it on a real screen.
- **Accessibility row.** Reads "Optional" with an "Allow…" button when off, never a warning, and
  its text names the action ("Lets Paste Prompt paste for you; without it, it copies") so it
  stays right after a rebind.
- **A refused shortcut is named by its action** in the capture notice ("The Undo Mark shortcut
  was refused by macOS."), since Settings shows the key beside each action.
- **Prompt wording beyond the approved lines** (camera identity, system audio, voice only,
  marks without a window, clicks): listed in [slice 12](slices/12-prompt-operation.md). Marks
  are listed when there are any and clicks only when there are none, so the approved
  screen+mic+marks text stays exact; the click line shows the first two times then "…".
- **"display N" in the prompt is the capture's display ID**, the number the CLI uses, not a
  friendly "display 1".

## Provisional (sound now; revisit if the situation named changes)

- **Automatic transcript retries stop after three**, then the row leaves; a failure that keeps
  coming back is the caller's to retry. Terminal failures leave at once, so the prompt claims
  no transcript for them (P5).
- **A failed `recording.prompt` from ⌥⇧V reports where the menu shows failures**, not in the
  paste notice.
- **A take the person finishes copies its prompt on its own** (asked for by the user on
  2026-10-21), with the "Copied, press ⌘V" notice. It waits for the take to settle complete, so
  the prompt carries the duration and marks; only a take stopped from the app's shortcut, menu
  or floating controls does it. A take an agent stops through the service, one the 12-hour
  limit ends, and an interrupted or discarded take leave the clipboard alone.
- **Paste posts the physical V key with Command only.** Layouts that move V may not paste.
- **Accessibility granted while Yap runs waits for a reopen.** macOS reports the grant at once
  but drops Yap's ⌘V until Yap reopens, so a paste looked done and did nothing (the user hit
  this on 2026-10-21). The paster counts a grant only if Yap was trusted when it opened; until
  then it copies, the notice adds "reopen Yap to auto-paste" and Settings says "Reopen Yap to
  finish". Yap does not relaunch itself: its service ends with it, so a relaunch could cut off a
  take, an export or a transcript, and only the update installer knows how to wait for quiet.
- **Displays are fixed at take start**: a display connected mid-take gets no ink panel.
- **Ink drawn in the instant before a start answers can still be lost** if a status read from
  before the start renders in between; the window is the service round trip.
- **On a retimed clip, travel since a choice reported late is mapped at a fixed offset**, so it
  can be off by up to one observation step.
- **A shortcuts file with one bad entry is refused whole at launch**, with the defaults
  registered and the reason in the menu; the next `shortcuts.set` writes over it.
- **`shortcuts.json` stores modifiers as the Carbon mask** (⌥⇧ = 2560); the label carries the
  human form. Revisited after 0.1.64: `shortcuts.set` takes key names (`ctrl+cmd+r`) and both
  shortcut operations answer them, because an agent could not be expected to know macOS key
  numbering. The file keeps its shape so existing bindings survive.
- **The travel threshold is the picture's long edge in pixels** (`pictureLongEdgePx`), not a
  display width; portrait captures use their height.
- **`timeline.events` reads a take's marks into memory per request.** Marks per take are few.
- **The transcript backlog table changed shape without a migration** (no release carried it);
  a development catalog from before the closeout needs its `transcript_backlog` table dropped.

## Sound

Capture and marks
- Every primary (screen or camera) take writes journal schema 3; one `CaptureJournal.isPacked`
  / `packedSchema` owns which schemas are packed, on both sides.
- Clicks come from a global mouse monitor, ⇧ and the pointer from the 60 Hz sampler (slice 00
  probe), and a press's own ⇧ flag decides pin versus click.
- Undo clears the screen (P1): capture's ink lifetimes clear the most recent stroke or pin
  still on screen and journal when it left; with nothing on screen undo does nothing. Pin
  numbers only count up, so badges and prompt numbers always match. Undo first took the latest
  mark of any kind, clicks included, so on the user's origin take every ⌥⇧Z after a pin took
  back an unseen click and the pin stayed. Once pins cleared on their own, the user asked that
  an undo skip what already cleared.
- The on-screen window (P8) is an optional `onScreen` field on schema-4 marks, with no schema
  bump: older readers ignore it, and a mark without one is a mark from before it existed. The
  window is in host time and the reader places it as an offset from the mark, so a pause
  inside a mark's few seconds can leave it listed as shown a little longer than the recording
  shows it.
- One owner of the ink's look, `YapInk`, draws it live and in review frames. The frame is
  drawn at source pixels per screen point from the frame's geometry, and only marks of the
  frame's own geometry epoch are placed, as with the pointer trail.
- Mark points keep global points and natively projected pixels like cursor samples, through
  the one `CursorTrack.projection`; points outside the picture store null.
- The live window lookup uses the CoreGraphics window list, layer 0, Yap's processes removed;
  windows share the journal's `JournalMarkWindow` shape.
- `CaptureSourceRead.marks()` is the one reader of marks, answering every recorded mark in
  asset time from one capture-to-asset conversion; an undo row only shortens how long the mark it
  names was shown.
- The capture side publishes one ordered mark stream (live stroke, committed); the
  ink overlay classifies nothing and is hidden from every capture by its unshared panels alone
  (`main` removed the mid-take window exclusion in v0.1.61).
- The ink is up from the moment a start answers that its take is live (`ControlsState.showsInk`),
  not only once a status read says so, and keeps marks that arrive before its panels open; once
  the device has reported the take, the device alone decides, so a stopped take's ink comes down
  while it finalizes.
- The capture-exclusion test skips with a reason when the display is asleep: black frames
  passed even with the ink deliberately leaked.

Index
- One selection-policy bump per index (source v3, project v4); old generations are reclaimed even
  when referenced, current ones stay protected; package import drops other-policy records.
- One `CoverageTracker` owns the last chosen picture, travel since it and picture change for
  both indexes; every chosen picture counts, and travel since a choice is measured from the
  choice's own time, even when it is reported after the scan passed it.
- Index evidence asks the capture reader for the bare selection; a whole index identity is
  refused by the strict parser.

Jobs and transcripts
- Background jobs never block updates and sit outside the interactive limits (bound 256);
  an interactive request joins and promotes an identical background job.
- The `priority` column arrives by `ALTER TABLE ADD COLUMN`, following an existing pattern.
- The backlog is presence-only, handles each row on its own, ends a pass quietly when the
  background queue is full, and is woken by a `wake()` that never rejects.
- `startProjectService` transcribes automatically only with `autoTranscribe`; the installed
  service turns it on (`YAP_AUTO_TRANSCRIBE=0` opts out), like `autoPrepareModels`.

Prompt
- `recording.prompt` takes exactly one of `{recordingId?}`, `{projectId}`, `{assetId}`;
  projects and imported videos keep their one-line handoff through it.
- A take that has not published is refused with the retryable `NOT_READY`, never swapped for an
  older take; the duration is the bound stream's, on the marks' clock.
- Copy prompt is disabled while the service is down; `Paster` is the one owner of copying.

Shortcuts and controls
- `ShortcutBindings.catalog` is the one ordered list of action, name and default; physical key
  code plus modifiers is the identity; refusals are reported by action id.
- `shortcuts.set` merges into the current bindings and refuses any invalid entry; the file uses
  the same rule; a duplicate at launch registers the defaults and reports it.
- Live registrations release only what `apply` made, so a countdown's Escape hold survives.
- A hotkey start resolves the display under the pointer (containing frame, then catalog order);
  restart reuses the source of the take it started, keyed to that take.
- A second ⌥⇧S within 0.4 s of a hotkey start is ignored, including the press that would stop.

Process
- Codex hit "model at capacity" repeatedly; slices 05, 12 and 13 and the review fixes were
  finished by Claude subagents under the same contract and review. The final review ran both a
  Claude and a Codex pass; Codex found the paused undo, early ink and coverage travel bugs.
- Fixtures and spec evidence came from the shared local LFS cache; a pre-existing lint error on
  `main` (`blend-public.mjs`) was fixed.
