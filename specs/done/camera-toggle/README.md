# Camera on and off during a take

A screen take's companion camera can be turned off and back on any number of times, from the
floating take controls, the capture menu, the CLI or MCP. A take can start with the camera off
and turn it on later. Off time is a real gap in the camera source: no picture is held across it,
and a held picture is never certified as recorded.

Two pieces of floating-controls and menu work shipped with it. The camera picture in the
floating controls is its own rounded card that can be minimized while the camera keeps
recording. The capture menu's custom-drawn buttons show a pressed state while held.

The decisions the build made on its own, each judged against the final code, are in the
[choices ledger](choices.md). The original build plan and its slices are in Git before this
record (`63f9f25c`..`33149815`).

## Decisions made by the user

- On and off mid-take, any number of times, leaving gaps in the camera source.
- A screen take started from the app reserves a camera when camera access is granted: the one
  picked in the menu, or the system default, even when the camera switch is off at start.
  Without access it reserves one only if the switch is on, and the start is refused with the
  permission error. The CLI and MCP reserve the camera named in `cameraDeviceId`.
- The device is not opened, and its light stays off, until the camera is turned on.
- No backward compatibility and no migrations, with one exception: recordings that already
  exist, including those saved by release 0.1.33, keep working.
- Camera-only takes are out of scope. There the camera is the primary source, and "off" would
  be a pause.
- "Minimize preview" (hide the picture; the camera keeps recording) and "camera off" (stop
  recording the camera) are different controls. Minimize should look like a window minimize.
- No step waits on a physical camera. Device questions are settled by design and proved with
  fixtures; this Mac lists no camera.

## Contracts

| Concept | Owner | Shape |
|---|---|---|
| Camera availability | The camera receipt (`camera.publication.json`); arithmetic in `CameraAvailability` ([CameraMedia.swift](../../../helpers/mac/Sources/YapCapture/CameraMedia.swift)); TypeScript computes intervals only through `cameraProofIntervals()`; [evidence.ts](../../../packages/core/src/evidence.ts) validates gaps on read | `support` stays the outer span. Optional `gaps: [{startUs, endUs}]`, omitted when empty. Intervals are support minus gaps. |
| Run boundaries | `CameraWriter` (numbering), `CameraFrameMapping` (row form) | Mapping rows carry optional `cameraFrame.run`, omitted when 0. Camera callbacks while off are logged with disposition `camera-off`. The mapping holds camera rows only; readers skip the screen and microphone rows that older mappings, including 0.1.33's, also hold. |
| Toggle operation | [operations.ts](../../../packages/protocol/src/operations.ts) | `capture.setCamera {recordingId, on}` answers like `capture.status`. CLI and MCP get it from the shared operation. |
| Start state | Capture selection ([capture.ts](../../../packages/protocol/src/capture.ts)) | Optional `cameraAtStart: "on" \| "off"`; absent with a camera means on. |
| Live camera state | `NativeCapture.companionCamera`, reported as `capture.status` `device.camera` | `{deviceId, state: "on" \| "off"} \| null`. Never stored in the catalog. |
| Camera off at stop with nothing recorded | Native publication | Camera `unavailable` with `CAMERA_NOT_TURNED_ON`; the take is still `complete`. |
| App action | `ControlsAction.setCamera(Bool)` | One action for the menu switch and the floating camera button. |

