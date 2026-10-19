# Slice 00 probe evidence (2026-10-18, macOS 27.0.1, build 26A434)

## 1. ⇧ and clicks without a permission: pass

`src/main.swift` is a standalone app (`dev.yap.input-probe`, ad-hoc signed, launched with `open`
so it has its own privacy identity and no grants). It polls `NSEvent.modifierFlags` at 60 Hz
and installs a global `.leftMouseDown`/`.leftMouseUp` monitor. `src/poster.swift`, run from a
shell that may post events, sends ⇧ down, a click, ⇧ up and a plain click into
`src/target.swift`'s window, so no other app receives them.

`input-probe.jsonl`: the probe reports `axTrusted: false` and `listenAccess: false` (no
Accessibility, no Input Monitoring), sees ⇧ held and released, and receives both clicks with the
correct ⇧ flag and location.

Limit: the events were synthetic, posted at the HID tap. Real hardware travels the same path;
one manual check with a real keyboard during slice 04's real-take probe confirms it.

## 2. An overlay stays out of a real display take: pass (default path)

`apps/macos/tests/capture-exclusion.test.mjs`, run in the main checkout against its built
`dist/Yap.app` (Screen Recording granted; `CaptureExclusion.swift` and `OverlayPanel.swift`
unchanged since that build). Case "a display take leaves out the floating controls" passed:
the controls' region differed by 0.00 between two takes with the controls in different places,
0.00 across the whole picture. `OverlayPanel` (`sharingType = .none`) plus the app's exclusion
filter keeps Yap's windows out of the take. The ink overlay uses this path and is always hidden
from captures.

Finding, not caused by this feature: the second case, "leaves out the floating controls that
screenshots may see", timed out after 20 s waiting for `recording overlay visible to captures`.
With the opt-in "show controls in screenshots" preference, the take never confirmed its own
windows were excluded. Reproduce on current `main` before slice 05, and fix it there (every
failing check is fixed, pre-existing or not).

## Verdict

Both assumptions hold. Slice 01 may start; D7 stands without an event tap.
