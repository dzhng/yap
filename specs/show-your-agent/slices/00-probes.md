# 00 Probes: input without permission, overlay out of the capture

**Contract unlocked:** go or no-go on D7 and on the ink overlay. Nothing else in the ladder is
built until both answers are known.

**Questions, one verdict each:**

1. With no Input Monitoring and no Accessibility granted to the probe, does polling
   `NSEvent.modifierFlags` report ⇧ held and released while another app is frontmost, and does
   `NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .leftMouseUp])` deliver clicks
   made in another app? The app already uses a global monitor (`apps/macos/Sources/Yap/CapturePopover.swift:85`)
   and polls `NSEvent.mouseLocation`/`pressedMouseButtons` (`helpers/mac/Sources/YapCapture/CursorGeometry.swift:401-404,434`).
2. Does a full-screen, click-through panel (`OverlayPanel` with `sharingType = .none`,
   `ignoresMouseEvents = true`, as the floating controls are) stay out of a real
   ScreenCaptureKit display recording, and do clicks reach the app underneath?

**Seam:** a throwaway probe subcommand on the existing `ControlsProbe`/`CaptureProbe` harness,
no product code. It logs JSONL (`{t, shift, otherModifiers, mouseDown}`), draws a solid red
square in the overlay, records about 3 s of the display, and extracts one frame.

**Human can run:** the probe on the real Mac (Darwin 27); read the JSONL; look at the frame
(no red square) and confirm a click through the square landed in the app behind it.

**Verify:**
- Record both verdicts, the macOS build, the TCC state (`tccutil`-free: read what System
  Settings shows for the probe) and the frame in `../assets/probes/` with a short README.
- `screenshot-critique` on the extracted frame (it must show no overlay); `compare-screenshots`
  against a frame of the same display without the overlay.

**If either fails:** stop. Report to the user with the evidence and the options (an event tap
with Input Monitoring for 1; a different exclusion route for 2). Do not start slice 01.

**Delegated:** probe harness shape, window placement.
**Must stay green:** `apps/macos/tests/recording-overlay-sharing.test.mjs`, `capture-exclusion.test.mjs`.
**Firewall:** no journal, shortcut or index change.
**Feedback that changes this slice:** the user preferring Scrawl's event-tap route regardless.
