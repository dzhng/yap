# Choices ledger (final)

Every decision made during implementation where the spec was silent, checked against the
shipped code. Decisions the user made are in the [README](README.md), not here. Grouped by
verdict, least confident first.

## Yours to decide (taste or copy; reversible)

- **Ink look.** #ff3b30; 5 pt strokes and 32 pt pins, each with a white edge and a soft
  shadow so they hold on red, busy or light content; a stroke fades over 1.2 s after ⇧ is
  released, strokes visible together fade together; pins stay until undone or the take ends.
  Two unprimed critiques shaped it ([shots](assets/ink/README.md)).
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
- **Paste posts the physical V key with Command only.** Layouts that move V may not paste.
- **Displays are fixed at take start**: a display connected mid-take gets no ink panel.
- **`shortcuts.json` and `shortcuts.set` store modifiers as the Carbon mask** (⌥⇧ = 2560); the
  label carries the human form. Fine for one platform; revisit if the CLI wants portable names.
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
- The recognizer owns no undo state; undo appends a retraction for the latest live mark of any
  kind, and pin numbers only count up, so badges and prompt numbers match after an undo.
- Mark points keep global points and natively projected pixels like cursor samples, through
  the one `CursorTrack.projection`; points outside the picture store null.
- The live window lookup uses the CoreGraphics window list, layer 0, Yap's processes removed;
  windows share the journal's `JournalMarkWindow` shape.
- `CaptureSourceRead.marks()` is the one reader of marks, retractions applied, answering in
  asset time from one capture-to-asset conversion.
- The capture side publishes one ordered mark stream (live stroke, committed, retracted); the
  ink overlay classifies nothing and is hidden from every capture.
- The capture-exclusion test skips with a reason when the display is asleep: black frames
  passed even with the ink deliberately leaked.

Index
- One selection-policy bump per index (source v3, project v4); old generations are reclaimed even
  when referenced, current ones stay protected; package import drops other-policy records.
- One `CoverageTracker` owns the last chosen picture, travel since it and picture change for
  both indexes; every chosen picture counts.
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
  finished by Claude subagents under the same contract and review.
- Fixtures and spec evidence came from the shared local LFS cache; a pre-existing lint error on
  `main` (`blend-public.mjs`) was fixed.
