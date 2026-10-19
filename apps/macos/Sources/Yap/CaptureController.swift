import AppKit
import AVFoundation
import ScreenCaptureKit
import YapCapture
import YapControls

/**
 The app's half of capture control. The service allocates a take's identity and directory and asks
 for a transition; this owns the device, the permissions and the media, and reports back what the
 session actually did. It keeps no catalog of its own: the only state here is which allocated take
 the one capture session is working on.
 */
@MainActor
final class CaptureController {
    private struct Take {
        let recordingId: String
        let sourceId: String
        let selection: [String: Any]
    }

    private let capture: NativeCapture
    private let termination = CaptureTermination<Data>()
    /// The exact authored acknowledgment remains valid while a later terminal report is in flight.
    private var finalizingReceipt: Data?
    private var take: Take?
    /// The take whose `capture.start` has not returned yet, and whoever is waiting for it. A start
    /// in flight is part of this session: the app — not a service that may already be gone — owns
    /// what happens to the take when it lands.
    private var pendingStart: Take?
    private var startWaiters: [CheckedContinuation<Void, Never>] = []
    /// Set once the service that allocated the take in flight has disappeared.
    private var serviceGone = false
    /// Set only in fixture mode: the one window of this app's own that capture may see or record.
    private let fixtureWindow: NSWindow?
    /// Set only in fixture mode, and only when a check asked for it: the hold a pending start waits on.
    private let startHold: FixtureStartHold?
    private weak var host: ServiceHost?
    var updateProgress: (() -> Void)?
    /// Latest camera frame from the one capture session, delivered on its writer queue.
    nonisolated(unsafe) var onCameraFrame: (@Sendable (NativeCapture.CameraPreviewFrame) -> Void)?

    init(fixtureWindow: NSWindow?, capture: NativeCapture = NativeCapture()) {
        self.capture = capture
        self.fixtureWindow = fixtureWindow
        self.startHold = FixtureStartHold.inFixture(fixtureWindow)
        capture.onCameraFrame = { [weak self] frame in self?.onCameraFrame?(frame) }
        capture.onInterruption = { [weak self] reason in
            guard let self, let interrupted = self.take ?? self.pendingStart else { return }
            let recordingId = interrupted.recordingId
            let sourceId = interrupted.sourceId
            Task { @MainActor [weak self] in
                await self?.interrupted(reason, recordingId: recordingId, sourceId: sourceId)
            }
        }
        capture.onPublication = { [weak self] observation in
            guard let self, let active = self.take,
                observation.sourceId == active.sourceId,
                self.capture.publication?.generation == observation.generation else { return }
            do {
                // The journal assigns authority before suspension; later reports carry this full snapshot.
                let report = try self.transition("finalizing")
                Task { @MainActor [weak self] in
                    guard let self, !self.serviceGone else { return }
                    await self.send(report: report)
                }
            } catch { diagnostic("capture publication report failed: \(error.localizedDescription)") }
        }
    }

    /// Leaves this app's own windows out of the running take; true once the take is known to.
    func excludeOwnWindows() async -> Bool { await capture.excludeOwnWindows() }

    /// Appends a retracting mark for the latest live mark. Shortcut bindings call this entry point.
    func undoMark() throws { try capture.undoMark() }

    func attach(to host: ServiceHost) {
        self.host = host
    }

    var isCapturing: Bool { take != nil || pendingStart != nil || termination.isRunning }

    func handle(_ operation: String, _ params: Data) async -> Result<Data, ServiceFailure> {
        defer { updateProgress?() }
        do {
            guard let fields = try JSONSerialization.jsonObject(with: params) as? [String: Any]
            else {
                throw CaptureFailure("INVALID_REQUEST", "Capture parameters must be an object.")
            }
            return .success(
                try JSONSerialization.data(withJSONObject: try await perform(operation, fields)))
        } catch let failure as CaptureFailure {
            return .failure(ServiceFailure(code: failure.code, message: failure.message))
        } catch {
            return .failure(
                ServiceFailure(
                    code: "NATIVE_CAPTURE_FAILED", message: error.localizedDescription))
        }
    }

    /// Normal quit finalizes the running take and waits for the library to store its outcome, so
    /// an ordinary quit leaves a finished recording rather than one more take to reconcile. A
    /// start still in flight is waited for first: the quit owns the take it has already asked for.
    func finalizeBeforeQuit() async {
        if pendingStart != nil { diagnostic("quit waiting for a start in flight") }
        await awaitStart()
        guard take != nil else { return }
        _ = try? await finish(reason: "APP_QUIT", notify: true)
    }

