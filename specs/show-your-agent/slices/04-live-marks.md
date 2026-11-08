# 04 Live marks: recorded during a real take

**Contract unlocked:** marks land in real recordings' journals, in time with the picture.

**Seam:** an adapter in the cursor sampler (`helpers/mac/Sources/YapCapture/CursorGeometry.swift:361`)
that adds `NSEvent.modifierFlags` to each 60 Hz reading, a global mouse-down/up monitor feeding
the recognizer's `press`/`release`, and `recordMark` on the capture writer's queue (single
writer, `CaptureJournal.swift:206-223`; a failed write fails the take, `CaptureWriter.swift:158-169`).
Source time comes from the same clock as cursor samples; readings it refuses (paused, before
source zero, `CursorGeometry.swift:256-260`) produce no marks. Camera-only takes run no
recognizer (`CameraCaptureInput.swift:159`). Restart and cancel discard marks with the take
directory (`apps/service/src/capture.ts:159-188,480-482`); the recognizer's pin counter resets
per recording.

Rewrite the sampler's privacy comment (`CursorGeometry.swift:139,144,352`): "modifier state and
clicks only, never keys" (P2).

**Human can run:** a real take through `CaptureProbe`: draw with ⇧, ⇧+click twice, click
plainly, pause and draw (nothing), resume; then `yap timeline.events` shows the marks with
windows.

**Verify:** extend `helpers/mac/Tests/YapCaptureTests/CursorGeometryTests.swift` with a
replayed reading stream producing journal marks; one real-recording probe proving journal plus
publication end to end (an expensive run: do it once, reuse its recording in slices 11 and 12).

**Delegated:** where the adapter lives inside the sampler.
**Must stay green:** cursor sampling, publication, recovery.
**Firewall:** no drawing (slice 05), no hotkeys (slice 08).
