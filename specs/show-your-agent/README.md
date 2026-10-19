# Show your agent

Yap's original use case, made one keystroke away: press `⌥⇧S`, talk, draw and pin on the
screen, press `⌥⇧S` again, and `⌥⇧V` pastes a short prompt into your agent. The agent explores
the recording with the yap CLI and skill. Modelled on Kit Langton's
[Scrawl](https://github.com/kitlangton/scrawl) (MIT); Yap copies its behaviour, not its code,
and leaves out its iPhone `M` key. Reference stills are in
[assets/scrawl-reference](assets/scrawl-reference/README.md).

## Next Agent Prompt

*Status, 2026-10-18:* slice 00 passed (both probes). Messaging copy is on `main` and live;
the images still show the old tagline. Next: slices 01, 06 and 09 in parallel.

You are picking this feature up. Read this README, then the next open slice. Slice 00 proved the two assumptions
the ladder rests on ([evidence](assets/probes/README.md)). Work slices in the order of the
graph below; independent tracks may run in parallel in separate checkouts (AGENTS.md: never
share build output between checkouts whose sources differ). For every slice: invoke
`write-tests` first, run only that slice's narrow checks, and for any visual shot run
`screenshot-critique` last, `compare-screenshots` when a target exists, and show the user with
`preview-shots` (non-blocking, see "Review checkpoints"). Run the full repository check once,
in [slice 15](slices/15-closeout.md). Update this section, including the TODO list, before you
end your pass.

Global TODO (each item is owned by its slice):

- [x] 00 Probes: both pass ([evidence](assets/probes/README.md))
- [ ] 01 Journal schema 3 `mark` contract, Swift and TS, golden fixture
- [ ] 02 Marks readable through `timeline.events`
- [ ] 03 `MarkRecognizer`: the Q6 gesture rules, pure
- [ ] 04 Live marks recorded during a take
- [ ] 05 Ink overlay (visual: colour, fade, pin badges)
- [ ] 06 Shortcut bindings model, live registration, `shortcuts.get`/`shortcuts.set`
- [ ] 07 Settings click-to-record field (visual)
- [ ] 08 Start routing: display under pointer, restart on take source, countdown off, in-take keys
- [ ] 09 Background job priority
- [ ] 10 Transcript backlog: automatic transcription of recordings and imports
- [ ] 11 Index: mark/pin/click reasons and stricter coverage, one policy bump
- [ ] 12 `recording.prompt` operation; replaces Copy agent prompt
- [ ] 13 `⌥⇧V` paste with optional Accessibility (visual: notice)
- [ ] 14 Skill, DEVELOPMENT.md, catalog, release notes
- [ ] M  Messaging: copy done on this branch; regenerate `header.png`, `og.png`, `launch-poster.jpg`
- [ ] 15 Closeout: full run, D18 timing, fresh-agent acceptance

Warnings: ad-hoc-signed dev builds lose Accessibility trust on every rebuild (test slice 13's
paste path on a signed build). Fixture capture mode refuses display sources
(`CaptureController.swift:337-343`), so slice 08 tests source resolution, not capture.

## Slice graph

```
00 probes ─┬─► 01 mark contract ─┬─► 02 mark read ──────────────┬─► 11 index reasons + coverage
           │                     └─► 03 recognizer ─► 04 live marks ─► 05 ink overlay
           │                                                    │
06 bindings ┬─► 07 settings field                               │
            └─► 08 start routing (needs 04 for undo) ────────────┤
09 priority ─► 10 transcript backlog ───────────────────────────┼─► 12 prompt op ─► 13 paste
                                                                 └─► 14 docs ─► 15 closeout
M messaging (copy done; images) ─────────────────────────────────────────────► 15 closeout
```

Tracks that can run in parallel: marks (00→05), shortcuts (06→08), jobs (09→10), messaging (M).
11 needs 02. 12 needs 02 and 10. 13 needs 06 and 12. 14 needs everything it documents.

## Decisions (settled with the user; carry verbatim)

Closed during an explore-unknowns walk on 2026-10-18. Every one was answered by the user, not
delegated.

| # | Decision | Why |
|---|---|---|
| D1 | One recorder. Marks work during every recording; the handoff works on any recording. | One owner per concept; every recording stays editable. |
| D2/D3′ | `⌥⇧V` pastes a **text prompt only**. It describes what was captured and nothing else: opener, recording ID (duration, display or camera), captured contents (screen, camera, mic, system audio), then marks/pins or clicks with time and window. It names no operations and gives no "start here" guidance. Approved sample lines are in [slice 12](slices/12-prompt-operation.md). | The agent pulls frames itself; the yap skill owns how to explore, so the paste stays short and the skill can improve without changing it. The user cut every "start with operation X" line from the draft. |
| D4 | Settings gets a click-to-record hotkey field for every action, applied live. Rebinding is also a public operation. | User request; CLI parity rule. |
| D5 | Marks, pins and clicks become new selection reasons in the existing screenshot index (`index.get`). No second frame picker. | The index already records a typed reason per frame. |
| D6 | Defaults `⌥⇧S` start/finish, `⌥⇧V` paste, `⌥⇧Z` undo last mark, `⌥⇧X` cancel, `⌥⇧P` pause, `⌥⇧R` restart. S and V claimed for the app's lifetime; Z, X, P, R held only while recording. | One modifier family; keys that matter only while recording don't take characters away otherwise. |
| D7 | No new required permission. ⇧ state and pointer by polling; clicks from a global mouse-down monitor. ⇧+click passes through to the app on purpose. | User: a click rarely matters, the user understands it, and sometimes wants it to show a transition. |
| D8 | `⌥⇧V` posts ⌘V if Accessibility is granted (optional); otherwise it copies and shows "Copied, press ⌘V". | "Paste should just paste" without a permission wall on first run. |
| Q3 | Each mark stores source time, kind (stroke, pin with number, click), points, geometry epoch, and the window under it (app, title, bounds). Yap never crops. | The prompt can say "pin #2 at 0:34 on Safari, 'Deploys'"; cropping is the agent's call. |
| Q6 | Stroke: ⇧ held **alone** plus at least 8 pt of travel, no button down. Pin: a button press while ⇧ is held, at the press point; it ends any stroke. A drag with the button down records a click. | Typing a capital letter while the mouse drifts must not draw. ⌥⇧ for a hotkey must never draw. |
| D10 | `⌥⇧S` records the display under the pointer, whatever the menu's source. Camera, mic and system-audio toggles follow the menu. The menu's Start button keeps the menu's source. | The hotkey means "show the agent what's in front of me, now". Overrides `specs/done/recording-for-ai/choices.md:2326`. |
| D11 | Countdown defaults off. Saved preferences are kept. | "Archaic in the age of AI"; the agent can trim the start. |
| D12 | The paste never waits for transcription. | Everything the prompt needs is known when recording stops. |
| D13–D15 | Every recording and every real import is transcribed automatically, each audio stream separately (mic and system audio), as soon as the speech model is ready (immediately if it already is). An empty transcript is fine. Explicit `transcript.transcribe` stays for ranges and context. | The transcript is the first thing every agent reads; "no speech" is a signal too. |
| D16–D18 | The reader is always an agent with Yap installed; everything is local (ID, not path; remote upload later). Done = under 2 s overhead for the whole loop, and the agent acts without a follow-up question. | User answers. |
| D19 | Headline "Just yap. Your agent gets it." with sub-lines Show your agent / Show people. | Brings back the original vision without burying video. |
| D20 | `positioning.md` names Scrawl, CleanShot plus annotating plus dictating, Loom and Descript, and stays public and linked from `llms.txt`. | User: "name them, it's fine". |
| D21 | `coverage` stays, but a coverage frame needs a changed picture **and** either 30 s with no other frame, or about one display width of pointer travel during continuous change (raw screen recordings with pointer evidence). Both source and project indexes. | User: a 20-minute narration over a static page must not produce hundreds of screenshots; keep coverage rather than remove it. |
| L1 | Marks are a `mark` event in capture journal schema 3, changed together across the Swift writer and reader, evidence export, the TS validator and the portable format. | The journal stays the one owner of capture-time evidence. |
| D22 | A persistent "needs a transcript" list in the service, submitted when the model becomes ready, at a new background priority that interactive heavy jobs always jump ahead of, outside the 32-job limits, joining identical explicit requests. | Nothing ever waits on the model, so updates and `transcript.review` keep working. |
| L6 | `⌥⇧R` restarts on the take's own source. | Restart means "redo this take". |
| Compat | Keep reading journal schema 1/2. Old screenshot index generations are deleted on upgrade and rebuilt lazily; importing an old `.yap` drops index records from other policies. Old `shortcuts.json` overrides are ignored. The countdown needs nothing. No other shims or migrations. | Source data can't be regenerated; derived data can. |

Decisions made while synthesizing the plan (record any user correction here):

| # | Decision | Why |
|---|---|---|
| P1 | Undo (`⌥⇧Z`) appends a mark carrying `retracts: <id>`; readers apply it. The journal is never rewritten. | The journal is append-only and single-writer. |
| P2 | Plain clicks are recorded during every screen take (not just while ⇧ is held), as `click` marks. The sampler's privacy note changes from "no key observation" to "modifier state and clicks only, never keys". | The N prompt ("I clicked 6 times…") needs them; it is new evidence, so it is stated. |
| P3 | Marks follow the cursor-sample convention: global points plus geometry epoch, projected to output pixels by the reader, as `cursor.raw` does. | One coordinate convention for pointer evidence. |
| P4 | The prompt operation covers recordings. Projects keep their existing one-line ID handoff, moved behind the same operation so the app has one prompt owner. | `LibraryPresentation.agentPrompt` serves both today. |
| P5 | The prompt says "transcript is being prepared" only when a transcript is actually pending or ready; otherwise it says nothing about transcripts. | The prompt must not promise what the backlog can't deliver (no model, failed job). |
| P6 | Marks are recognized in-process in `YapCapture`, next to the cursor sampler, and appended on the capture writer's queue. No new service control. | `YapCapture` is linked into the app (`apps/macos/Package.swift:19`); the sampler already polls `NSEvent`. |
| P7 | A second `⌥⇧S` within 0.4 s of a start is ignored, so a double press never leaves an empty take (Scrawl's guard). | Otherwise the implementer would invent a debounce. |

## Single owners

| Concept | Owner | Nothing else may |
|---|---|---|
| Mark record shape | Journal schema 3 types in `helpers/mac/Sources/YapCapture/CaptureJournal.swift`, mirrored only by the validator in `packages/core/src/evidence.ts` | define a second mark shape or file |
| Gesture rules (Q6) | `MarkRecognizer` in `YapCapture` | classify marks in the app or overlay |
| Reading marks | core capture-marks reader, exposed through `timeline.events` | read marks from the journal directly |
| Frame selection reasons | `source-index-selection.ts` / `project-index-selection.ts` | pick keyframes elsewhere |
| Prompt text | core prompt facts + renderer behind `recording.prompt` | compose a handoff string (the app only calls) |
| Shortcut bindings | `ShortcutBindings` in `YapControls`; `GlobalShortcuts` registers; Settings and `shortcuts.*` share one handler | keep a second action list (today Settings has its own, `SettingsWindow.swift:459-462`: delete it) |
| Automatic transcription | core transcript backlog | submit transcription jobs on their own |
| Job priority | `jobs.ts` admission | reorder heavy work elsewhere |

Replaced mechanisms are deleted, not kept beside the new one: `LibraryPresentation.agentPrompt`
and `copyAgentPrompt` (slice 12), the version-1 `shortcuts.json` reader (slice 06), the
read-once `SystemShortcuts` cache if live rebinding needs a fresh read (slice 06), the 5-second
project coverage cadence (slice 11). The end state must read as designed today, not as a
feature bolted on.

## Firewalls

- No editorial decisions: Yap never crops, cuts or picks a "best" frame beyond the typed reasons.
- Source media and existing recordings stay byte-for-byte intact.
- No required permission beyond today's Screen Recording, Microphone and Camera.
- Nothing waits on the speech model; nothing blocks app updates.
- No second frame picker, journal, prompt builder or shortcut list.
- iPhone capture is out of scope, and so is Scrawl's hold-`⌥⇧` source picker (D10 settles the source).

## Review checkpoints (non-blocking)

Visual slices (05, 07, 13, M) end with shots opened for the user via `preview-shots`. Wait
about five minutes for a reaction. If none comes, decide on the evidence, record the decision
and why in the slice file, close the opened shots, and continue. A checkpoint is a chance to
correct a reversible call, never a gate. Defaults to confirm at the first visual review: ink
colour (Scrawl uses `#ff3b30`), how ink fades after ⇧ is released, the pin badge look, and the
prompt operation name (`recording.prompt`).

## Known unknowns

- Whether `NSEvent.modifierFlags` polling and a global `.leftMouseDown` monitor work without
  Input Monitoring or Accessibility on Darwin 27 (slice 00).
- Whether `sharingType = .none` plus `excludeOwnWindows()` keeps a full-screen overlay out of a
  ScreenCaptureKit display capture on this macOS (slice 00).
- The pointer-travel and 30 s thresholds in D21 are starting values; tune on one fixture in
  slice 11 without loosening the static-page requirement.

## Superseded artifacts

The explore-unknowns map rendered in the planning conversation (its decision ledger, landmine
cards and kickoff prompt) and the drafting brief are superseded by this folder. Where they
differ, this README and the slice files win.