    /// The service this take reports to is gone. Native still owns the media, so the take is
    /// finalized into its own durable journal and left for the next service to reconcile. A start
    /// still in flight finalizes itself the moment it lands, so nothing is awaited here.
    func serviceLost() async {
        serviceGone = true
        guard take != nil else {
            diagnostic("service lost with a start in flight")
            return
        }
        diagnostic("service lost while capturing")
        await finishIntoJournal()
    }

    /// Finishes the take this device is holding into its own durable journal, with no service
    /// left to tell about it. The media is native's, so it is sealed here and settled by whichever
    /// service reads it next, rather than captured on into nothing.
    private func finishIntoJournal() async {
        _ = try? await finish(reason: "SERVICE_LOST")
    }

    private func perform(_ operation: String, _ params: [String: Any]) async throws -> Any {
        switch operation {
        case "capture.sources": return try await sources()
        case "capture.status": return status()
        case "capture.start": return try await start(params)
        case "capture.pause":
            try await expect(params)
            try capture.pause()
            return try transition("paused")
        case "capture.resume":
            try await expect(params)
            try capture.resume()
            return try transition("recording")
        case "capture.setCamera":
            try await expect(params)
            guard let on = params["on"] as? Bool else {
                throw CaptureFailure("INVALID_REQUEST", "capture.setCamera states whether the camera is on.")
            }
            // Native refusals, such as a missing camera or the toggle limit, pass through as codes.
            try await capture.setCamera(on: on)
            return status()
        case "capture.stop":
            try await expect(params)
            _ = try beginFinish(reason: nil, notify: true)
            guard let finalizingReceipt else {
                throw CaptureFailure("JOURNAL_FAILED", "Finalizing could not be recorded.")
            }
            return try JSONSerialization.jsonObject(with: finalizingReceipt)
        case "capture.cancel":
            try await expect(params)
            if let running = termination.current {
                capture.cancelPublication()
                // A completed take wins this race. Only an interrupted publication can proceed
                // to discard; its owner must have actually unwound before files become removable.
                if let completed = try? await running.value {
                    return try JSONSerialization.jsonObject(with: completed)
                }
            }
            return try JSONSerialization.jsonObject(with: await finish(reason: nil, discard: true))
        default:
            throw CaptureFailure(
                "UNKNOWN_OPERATION", "Unknown native capture operation: \(operation)")
        }
    }

    private func sources() async throws -> [String: Any] {
        try await Self.discoverSources(screenAuthorized: NativeCapture.screenPermission, screens: {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            let own = Set(CaptureExclusion.ownApplications(
                among: content.applications, bundleIdentifier: Bundle.main.bundleIdentifier,
                identity: \.bundleIdentifier).map(\.processID))
            let windows = content.windows.filter { window in
                if let fixture = self.fixtureWindow { return UInt32(fixture.windowNumber) == window.windowID }
                return WindowSource(
                    layer: window.windowLayer, application: window.owningApplication?.applicationName ?? "",
                    isOwn: window.owningApplication.map { own.contains($0.processID) } ?? false,
                    width: window.frame.width, height: window.frame.height
                ).isRecordable
            }
            return (
                displays: self.fixtureWindow != nil ? [] : content.displays.map {
                    ["displayId": Int($0.displayID), "name": Self.displayName(of: $0.displayID),
                     "width": $0.width, "height": $0.height]
                },
                windows: windows.map {
                    ["windowId": Int($0.windowID), "title": $0.title ?? "",
                     "application": $0.owningApplication?.applicationName ?? ""]
                })
        }, cameras: {
            self.fixtureWindow != nil ? [] : NativeCapture.cameraDevices()
        }, microphones: {
            self.fixtureWindow != nil ? [] : NativeCapture.microphoneDevices()
        })
    }

    /// Device discovery is independent of screen authorization. The screen supplier is lazy so
    /// absent access never reaches ScreenCaptureKit; genuine authorized enumeration errors escape.
    static func discoverSources(
        screenAuthorized: Bool,
        screens: () async throws -> (displays: [[String: Any]], windows: [[String: Any]]),
        cameras: () -> [CaptureVideoDevice], microphones: () -> [CaptureAudioDevice]
    ) async throws -> [String: Any] {
        let screen = screenAuthorized ? try await screens() : (displays: [], windows: [])
        return [
            "displays": screen.displays, "windows": screen.windows,
            "cameras": cameras().map { ["cameraId": $0.id, "name": $0.name, "isDefault": $0.isDefault] },
            "microphones": microphones().map { ["microphoneId": $0.id, "name": $0.name, "isDefault": $0.isDefault] },
        ]
    }

