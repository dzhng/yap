# 08 Start routing and in-take keys

**Contract unlocked:** D10, L6, D11 and the in-take keys.

**Seam:** `ControlsState.start(origin: .menu | .hotkey(pointer: CGPoint))`.
- `.hotkey` resolves pointer → the `NSScreen` whose frame holds it (nearest on an edge) →
  `captureDisplayID` → `{kind: "display", displayId}` (`CaptureDisplays.swift:9-12`,
  `apps/service/src/capture.ts:14`). Camera, mic and system audio come from the menu. The
  origin survives the start replay (`ControlsState` `beginStart`, 586-605) and places the
  countdown when it is on.
- Restart reuses the take's own source (L6), not the menu's (`RecordingControls.swift:461`).
- `⌥⇧Z` appends a retracting mark (P1) through the slice 04 path; `⌥⇧X` cancels a take or
  abandons a countdown; `⌥⇧P` pauses/resumes. Z, X, P, R are held only while a take or
  countdown is live (`GlobalShortcuts.hold()`, `:55-58`).
- A second `⌥⇧S` within 0.4 s of a start is ignored (P7).
- Countdown default off: `Preferences.swift:92` `?? true` → `?? false`.
- Add a note to `specs/done/recording-for-ai/choices.md:2326` that D10 overrides it.

**Verify:** a `YapControls` test with injected displays (pointer on display B while the menu
says A starts B; menu Start still uses A; restart of a hotkey take uses B). Fixture mode
refuses display sources (`CaptureController.swift:337-343`), so test resolution, not capture.
Countdown tests: `SettingsTests.swift:46-48` flips; `recording-overlays.test.mjs:73-133` and
`countdown-display.test.mjs` set the preference explicitly instead of relying on the default.

**Delegated:** the edge-of-display tie break.
**Depends on:** 06 (bindings), 04 (undo path).
