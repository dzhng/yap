import Foundation
import YapControls

let display = ControlsState.Display(id: 3, name: "Studio Display", width: 2560, height: 1440)
let window = ControlsState.Window(id: 88, title: "Pricing", application: "Safari")
let builtIn = ControlsState.Microphone(id: "mic-built-in", name: "MacBook Pro Microphone", isDefault: true)
let headset = ControlsState.Microphone(id: "mic-headset", name: "Studio Headset", isDefault: false)

/// A state with a chosen source and a listed catalog, which most checks start from.
func ready(source: ControlsState.SelectedSource? = .display(display)) -> ControlsState {
    var state = ControlsState()
    state.service = .ready
    state.sources = ControlsState.SourceCatalog(
        displays: [display], windows: [window], microphones: [builtIn, headset])
    state.selection.source = source
    state.device = ControlsState.DeviceStatus(state: .idle, recordingId: nil, elapsedUs: nil)
    state.permissions = ControlsState.Permissions(screen: .granted, microphone: .granted)
    return state
}

func runElapsedFormatTests() {
    precondition(ElapsedTime.format(0) == "0:00", "A take that just started reads as zero")
    precondition(ElapsedTime.format(7_400_000) == "0:07", "Part seconds round down to whole ones")
    precondition(ElapsedTime.format(61_500_000) == "1:01", "Minutes and seconds read together")
    precondition(ElapsedTime.format(3_661_000_000) == "1:01:01", "An hours field appears only once there is one")
    precondition(ElapsedTime.format(3_599_000_000) == "59:59", "Just under an hour stays in minutes")
    precondition(ElapsedTime.format(nil) == "—", "A take with no measured time states none, not zero")
    precondition(ElapsedTime.shortTime(of: "2026-09-16T09:10:11.000Z") == ElapsedTime.shortTime(of: "2026-09-16T09:10:11Z"),
        "Service timestamps with milliseconds keep their readable local date")
    print("PASS elapsed playback time reads as a recorder's clock")
}

/// A microphone somebody chose is theirs whether or not it is plugged in today.
func runAwaitedMicrophoneTests() {
    var state = ready()
    state.selection.microphone = .device(id: headset.id, name: headset.name)

    state.observeSources(ControlsState.SourceCatalog(
        displays: [display], windows: [window], microphones: [builtIn]))
    precondition(
        state.selection.microphone == .systemDefault,
        "A take cannot be narrated through a microphone that is not there")
    precondition(
        state.selection.awaitedMicrophone == .device(id: headset.id, name: headset.name),
        "The choice is remembered rather than thrown away")
    precondition(
        state.selection.recordingDefaults.microphone == .device(id: headset.id, name: headset.name),
        "What is saved is what this person chose, not what today's Mac happens to have")
    precondition(
        CapturePresentation.microphoneTitle(for: state) == "system default, waiting for Studio Headset",
        "The capture label says which input it is waiting for, got \(CapturePresentation.microphoneTitle(for: state))")

    state.observeSources(ControlsState.SourceCatalog(
        displays: [display], windows: [window], microphones: [builtIn, headset]))
    precondition(
        state.selection.microphone == .device(id: headset.id, name: headset.name)
            && state.selection.awaitedMicrophone == nil,
        "Plugged back in, it is selected again without being chosen a second time")
    print("PASS an unplugged microphone stays this person's choice")
}