    /// What a person calls this display. `SCDisplay` carries no name, so the window server's own
    /// name for the same display ID is used, and an unmatched ID keeps its number.
    private static func displayName(of displayID: CGDirectDisplayID) -> String {
        let screen = NSScreen.screens.first {
            ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?
                .uint32Value == displayID
        }
        return screen?.localizedName ?? "Display \(displayID)"
    }

    /// Everything the device knows about itself right now, including the running take's playback
    /// time and what this app is permitted to capture. Reading permission asks for nothing.
    private func status() -> [String: Any] {
        [
            "state": capture.deviceState,
            "recordingId": take?.recordingId as Any? ?? NSNull(),
            "sourceId": take?.sourceId as Any? ?? NSNull(),
            "elapsedUs": capture.elapsedSourceUs as Any? ?? NSNull(),
            "selection": (take ?? pendingStart)?.selection as Any? ?? NSNull(),
            "camera": capture.companionCamera.map {
                ["deviceId": $0.deviceId, "state": $0.on ? "on" : "off"] as [String: Any]
            } as Any? ?? NSNull(),
            "permissions": [
                "screen": NativeCapture.screenPermission,
                "microphone": NativeCapture.microphonePermission,
                "camera": NativeCapture.cameraPermission,
            ],
        ]
    }

    private func start(_ params: [String: Any]) async throws -> [String: Any] {
        // Both audio choices are stated by every start the service sends, so this session keeps no
        // default of its own to disagree with the one the protocol owns.
        guard let recordingId = params["recordingId"] as? String, !recordingId.isEmpty,
            let sourceId = params["sourceId"] as? String, !sourceId.isEmpty,
            let directory = params["outputDirectory"] as? String, directory.hasPrefix("/"),
            let selected = params["source"] as? [String: Any],
            let microphone = params["microphone"] as? Bool,
            let systemAudio = params["systemAudio"] as? Bool
        else {
            throw CaptureFailure(
                "INVALID_REQUEST",
                "capture.start needs an allocated take, directory, source and both audio choices.")
        }
        guard take == nil, pendingStart == nil, !termination.isRunning else {
            throw CaptureFailure("INVALID_STATE", "Another take is already capturing.")
        }
        // The fixture records this app's own window and nothing else, so it reaches no audio
        // device whatever a check asks for.
        guard fixtureWindow == nil || !(microphone || systemAudio) else {
            throw CaptureFailure(
                "INVALID_REQUEST",
                "This app is running its capture fixture and records no audio device.")
        }
        let camera: CaptureCameraRequest?
        if selected["kind"] as? String == "camera",
            ["cameraDeviceId", "cameraSourceId", "cameraDirectory", "cameraAtStart"].contains(where: { params[$0] != nil }) {
            throw CaptureFailure("INVALID_REQUEST", "A primary camera cannot carry companion camera authority.")
        }
        if let deviceId = params["cameraDeviceId"] as? String {
            guard !deviceId.isEmpty, deviceId.utf16.count <= 256,
                let cameraSourceId = params["cameraSourceId"] as? String,
                !cameraSourceId.isEmpty, cameraSourceId.utf16.count <= 256,
                let cameraDirectory = params["cameraDirectory"] as? String, cameraDirectory.hasPrefix("/") else {
                throw CaptureFailure("INVALID_REQUEST", "Camera selection requires allocated source and directory authority.")
            }
            let startsOn: Bool
            switch params["cameraAtStart"] {
            case nil: startsOn = true
            case let state as String where ["on", "off"].contains(state): startsOn = state == "on"
            default: throw CaptureFailure("INVALID_REQUEST", "cameraAtStart must be on or off.")
            }
            camera = CaptureCameraRequest(binding: CameraCaptureBinding(recordingId: recordingId,
                sourceId: cameraSourceId, deviceId: deviceId), outputDirectory: cameraDirectory, startsOn: startsOn)
        } else {
            guard params["cameraSourceId"] == nil, params["cameraDirectory"] == nil, params["cameraAtStart"] == nil else {
                throw CaptureFailure("INVALID_REQUEST", "Camera authority requires an explicit selected device.")
            }
            camera = nil
        }
        let request = CaptureRequest(
            source: try source(from: selected), outputDirectory: directory, sourceId: sourceId,
            microphone: microphone,
            microphoneDeviceID: params["microphoneDeviceId"] as? String,
            systemAudio: systemAudio, camera: camera)
        var selection: [String: Any] = [
            "source": selected, "microphone": microphone, "systemAudio": systemAudio,
        ]
        if let device = request.microphoneDeviceID { selection["microphoneDeviceId"] = device }
        if let camera { selection["cameraDeviceId"] = camera.binding.deviceId }
        // The selection echoes what the service sent: an absent start state stays absent.
        if let cameraAtStart = params["cameraAtStart"] { selection["cameraAtStart"] = cameraAtStart }
        let starting = Take(recordingId: recordingId, sourceId: sourceId, selection: selection)
        pendingStart = starting
        // Before the stream starts: anything that must stay out of the take hears of it now.
        updateProgress?()
        defer { releaseStart() }
        await startHold?.hold(recordingId: recordingId)
        try await capture.start(request)
        take = starting
        guard !serviceGone else {
            // The library that allocated this take disappeared while the device was starting, so
            // this landing start ends exactly as a take lost mid-capture does.
            await finishIntoJournal()
            throw CaptureFailure("SERVICE_LOST", "The service that allocated this take is gone.")
        }
        do {
            return try report(state: "recording")
        } catch {
            // The take is running but cannot number its own transitions, so it is not reportable.
            _ = try? await finish(reason: nil, discard: true)
            throw error
        }
    }