The mechanics live with their owners: the [native capture README](../../../helpers/mac/Sources/YapCapture/README.md#camera-off-time-is-a-gap)
for runs, gaps and the session lifecycle, and the [macOS app README](../../../apps/macos/README.md)
for the shared controls.

## Why this shape

**Off time is an explicit empty edit, never a held picture.** A held picture would be certified
as acquisition evidence for time the camera did not record ([agent-editing choices](../agent-editing/choices.md)).
The raw movie stays continuous; only the canonical `video.mov` carries gaps, as empty edits
between passthrough segments. Correcting the raw movie's duration was tried in earlier work and
failed; empty edits keep the occupied pictures exact ([20e1 evidence](../agent-editing/assets/20e1-camera-gap-materialization/README.md)).

**`gaps` is omitted when empty, so old recordings need nothing.** A take whose camera was never
turned off is byte-shaped exactly like a 0.1.33 recording, and a 0.1.33 recording is simply the
one-interval case. There is no migration and no compatibility reader. Readers refuse the
explicit empty forms (`"gaps": []`, `"run": 0`), so each take has one encoding. Replacing
`support` with a list of segments was rejected because every new receipt would change shape.

**One statement of off time.** The mapping's `run` number is written live, so recovery has it,
and it is pinned by the mapping hash. Journal events for on and off were rejected: they would be
a second statement beside the receipt.

**The device is opened only while on.** Each turn-on opens a new session and each turn-off
releases it, so an off camera holds nothing and its light stays off. Keeping one session and
calling start and stop on it was rejected: it opens the device at take start. Opening lazily also
made the "is the format identical across sessions" and "does stopping post an interruption"
questions moot: pictures are compared on a compatible format (size, pixel format, colour tags)
rather than byte-equal descriptions, and each session's loss observers are removed before it
stops. A turn-on can check only size before its session runs; a session turned on mid-take whose
picture is otherwise incompatible ends its own run: that picture is refused and the camera turns
off. Colour tags are never loosened, because mixed tags in one track would play with the wrong
colour.

**One action for the menu and the floating controls.** Both send `ControlsAction.setCamera`.
Before a take it sets the start switch; during one it sends the same `capture.setCamera` the CLI
uses. Both read whether the camera is on from native's live state through one function, so they
cannot disagree. Live state is its own `device.camera` field because `device.selection` is what
the take started with.

**A toggle never touches the take lifecycle.** No report, no lifecycle transition, no catalog
column. A refused or failed toggle answers on that call and leaves the camera off and the take
recording. So does a session a turn-on opened that later delivers an incompatible picture: it
has no call left to answer, so it writes a `camera off:` line on native's stderr instead.

## Invariants

- A held picture never becomes support. Three independent checks hold it: the writer records a
  picture only if it was captured wholly inside an on window; publication's canonical scan
  requires the occupied segments to equal the receipt's intervals exactly; core admission
  requires the probed `available[]` to deep-equal the proof's intervals.
- `CameraAvailability` owns camera interval arithmetic in Swift: merging, support, gaps and the
  gap limit. The raw scan derives each run's acquired range from the mapping (it starts a range
  by `startsInterval`, shared with the canonical scan, and ends it at the last frame's
  acquisition, clipped to the native end); the canonical scan then proves the published movie's
  segments equal those ranges through `CameraAvailability`. TypeScript computes intervals only through `cameraProofIntervals()`;
  `evidence.ts` validates gaps on read. Downstream readers that were already gap-aware (asset
  availability, composition, the renderer) carry no camera special case.
- A take has at most 500 turn-ons and so at most 499 gaps (`CAMERA_TOGGLE_LIMIT`), inside the
  original 64 KiB receipt and 32 KiB normalized-receipt bounds. Swift (`maximumGaps`) and
  TypeScript (`maxCameraGaps`) must change together.
- A toggle never touches the primary clock, the screen stream or the take lifecycle. A failure
  from a toggle, including a failure to release the device, is reported on that toggle. A
  picture from a turned-on session that is incompatible with the take's format ends that run
  and turns the camera off; it is never recorded. Only the release at stop of a camera that is
  on, or a format change by the session whose picture established the take's format, can still
  interrupt the take.
- A camera that is off at stop and recorded nothing publishes `CAMERA_NOT_TURNED_ON` and the take
  completes. `NO_CAMERA` means a camera that was on at stop and never delivered.
- A stop or discard during a turn-on cancels it: the call answers `INVALID_STATE`, its session is
  released, and the camera publishes as if that turn-on was never asked.