func runSelectionTests() {
    var defaultCamera = ControlsState()
    defaultCamera.observeSources(.init(cameras: [
        .init(id: "external", name: "External"),
        .init(id: "default", name: "Default camera", isDefault: true),
    ]))
    defaultCamera.selectDefaultCameraIfNeeded(enabled: false)
    precondition(defaultCamera.selection.cameraDeviceId == nil, "Discovery must leave disabled camera capture off")
    defaultCamera.selectDefaultCameraIfNeeded(enabled: true)
    precondition(defaultCamera.selection.cameraDeviceId == "default", "Enabling camera capture chooses the native default, not the first device")
    defaultCamera.selection.cameraDeviceId = "external"
    defaultCamera.selectDefaultCameraIfNeeded(enabled: true)
    precondition(defaultCamera.selection.cameraDeviceId == "external", "Refresh preserves a chosen camera identity")
    precondition(CapturePresentation.cameraIsRequired(cameraOnly: true, selectedCameraIndex: 1) == false,
                 "A selected camera does not carry a redundant Required label")
    precondition(CapturePresentation.cameraIsRequired(cameraOnly: true, selectedCameraIndex: 0),
                 "Camera-only mode keeps guidance while no usable camera is selected")
    let cameraData = Data(#"{"source":{"kind":"camera","deviceId":"selected-camera"},"microphone":false,"systemAudio":false}"#.utf8)
    guard let cameraStart = try? JSONDecoder().decode(ControlsState.CaptureSelection.Start.self, from: cameraData) else {
        preconditionFailure("A primary camera start crosses the shared controls boundary")
    }
    var cameraState = ControlsState()
    cameraState.selection.apply(cameraStart, catalog: cameraState.sources)
    precondition(cameraState.start() == cameraStart,
                 "An external primary camera retains its exact device identity for restart")
    let cameraRestart = try! JSONSerialization.jsonObject(with: JSONEncoder().encode(cameraState.start()!)) as! [String: Any]
    precondition(cameraRestart["cameraDeviceId"] == nil,
                 "A primary camera never emits a companion camera selection")
    precondition(cameraState.beginStart(newRequestId: "missing-camera") == nil,
                 "An unavailable selected camera cannot start or substitute another device")
    cameraState.observeSources(.init(cameras: [.init(id: "selected-camera", name: "Studio Camera")]))
    precondition(cameraState.beginStart(newRequestId: "available-camera")?.start == cameraStart,
                 "An explicit available camera starts with no discovered screen")
    cameraState.sourcesUnavailable(description: "Screen listing was refused")
    precondition(cameraState.sources.cameras.first?.id == "selected-camera"
                 && cameraState.selection.cameraDeviceId == "selected-camera",
                 "A failed screen listing cannot erase independent camera discovery or its choice")
    cameraState.observeSources(.init())
    let replay = cameraState.beginStart(newRequestId: "must-not-allocate")
    precondition(replay?.requestId == "available-camera" && replay?.repeatsUnanswered == true,
                 "A disconnected camera cannot prevent resolving its unanswered allocation")
    if let replay { _ = cameraState.finishStart(replay, .ended) }
    precondition(cameraState.beginStart(newRequestId: "disconnected-fresh") == nil,
                 "After resolving the old allocation a disconnected camera cannot start a new take")
    var state = ControlsState()
    precondition(state.start() == nil, "Nothing starts until a person chooses a source")
    precondition(
        state.selection.microphone == .systemDefault && state.selection.systemAudio == false,
        "These takes are narrated: the microphone starts on and the machine's own sound off")

    state = ready(source: .window(window))
    guard let narrated = state.start() else { preconditionFailure("A chosen source starts") }
    precondition(
        narrated == .init(source: .window(id: 88), microphone: true, microphoneDeviceId: nil, systemAudio: false),
        "A default start records the chosen window with narration and no system audio")

    state.selection.microphone = .device(id: headset.id, name: headset.name)
    state.selection.systemAudio = true
    precondition(
        state.start()
            == .init(source: .window(id: 88), microphone: true, microphoneDeviceId: "mic-headset", systemAudio: true),
        "A named input and system audio are both carried explicitly")

    state.selection.microphone = .off
    precondition(
        state.start()
            == .init(source: .window(id: 88), microphone: false, microphoneDeviceId: nil, systemAudio: true),
        "Turning narration off refuses the microphone and keeps no device behind it")

    state.selection.source = .region(
        ControlsState.Region(
            displayId: 3, displayName: "Studio Display", x: 40, y: 120, width: 800, height: 600))
    precondition(
        state.start()?.source == .region(displayId: 3, x: 40, y: 120, width: 800, height: 600),
        "A region start carries the display-local rectangle it was selected as")
    let active = try! JSONDecoder().decode(ControlsState.CaptureSelection.Start.self, from: Data(
        #"{"source":{"kind":"window","windowId":88},"microphone":false,"systemAudio":true,"cameraDeviceId":"selected-camera"}"#.utf8))
    state.selection.apply(active, catalog: state.sources)
    // An absent start state means "on", so the restart states it rather than changing it.
    precondition(state.start() == .init(source: active.source, microphone: false, microphoneDeviceId: nil,
                                        systemAudio: true, cameraDeviceId: "selected-camera", cameraAtStart: .on),
                 "An external take replaces the selected source, both audio choices and its camera for restart")
    precondition(CapturePresentation.sourceTitle(for: state) == "Safari — Pricing",
                 "An external window resolves its catalog label")
    let checkout = ControlsState.Window(id: 88, title: "Checkout", application: "Safari")
    state.observeSources(.init(displays: [display], windows: [checkout], microphones: []))
    precondition(state.failure == nil, "A title change is not a closed window")
    precondition(CapturePresentation.sourceTitle(for: state) == "Safari — Checkout",
                 "A retained selection shows the refreshed title")
    precondition(state.start()?.source == .window(id: 88),
                 "Renaming a window preserves its capture identity")
    state.observeSources(.init(displays: [display], windows: [], microphones: []))
    precondition(state.failure != nil && state.selection.source == nil,
                 "A missing window is visibly deselected")
    state.failure = nil
    state.observeSources(.init(displays: [display], windows: [], microphones: []))
    precondition(state.start() == nil,
                 "A source that disappeared is never replaced by a display nobody chose")

    var fresh = ControlsState()
    fresh.observeSources(.init(displays: [display], windows: [window], microphones: []))
    precondition(fresh.selection.source == .display(display),
                 "Before anything was selected, the first display is offered")

    var failing = ready(source: .window(window))
    failing.sourcesUnavailable(description: "TIMEOUT: capture.sources did not answer in time")
    precondition(
        failing.selection.source == .window(window) && failing.sources.windows == [window]
            && failing.failure == "TIMEOUT: capture.sources did not answer in time",
        "A catalog read that failed keeps the selection and states its own failure")
    print("PASS a selection becomes exactly the take it describes")
}

func runStartRoutingTests() {
    let menuDisplay = ControlsState.Display(
        id: 3, name: "Menu Display", width: 1000, height: 800,
        frame: CGRect(x: 0, y: 0, width: 1000, height: 800))
    let pointerDisplay = ControlsState.Display(
        id: 4, name: "Pointer Display", width: 1200, height: 900,
        frame: CGRect(x: 1000, y: 0, width: 1200, height: 900))
    var state = ready(source: .display(menuDisplay))
    state.sources.displays = [menuDisplay, pointerDisplay]
    state.selection.microphone = .off
    state.selection.systemAudio = true

    guard let start = state.start(origin: .hotkey(pointer: CGPoint(x: 1_500, y: 400))) else {
        preconditionFailure("A hotkey start resolves the display under the pointer")
    }
    precondition(start.source == .display(id: pointerDisplay.id),
        "A hotkey records the display under the pointer, not the menu's selected display")
    precondition(!start.microphone && start.systemAudio,
        "A hotkey keeps the menu's microphone and system-audio choices")

    let menuStart = state.start(origin: .menu)
    precondition(menuStart?.source == .display(id: menuDisplay.id),
        "A menu start keeps the menu's selected display")

    let left = ControlsState.Display(
        id: 5, name: "Left", width: 100, height: 100,
        frame: CGRect(x: 0, y: 0, width: 100, height: 100))
    let right = ControlsState.Display(
        id: 6, name: "Right", width: 100, height: 100,
        frame: CGRect(x: 200, y: 0, width: 100, height: 100))
    state.sources.displays = [left, right]
    precondition(state.start(origin: .hotkey(pointer: CGPoint(x: 180, y: 50)))?.source == .display(id: right.id),
        "A pointer in a display gap resolves to the nearest display")
    precondition(state.start(origin: .hotkey(pointer: CGPoint(x: 200, y: 50)))?.source == .display(id: right.id),
        "A pointer on a display edge resolves to the display whose frame contains it")

    guard let request = state.beginStart(
        newRequestId: "hotkey", origin: .hotkey(pointer: CGPoint(x: 180, y: 50))) else {
        preconditionFailure("A hotkey routing request starts")
    }
    precondition(request.origin == .hotkey(pointer: CGPoint(x: 180, y: 50)),
        "The start request retains the origin for replay and countdown placement")
    guard let replay = state.beginStart(
        newRequestId: "replay", origin: .hotkey(pointer: CGPoint(x: 180, y: 50))) else {
        preconditionFailure("An unanswered hotkey start can be replayed")
    }
    precondition(replay.repeatsUnanswered && replay.origin == request.origin,
        "A replay keeps the original hotkey origin")

    state.observeTake(.init(recordingId: "rec-hotkey", state: "recording", interruptionReason: nil, sourceDurationUs: nil))
    precondition(!state.finishStart(replay, .live), "A live replay settles the take")
    state.device = .init(state: .recording, recordingId: "rec-hotkey", elapsedUs: 0)
    state.selection.source = .display(menuDisplay)
    precondition(state.restartStart?.source == request.start.source,
        "Restart reuses the live take's resolved source after a hotkey start")

    // That take ends normally; another client (the CLI's capture.start) starts the next one, and
    // status reports its source as the selection.
    state.device = .init(state: .idle, recordingId: nil, elapsedUs: nil)
    state.device = .init(state: .recording, recordingId: "rec-cli", elapsedUs: 0)
    state.selection.source = .display(left)
    precondition(state.restartStart?.source == .display(id: left.id),
        "A take not started here restarts on its own source, not an earlier take's, got \(String(describing: state.restartStart?.source))")
    print("PASS hotkey starts route to the display under the pointer")
}

/// A screen take reserves a camera whenever camera access is granted, so it can be turned on
/// mid-take; the start switch only decides whether it starts on.
func runCameraReservationTests() {
    let external = ControlsState.Camera(id: "external", name: "External")
    let builtIn = ControlsState.Camera(id: "built-in", name: "FaceTime HD Camera", isDefault: true)
    func screen(access: ControlsState.Access) -> ControlsState {
        var state = ready(source: .window(window))
        state.sources.cameras = [external, builtIn]
        state.permissions = .init(screen: .granted, microphone: .granted, camera: access)
        return state
    }
    func json(_ start: ControlsState.CaptureSelection.Start?) -> [String: Any] {
        try! JSONSerialization.jsonObject(with: JSONEncoder().encode(start!)) as! [String: Any]
    }

    var state = screen(access: .granted)
    precondition(!state.selection.cameraOn, "A fresh launch starts with the camera switch off")
    let reserved = json(state.start())
    precondition(reserved["cameraDeviceId"] as? String == "built-in" && reserved["cameraAtStart"] as? String == "off",
                 "With access, a take reserves the system default camera, off, even with the switch off: \(reserved)")

    precondition(state.setCamera(true) == nil, "Before a take the switch is a selection; nothing is sent")
    let on = json(state.start())
    precondition(on["cameraDeviceId"] as? String == "built-in" && on["cameraAtStart"] as? String == "on",
                 "The switch on starts the reserved camera on: \(on)")

    _ = state.setCamera(false)
    state.selection.cameraDeviceId = external.id
    let picked = json(state.start())
    precondition(picked["cameraDeviceId"] as? String == "external" && picked["cameraAtStart"] as? String == "off",
                 "Switching off keeps the picked camera, which is the one reserved: \(picked)")

    for access in [ControlsState.Access.undetermined, .denied] {
        let unauthorized = json(screen(access: access).start())
        precondition(unauthorized["cameraDeviceId"] == nil && unauthorized["cameraAtStart"] == nil,
                     "Without camera access (\(access)) a take reserves nothing: \(unauthorized)")
    }
    var asked = screen(access: .denied)
    _ = asked.setCamera(true)
    let refused = json(asked.start())
    precondition(refused["cameraDeviceId"] as? String == "built-in" && refused["cameraAtStart"] as? String == "on",
                 "A camera switched on is still asked for, so a missing permission is refused out loud, not dropped: \(refused)")

    var noCamera = screen(access: .granted)
    noCamera.sources.cameras = []
    let alone = json(noCamera.start())
    precondition(alone["cameraDeviceId"] == nil && alone["cameraAtStart"] == nil, "With no camera there is nothing to reserve")

    var primary = screen(access: .granted)
    primary.selection.source = .camera
    primary.selection.cameraDeviceId = external.id
    let cameraOnly = json(primary.start())
    precondition(cameraOnly["cameraDeviceId"] == nil && cameraOnly["cameraAtStart"] == nil,
                 "A camera-only take has no companion to reserve or switch: \(cameraOnly)")
    precondition(primary.setCamera(false) == nil && primary.start()?.source == ControlsState.CaptureSelection.Start.Source.camera(deviceId: "external"),
                 "The camera switch cannot turn a camera-only take's source off")

    // A take started elsewhere with its camera reserved and off restarts the same way.
    let elsewhere = try! JSONDecoder().decode(ControlsState.CaptureSelection.Start.self, from: Data(
        #"{"source":{"kind":"window","windowId":88},"microphone":false,"systemAudio":false,"cameraDeviceId":"external","cameraAtStart":"off"}"#.utf8))
    var restarted = screen(access: .granted)
    restarted.selection.apply(elsewhere, catalog: restarted.sources)
    precondition(restarted.start() == elsewhere && !restarted.selection.cameraOn,
                 "A live take's reserved-off camera is what its restart asks for")

    // During a take the same action is a request to the service for the reserved camera.
    var live = screen(access: .granted)
    live.device = .init(state: .recording, recordingId: "take-1", elapsedUs: 1_000_000,
                        camera: .init(deviceId: "built-in", state: .off))
    precondition(live.setCamera(true) == ControlsState.SetCamera(recordingId: "take-1", on: true),
                 "A live toggle asks the service to turn the take's camera on")
    precondition(!live.selection.cameraOn, "A live toggle leaves the next take's start switch alone")
    live.device = .init(state: .paused, recordingId: "take-1", elapsedUs: 1_000_000,
                        camera: .init(deviceId: "built-in", state: .on))
    precondition(live.setCamera(false) == ControlsState.SetCamera(recordingId: "take-1", on: false),
                 "A paused take's camera can be turned off too")
    live.device = .init(state: .recording, recordingId: "take-2", elapsedUs: 1_000_000)
    precondition(live.setCamera(true) == nil && live.failure != nil,
                 "A take that reserved no camera has none to turn on, and says so")
    print("PASS a screen take reserves its camera with access and switches it with one action")
}

func runStartRequestTests() {
    var state = ready(source: .window(window))
    guard let first = state.beginStart(newRequestId: "first") else { preconditionFailure("A chosen source starts") }
    precondition(first.requestId == "first" && !first.repeatsUnanswered, "A first start is a new request")
    precondition(state.beginStart(newRequestId: "double")?.requestId == "first",
                 "Pressing Start again while the answer is in flight asks for the same take")
    precondition(!state.finishStart(first, .init(failureCode: "TIMEOUT")), "A lost answer asks for nothing yet")

    guard let replay = state.beginStart(newRequestId: "second") else { preconditionFailure("A replay starts") }
    precondition(replay.requestId == "first" && replay.repeatsUnanswered,
                 "Asking again resolves the take the unanswered request allocated")
    precondition(!state.finishStart(replay, .init(failureCode: "UNRESOLVED_START")),
                 "A start the service has not proved yet stays unanswered")
    guard let settled = state.beginStart(newRequestId: "third") else { preconditionFailure("A replay starts") }
    precondition(settled.requestId == "first", "An unproved start is still asked for under its own ID")
    precondition(state.finishStart(settled, .init(recordingState: "interrupted")),
                 "A replay that resolves to an ended take recorded nothing, so the start asks again")
    guard let next = state.beginStart(newRequestId: "fourth") else { preconditionFailure("A new start") }
    precondition(next.requestId == "fourth" && !next.repeatsUnanswered,
                 "Once the lost start is settled, the next press allocates a new take")
    precondition(!state.finishStart(next, .init(recordingState: "recording")) && state.unansweredStart == nil,
                 "A live answer settles the request")

    guard let lost = state.beginStart(newRequestId: "fifth") else { preconditionFailure("A new start") }
    _ = state.finishStart(lost, .init(failureCode: "SERVICE_STOPPED"))
    state.selection.systemAudio.toggle()
    precondition(state.beginStart(newRequestId: "sixth")?.requestId == "sixth",
                 "A different selection is a different take, not a replay")
    guard let refused = state.unansweredStart else { preconditionFailure("A start is in flight") }
    precondition(!state.finishStart(refused, .init(failureCode: "INVALID_STATE")) && state.unansweredStart == nil,
                 "A refusal leaves nothing to resolve")
    print("PASS a start whose answer was lost is resolved once, then a new take is asked for")
}