    /// Fixture mode exposes exactly one source: this app's own window. Nothing else on the
    /// display can be selected, and the ordinary service and controller path is unchanged.
    private func source(from selected: [String: Any]) throws -> CaptureSource {
        let kind = selected["kind"] as? String ?? ""
        let windowID = (selected["windowId"] as? NSNumber)?.uint32Value
        if let fixtureWindow {
            guard kind == "window", windowID == UInt32(fixtureWindow.windowNumber) else {
                throw CaptureFailure(
                    "SOURCE_UNAVAILABLE",
                    "This app is running its capture fixture and records only its own window.")
            }
            return CaptureSource(kind: "window", windowID: windowID)
        }
        let displayID = (selected["displayId"] as? NSNumber)?.uint32Value
        switch kind {
        case "camera":
            guard Set(selected.keys) == ["kind", "deviceId"],
                let deviceID = selected["deviceId"] as? String, !deviceID.isEmpty,
                deviceID.utf16.count <= 256 else { throw invalidSource }
            return CaptureSource(kind: "camera", deviceID: deviceID)
        case "window":
            guard let windowID else { throw invalidSource }
            return CaptureSource(kind: "window", windowID: windowID)
        case "display":
            guard let displayID else { throw invalidSource }
            return CaptureSource(kind: "display", displayID: displayID)
        case "region":
            guard let displayID, let x = selected["x"] as? Double, let y = selected["y"] as? Double,
                let width = selected["width"] as? Double, let height = selected["height"] as? Double
            else { throw invalidSource }
            return CaptureSource(
                kind: "region", displayID: displayID,
                region: CaptureRegion(x: x, y: y, width: width, height: height))
        default:
            throw invalidSource
        }
    }

    private var invalidSource: CaptureFailure {
        CaptureFailure("INVALID_REQUEST", "Source must name a display, window, region or selected camera.")
    }

    /// Finalizes the running take: the library hears that it is finalizing before the encoder is
    /// asked to close, and hears the outcome once the media is actually on disk.
    private func finish(reason: String?, discard: Bool = false, notify: Bool = false) async throws -> Data {
        try await beginFinish(reason: reason, discard: discard, notify: notify).value
    }