- Camera lost while off: the take continues and the next turn-on refuses `SOURCE_UNAVAILABLE`.
  Camera lost while on: the whole take is interrupted, as before this feature.
- Camera-only takes have no switch (`CAMERA_NOT_RESERVED`).
- An unavailable source publication, whatever its code, is settled for the library; a never-used
  camera is not shown as pending or as an error.

### Existing recordings keep working

[`camera-library-preservation.mjs`](https://github.com/dzhng/yap/blob/4b4e708c/packages/test-harness/editing/camera-library-preservation.mjs)
is the standing check. It opens a library on an APFS clone with the code under test, hashes every
original member before and after, and requires each recording to keep its states, admit, re-read
its receipt, and deliver frames rendered by this build. Admission must state exactly the receipt's
own gaps (none for a pre-change take), so the gate also holds for libraries that already contain
toggled takes. Its inputs are the [pre-toggle corpus](assets/pre-toggle-corpus/README.md): two
libraries recorded by the pre-change build, with the [baseline](assets/pre-toggle-corpus/baseline/)
reports and frames of their first run. At the close the gate passed on corpora A and B, with
delivered frames matching the baseline (compared by hand), and on a clone of `~/.yap`, which held
0 recordings. The close-time reports were not kept. Never write to `~/.yap`.

## Where it lives

Native ([helpers/mac/Sources/YapCapture](../../../helpers/mac/Sources/YapCapture/)):
`CameraAvailability` and the scans in `CameraMedia.swift`; the acquisition window, run numbers,
forced key frames and `CameraFormat` in `CameraWriter.swift`; the `CompanionCameraSwitch`
protocol and `CameraClosure` in `CaptureInputSession.swift`, conformed to by `CameraCaptureInput`;
`NativeCapture.setCamera(on:)` and `companionCamera`. Recovery: `MediaRecovery.recoverCamera`
([YapWire/MediaRecovery.swift](../../../helpers/mac/Sources/YapWire/MediaRecovery.swift)).

Service and protocol: `capture.setCamera` in [operations.ts](../../../packages/protocol/src/operations.ts),
`cameraAtStart` and `device.camera` in [capture.ts](../../../packages/protocol/src/capture.ts),
the service's `setCamera` in [apps/service/src/capture.ts](../../../apps/service/src/capture.ts).
Core admission compares proof intervals in `AcquisitionImporter` ([acquisitions.ts](../../../packages/core/src/acquisitions.ts)).

App ([apps/macos/Sources](../../../apps/macos/Sources/)): `ControlsAction.setCamera` and
`ControlsState.setCamera`/`start()` in `YapControls`; `RecordingOverlay.camera(for:)` as the one
live-state reader; `RecordingOverlayPanel` (the card, `PictureAboveRow`, the camera button);
`CaptureController` routes `capture.setCamera` and reports `camera` in status; the pressed tint in
`CaptureView.swift`.

Tests and harnesses that pin it:
- [`CameraAvailabilityTests`](../../../helpers/mac/Tests/YapCaptureTests/CameraAvailabilityTests.swift):
  the format (a single run keeps the 0.1.33 key sets), gaps in the canonical movie, the window
  rule, malformed gaps, crash recovery with gaps, a 500-run take.
- [`SelectedCameraInputTests`](../../../helpers/mac/Tests/YapCaptureTests/SelectedCameraInputTests.swift):
  the session lifecycle on a fixture device: reserved-never-on, off-on-off-on, races with stop and
  discard, device loss on and off, the toggle limit, release failures.
- [`camera-toggle-controls.mjs`](https://github.com/dzhng/yap/blob/4b4e708c/packages/test-harness/editing/camera-toggle-controls.mjs):
  the real controller, host channel, service, CLI and MCP with a fixture camera; toggle journeys
  through admission, composition (the camera is transparent in a gap) and crash recovery; a
  never-on take; a camera-only refusal.
- [`camera-source-admission.mjs`](https://github.com/dzhng/yap/blob/4b4e708c/packages/test-harness/editing/camera-source-admission.mjs):
  admits the native suite's gapped takes through the service; the microsecond probe equals the
  receipt's intervals.
- [`camera-library-preservation.mjs`](https://github.com/dzhng/yap/blob/4b4e708c/packages/test-harness/editing/camera-library-preservation.mjs)
  with the pre-toggle corpus (above).
- Core: `evidence.test.ts`, `acquisitions.test.ts` (including "a 0.1.33 camera proof admits
  unchanged", using the proof 0.1.33 stored for corpus B), `capture-acquisition.test.ts`.
- App: [`SelectionTests`](../../../apps/macos/tests/YapControlsTests/SelectionTests.swift)
  (reservation, `cameraAtStart`, live toggle), the [capture-view fixture](../../../apps/macos/tests/fixtures/capture-view.swift)
  (menu switch, pressed tint), [`recording-overlay-shots.mjs`](../../../apps/macos/tests/recording-overlay-shots.mjs)
  with its [fixture](../../../apps/macos/tests/fixtures/recording-overlay.swift) (geometry and
  the row's exact actions in each camera state), [`CapturePresentationTests`](../../../apps/macos/tests/YapControlsTests/CapturePresentationTests.swift)
  (`runOverlayCameraTests`), `library-controls.test.mjs`, and `overlay-clock.test.mjs` as a
  geometry regression net for the redesigned row.

## Where the build departed from the plan

- **Gap budget.** The first build raised the receipt's read bound to fit 100 000 gaps. It was
  reverted: a take allows 500 turn-ons, so 499 gaps, which fit the original bounds with room to
  spare (a measured 500-run receipt is about 22 KB against 64 KiB and 32 KiB).
- **A forced key frame starts every run.** Without it, a run starting on a P-frame made the
  passthrough export copy hidden preroll; at 500 runs the canonical movie was 7.5 MB against a
  1.1 MB raw movie, and publication's scan stalled.
- **The acquisition window decides what is recorded,** by capture time, not delivery time. A
  late picture acquired while on is kept; one crossing a turn-off, or captured before the current
  turn-on, is logged `camera-off`.
- **Multi-run takes give up the live verification** as soon as a second run starts and publish by
  full scan, and gaps are checked inside that canonical scan rather than in journal validation.
- **A camera that starts on is opened during preparation,** so a camera that cannot open refuses
  the take before any output exists. Only a camera that starts off is reserved unopened.
- **Stop during a turn-on cancels it.** First built as `NO_CAMERA`, which cost the take.
- **`NO_CAMERA` only when the camera is on at stop.** First built for any camera without a
  picture, so turning the camera on and off before its first picture failed the take.
- **A toggle's release failure belongs to the toggle.** First built so the companion camera
  remembered it and failed the take at stop, possibly long after the camera was switched off.
- **No "lost" flag.** An off camera has no session to lose; the next turn-on checks presence.
- **Crash recovery keeps a prefix.** For an unsealed raw movie, recovery ends the camera at the
  first mapped picture the movie lacks; the last run's unfragmented tail is lost, as accepted.
  A crashed directory with only a mapping recovers as `NO_CAMERA`: it cannot tell "never turned
  on" from "lost before the first picture". An empty mapping doesn't settle it either, because a
  turn-on writes nothing before the device's first callback.
- **The mapping logs camera callbacks only** (KU6, decided by the user after the close). As
  first built it logged every screen and microphone callback of every take that reserved a
  camera, about 2.75 MB a minute even with the camera off. Nothing read those rows.
- **The device measurement never ran.** No step blocked on a device, and every question it would
  have answered was settled by design (lazy open, compatible format, observers removed before
  stop, a 20 s turn-on wait). This Mac has no camera.
- **The library had no camera row to hide.** The real defect was polling: every unavailable
  publication counted as a pending admission.
- **The real app cannot reserve a camera here** (it lists only native cameras), so the app-level
  proof runs through the fixture-camera controller journey, not the real-app suites.
- **The corpus producer lives only in history.** It was removed in `ac318718`; run it from
  `7f3326de`, the last commit whose product code is pre-toggle. Later code cannot make the
  corpus.
- **Clock-width regression.** The card redesign cut the clock's reserved width, so a ten-hour
  clock widened the controls. The full run's `overlay-clock.test.mjs` caught it; the clock now
  reserves the width of `00:00:00`, and the overlay shots were redrawn.
- **Full-run findings outside the feature:** service tests that supply their own worker inherited
  `YAP_NATIVE` (an explicit `nativeExecutable` now wins), and a stale wrong-pause case in the
  camera admission harness.

## Open follow-ups

- **Long camera-on takes.** The mapping now grows only with camera time, about 0.9 MB a minute,
  so publication's 256 MiB read budget is reached after about 4.8 hours with the camera on (derived,
  not observed); see [KU6](choices.md#ku6-the-camera-mapping-logs-camera-callbacks-only).
- **Floating-controls polish, noted and not acted on.** The user approved the camera button's
  look; the small polish items in its [ledger entry](choices.md#the-camera-buttons-look-and-the-floating-controls-open-polish)
  remain, including minimize as a "−" rather than a window-minimize glyph.
- **Camera loss while on still interrupts the take.** Whether it should become "camera off" is
  the user's call. Likewise, a release failure at stop of a camera that is on still fails the
  take, on purpose.
- **Unmeasured on a device:** a real camera whose pixel format or colour tags change between
  sessions; the fixture proves such a turn-on ends its run and the take continues. The 20 s
  turn-on wait is a design value.
- **Latent:** the `MediaInput` read-path stall that heavy passthrough preroll caused was avoided,
  not investigated.

## Visual provenance

**The user's report** drove the floating-controls redesign: the camera preview was drawn square
inside an oval, overflowing it and off centre. The defect had never been rendered with a camera
(the real-app overlay shots only drive a camera-less take), so it was reproduced by drawing the
old view with a mock camera picture ([dark](assets/overlay/reported-bug-dark.png),
[light](assets/overlay/reported-bug-light.png)). A one-off script, not kept, hosted the old
`RecordingOverlayView` from `a8adbab2` with a 16:9 mock picture whose thin yellow border marks
its edges. The renders show the oval background, the picture's square corners and its
off-centre placement. The cause was one capsule behind both the picture and the row, plus
asymmetric padding. That reproduction set the standard the
[overlay fixture](../../../apps/macos/tests/fixtures/recording-overlay.swift) now asserts:
centred, rounded, the row's width, cropped not squeezed.

**The final shots** in [assets/overlay/](assets/overlay/) are drawn by
[`recording-overlay-shots.mjs`](../../../apps/macos/tests/recording-overlay-shots.mjs) from the
production `RecordingOverlayPanel`, offscreen, with the same synthetic picture, in light and
dark: [preview shown](assets/overlay/camera-preview.png), [paused](assets/overlay/camera-preview-paused.png),
[minimized](assets/overlay/camera-preview-minimized.png), [camera off](assets/overlay/camera-off.png)
and [no camera](assets/overlay/no-camera.png), each with a `dark-` twin. Two unprimed critiques of
earlier drafts drove the camera button's treatment: a plain icon left on and off to a thin slash,
and the system's off style read as disabled. The shots were redrawn after the clock fix. They
show content geometry, not the live app: the real app cannot reserve a camera on this Mac. The
user approved the look on 2026-10-13.

**The [pre-toggle baseline frames](assets/pre-toggle-corpus/baseline/)** are frames the
pre-change build delivered from the corpus libraries. They are the before picture for
compare-screenshots on the preservation gate.

The menu's pressed state has no shots; the [capture-view fixture](../../../apps/macos/tests/fixtures/capture-view.swift)
pins it.
