# 05 Ink overlay

**Contract unlocked:** the person sees what they draw and pin, and the recording never does.

**Seam:** a full-screen `OverlayPanel` per display (`apps/macos/Sources/Yap/OverlayPanel.swift`,
`sharingType = .none`), `ignoresMouseEvents = true`, as proven in slice 00. It consumes only the
recognizer's output stream: strokes, numbered pin badges, retractions. It classifies nothing.

**Slice variable:** the look of ink and pins only. Judge on crops of a stroke, a pin badge and
a stroke fading; the control panel, Settings and the prompt are out of scope here.

**Defaults to confirm with the user (non-blocking):** ink colour (Scrawl `#ff3b30`), fade after
⇧ release (Scrawl fades on release; a stroke drawn while another is still visible fades with
it), pin badge shape and number legibility on light and dark content.

**Human can see:** `apps/macos/tests/recording-overlay-shots.mjs` with new scenes: a stroke on
a light window, a stroke on a dark window, two pins, an undo.

**Verify:**
- `recording-overlay-sharing.test.mjs` asserts the overlay is excluded from a capture.
- `screenshot-critique` as the last check on every shot.
- `compare-screenshots` against `../assets/scrawl-reference/ink-and-pin-live.jpg` as a
  reference (telemetry plus a less-wrong verdict, not a match test).
- `preview-shots` for the user; wait about five minutes; if silent, decide on the evidence,
  record it here, close the shots and continue.

**Delegated:** stroke rendering technique, fade curve within the confirmed behaviour.
**Out of scope:** any visible issue in the recording controls panel.