    private func beginFinish(reason: String?, discard: Bool = false, notify: Bool = false) throws -> Task<Data, Error> {
        if let running = termination.current { return running }
        guard let active = take else {
            throw CaptureFailure("INVALID_STATE", "No take is capturing.")
        }
        // Record the acknowledgment synchronously; a stop response must not precede its journal
        // transition, even though potentially long publication runs in the existing task owner.
        let finalizing = Result { try transition("finalizing", reason: reason) }
        finalizingReceipt = try? JSONSerialization.data(withJSONObject: finalizing.get())
        let task = termination.start { [self] in
            var ended = false
            defer {
                if ended && take?.sourceId == active.sourceId { take = nil }
            }
            do {
                // Even a journal/report failure must not leave the media writer running.
                if !discard, !serviceGone, case .success(let report) = finalizing {
                    await send(report: report)
                }
                let outcome: [String: Any]
                if discard {
                    await capture.discard()
                    ended = true
                    outcome = try finalizing.get()
                } else {
                    let result = try await capture.stop()
                    ended = true
                    let interrupted = result.failure != nil
                    outcome = try report(
                        state: interrupted ? "interrupted" : "complete",
                        reason: interrupted ? result.failure?.code ?? reason : (result.cleanupFailure == nil ? nil : "CLEANUP_PENDING"),
                        message: result.failure?.message,
                durationUs: interrupted && result.durationUs == 0 ? nil : result.durationUs,
                        take: active)
                }
                let receipt = try JSONSerialization.data(withJSONObject: outcome)
                if notify && !serviceGone { await send(report: outcome) }
                return receipt
            } catch {
                if !discard, !serviceGone, !(error is CancellationError),
                    let report = try? transition("finalizing", finalizationError: CaptureFinalizationError(error)) {
                    await send(report: report)
                }
                throw error
            }
        }
        Task { @MainActor [weak self] in
            _ = await task.result
            self?.updateProgress?()
        }
        return task
    }

    private func interrupted(_ reason: CaptureFailure, recordingId: String, sourceId: String) async {
        if pendingStart?.recordingId == recordingId, pendingStart?.sourceId == sourceId {
            await awaitStart()
        }
        guard take?.recordingId == recordingId, take?.sourceId == sourceId else { return }
        _ = try? await finish(reason: reason.code, notify: true)
    }

    private func transition(_ state: String, reason: String? = nil, finalizationError: CaptureFinalizationError? = nil) throws -> [String: Any] {
        capture.note(state, reason: reason)
        return try report(state: state, reason: reason, finalizationError: finalizationError)
    }

    private func report(
        state: String, reason: String? = nil, message: String? = nil, durationUs: Int64? = nil, take existing: Take? = nil, finalizationError: CaptureFinalizationError? = nil
    ) throws -> [String: Any] {
        guard let take = existing ?? self.take else {
            throw CaptureFailure("INVALID_STATE", "No take is capturing.")
        }
        guard let sequence = capture.lifecycleSequence else {
            throw CaptureFailure(
                "JOURNAL_FAILED", "The take could not record its own transition.")
        }
        var report: [String: Any] = [
            "recordingId": take.recordingId, "sourceId": take.sourceId, "sequence": sequence,
            "state": state,
        ]
        if let publication = capture.publication, publication.sourceId == take.sourceId {
            report["publication"] = try publication.wireValue()
        }
        if let reason { report["reason"] = reason }
        if let message { report["message"] = String(decoding: message.utf16.prefix(4096), as: UTF16.self) }
        if state == "finalizing" {
            report["finalizationError"] = try finalizationError.map {
                try JSONSerialization.jsonObject(with: JSONEncoder().encode($0))
            } ?? NSNull()
        }
        if state == "complete" || state == "interrupted" {
            report["sourceDurationUs"] = durationUs as Any? ?? NSNull()
        }
        return report
    }

    /// Control for the take that is still starting waits for that start rather than answering
    /// that this session is not holding it: the service settles a take on that answer.
    private func expect(_ params: [String: Any]) async throws {
        guard let recordingId = params["recordingId"] as? String else {
            throw CaptureFailure("INVALID_REQUEST", "Capture control names its recording.")
        }
        if pendingStart?.recordingId == recordingId { await awaitStart() }
        guard let take, take.recordingId == recordingId else {
            throw CaptureFailure(
                "INVALID_STATE", "This app's capture session is not holding that take.")
        }
    }

    /// Waits for the start in flight, if there is one. It never outlives that start: every exit
    /// from `start` releases the waiters, whether the device began capturing or refused to.
    private func awaitStart() async {
        guard pendingStart != nil else { return }
        await withCheckedContinuation { startWaiters.append($0) }
    }

    private func releaseStart() {
        let waiting = startWaiters
        pendingStart = nil
        startWaiters.removeAll()
        for waiter in waiting { waiter.resume() }
    }

    /// Tells the library about a transition it did not ask for. The answer is awaited so a take
    /// that is being finalized is stored before the app stops reporting.
    private func send(report: [String: Any]) async {
        _ = try? await host?.call("capture.report", report)
    }
}
