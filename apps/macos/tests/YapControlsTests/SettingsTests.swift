import Foundation
import YapControls

func runStartPermissionTests() {
    precondition(PermissionKind.missing(fromStartFailure: "CAMERA_PERMISSION_REQUIRED")?.name == "Camera",
                 "A camera start refusal offers camera access, independently of screen access")
    precondition(
        PermissionKind.missing(fromStartFailure: "MICROPHONE_PERMISSION_REQUIRED") == .microphone,
        "A start refused for the microphone asks for the microphone")
    precondition(
        PermissionKind.missing(fromStartFailure: "PERMISSION_REQUIRED") == .screen,
        "A start refused for the screen asks for screen recording")
    for code in ["SOURCE_UNAVAILABLE", "TIMEOUT", "CAPTURE_BUSY", ""] {
        precondition(
            PermissionKind.missing(fromStartFailure: code) == nil,
            "\(code) names no missing access and must not ask for one")
    }
    print("PASS a refused start asks for the access it was missing")
}

func runAuthorizationTests() {
    precondition(
        ControlsState.Access(authorization: "authorized") == .granted
            && ControlsState.Access(authorization: "not_determined") == .undetermined
            && ControlsState.Access(authorization: "denied") == .denied
            && ControlsState.Access(authorization: "restricted") == .denied,
        "Only an unanswered prompt can still be asked; restricted access is as final as a denial")
    print("PASS native authorization distinguishes unanswered prompts from denied access")
}

func runPreferenceTests() {
    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("yap-preferences-\(UUID().uuidString)")
    try! FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    // An absolute suite name keeps this domain in the scratch directory, away from real defaults.
    let suite = directory.appendingPathComponent("preferences").path
    let launch = { Preferences(defaults: UserDefaults(suiteName: suite)!) }

    let first = launch()
    precondition(first.showSettingsAtLaunch, "Settings opens at launch until a person turns it off")
    precondition(first.setUpAgents, "Agent setup (command and skill) is on by default")
    precondition(first.showCameraPreview, "Camera preview is visible by default")
    precondition(first.controlsGlass == .clear, "The floating controls are clear glass by default")
    precondition(
        first.countdown?.remaining == Countdown.defaultSeconds,
        "A start counts down until a person turns that off")
    let fresh = ControlsState(recording: first.recording)
    precondition(
        fresh.selection.microphone == .systemDefault && !fresh.selection.systemAudio
            && fresh.selection.source == nil,
        "With nothing saved, a take is narrated through the default input and no system audio")

    var edited = fresh
    edited.selection.microphone = .device(id: headset.id, name: headset.name)
    edited.selection.systemAudio = true
    first.recording = edited.selection.recordingDefaults
    first.showSettingsAtLaunch = false
    first.setUpAgents = false
    first.countdownBeforeRecording = false
    first.showCameraPreview = false
    first.controlsGlass = .dark

    let relaunched = launch()
    precondition(!relaunched.showSettingsAtLaunch, "Turning the window off survives a relaunch")
    precondition(!relaunched.setUpAgents, "Turning agent setup off survives a relaunch")
    precondition(
        relaunched.countdown == nil,
        "Turning the countdown off survives a relaunch, and then a start records immediately")
    precondition(!relaunched.showCameraPreview, "Hiding the camera preview survives a relaunch")
    precondition(relaunched.controlsGlass == .dark, "Choosing dark controls survives a relaunch")
    let restored = ControlsState(recording: relaunched.recording)
    precondition(
        restored.selection.microphone == .device(id: "mic-headset", name: "Studio Headset")
            && restored.selection.systemAudio && restored.selection.source == nil,
        "A fresh launch starts from the saved audio choices and still asks for a source")
    precondition(
        CapturePresentation.microphoneTitle(for: restored) == "Studio Headset",
        "The saved input is named before the catalog has been read")

    relaunched.recording = RecordingDefaults(microphone: .off, systemAudio: false)
    let silent = ControlsState(recording: launch().recording)
    precondition(
        silent.selection.microphone == .off && !silent.selection.systemAudio,
        "Turning narration off is saved as off, not as the default input")
    print("PASS recording defaults and the launch window preference survive a relaunch")
}
