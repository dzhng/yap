import Foundation

/**
 Everything the recording controls know, in one value. It holds no device, no catalog and no clock:
 service answers supply recording state; local fields hold selections and outstanding user
 requests, never a second recording lifecycle.
 */
public struct ControlsState: Equatable, Sendable {
    /// A fresh launch starts from the person's saved audio choices; no source is chosen yet.
    public init(recording: RecordingDefaults = RecordingDefaults()) {
        selection.microphone = recording.microphone
        selection.systemAudio = recording.systemAudio
    }

    /// Whether the service can carry an operation. Device and take are observations through the
    /// service, so once it cannot answer they describe nothing and are dropped rather than shown.
    public var service: ServiceState = .starting {
        didSet {
            guard service != .ready else { return }
            device = nil
            take = nil
        }
    }
    /// What the capture device reports about itself, once a status answer has arrived.
    public var device: DeviceStatus? {
        didSet { if let id = device?.recordingId { deviceReportedTake = id } }
    }
    /// The last take the device itself reported. Until it reports a take, the start's answer is
    /// all that says that take is live.
    private var deviceReportedTake: String?
    /// The take native or service recovery is finalizing, as the library holds it.
    public var take: TakeStatus?
    /// Read from native capture in this process, so it is known before the service is.
    public var permissions: Permissions?
    public var sources = SourceCatalog()
    public var selection = CaptureSelection()
    public var library = LibraryState()
    public var updates = UpdateControls()
    /// A message from the Yap team for this version, shown in the menu and in Settings.
    public var adminMessage: String?
    /// Whether this app is counting a take in before it starts. It belongs to the app rather than
    /// the service — no take exists yet — but the menu has to say so, because while it counts the
    /// only thing Start can mean is "never mind".
    public var counting = false
    public var storage: StorageObservation?
    public var storageRefreshing = false
    public var storageFailure: String?
    /// A failure belongs to its surface and request; only that request's success resolves it.
    public var failure: Failure?
    public struct Failure: Equatable, Sendable {
        public enum Scope: Equatable, Sendable { case capture, library }
        public enum Action: Equatable, Sendable {
            case start(StartRequest)
            case copyPrompt(MediaTarget?)
        }
        public let message: String
        public let scope: Scope
        public let request: String?
        public let action: Action?
        public init(_ message: String, scope: Scope = .capture, request: String? = nil, action: Action? = nil, operation: String? = nil) {
            let task: String? = switch operation {
            case "capture.start": "start recording"
            case "capture.stop": "finish recording"
            case "capture.pause": "pause recording"
            case "capture.resume": "resume recording"
            case "capture.cancel": "cancel recording"
            case "capture.restart": "restart recording"
            case "capture.setCamera": "change the camera"
            default: nil
            }
            self.message = task.map { "Couldn't \($0): \(message)" } ?? message
            self.scope = scope; self.request = request; self.action = action
        }
    }
    public mutating func observeAction(_ action: ControlsAction, failure message: String?, on scope: Failure.Scope) {
        if let message { failure = .init(message, scope: scope, request: action.id) }
        else { resolveFailure(request: action.id) }
    }
    public mutating func resolveFailure(request: String) {
        if failure?.request == request { failure = nil }
    }
    /// The action ids whose key combination this app could not claim, so nothing was stolen.
    public var unavailableShortcuts: [String] = []
    /// The start whose answer has not arrived: still in flight, or lost to a deadline.
    public private(set) var unansweredStart: StartRequest?
    /// Whether any source was ever selected. Only before then is a display offered by default.
    private var sourceWasSelected = false
    /// The start this app made for a take, under that take's ID.
    private var activeStart: ActiveStart?

    private struct ActiveStart: Equatable, Sendable {
        let recordingId: String
        let start: CaptureSelection.Start
    }

    public enum ServiceState: Equatable, Sendable {
        case starting
        case ready
        case unavailable(String)
    }

    public enum DeviceState: String, Equatable, Sendable {
        case idle, selecting, recording, paused, finalizing
    }

    public struct DeviceStatus: Equatable, Sendable {
        public init(state: DeviceState, recordingId: String?, elapsedUs: Int64?, camera: CameraStatus? = nil) {
            self.state = state
            self.recordingId = recordingId
            self.elapsedUs = elapsedUs
            self.camera = camera
        }
        public let state: DeviceState
        public let recordingId: String?
        /// The running take's playback time, as its own capture clock measures it.
        public let elapsedUs: Int64?
        /// The companion camera the running take reserved, and whether it is on now. Nil when the
        /// take reserved none (no access, no camera, or a camera-only take).
        public let camera: CameraStatus?
    }

    /// A companion camera's state, as `capture.start` asks for it and `capture.status` reports it.
    public enum CameraSwitch: String, Codable, Equatable, Sendable {
        case on, off
    }

    public struct CameraStatus: Decodable, Equatable, Sendable {
        public init(deviceId: String, state: CameraSwitch) {
            self.deviceId = deviceId
            self.state = state
        }
        public let deviceId: String
        public let state: CameraSwitch
    }

    public struct FinalizationError: Codable, Equatable, Sendable {
        public init(code: String, message: String, retryable: Bool) {
            self.code = code
            self.message = message
            self.retryable = retryable
        }
        public let code: String
        public let message: String
        public let retryable: Bool
    }

    public struct TakeStatus: Equatable, Sendable, Decodable {
        public init(
            id: String, state: String, interruptionReason: String?, sourceDurationUs: Int64?,
            finalizationError: FinalizationError? = nil, interruptionMessage: String? = nil, completionReason: String? = nil
        ) {
            self.id = id
            self.state = state
            self.interruptionReason = interruptionReason
            self.completionReason = completionReason
            self.interruptionMessage = interruptionMessage
            self.sourceDurationUs = sourceDurationUs
            self.finalizationError = finalizationError
        }
        public let id: String
        public let state: String
        public let interruptionReason: String?
        public let completionReason: String?
        public let interruptionMessage: String?
        public let sourceDurationUs: Int64?
        public let finalizationError: FinalizationError?
    }

    public struct Display: Equatable, Sendable {
        public init(id: Int, name: String, width: Int, height: Int, frame: CGRect? = nil) {
            self.id = id
            self.name = name
            self.width = width
            self.height = height
            self.frame = frame
        }
        public let id: Int
        public let name: String
        public let width: Int
        public let height: Int
        /// The display's global AppKit frame, when the native app has observed it. Source
        /// discovery supplies identity and dimensions; the app adds this geometry for pointer
        /// routed starts, while controls tests can inject it deterministically.
        public let frame: CGRect?
    }

    public struct Window: Equatable, Sendable {
        public init(id: Int, title: String, application: String) {
            self.id = id
            self.title = title
            self.application = application
        }
        public let id: Int
        public let title: String
        public let application: String
        /// What the chooser calls this window: its app, and its title when it has one.
        public var label: String {
            let named = title.trimmingCharacters(in: .whitespaces)
            if application.isEmpty { return named }
            return named.isEmpty ? application : "\(application) — \(named)"
        }
    }

    public struct Microphone: Equatable, Sendable {
        public init(id: String, name: String, isDefault: Bool) {
            self.id = id
            self.name = name
            self.isDefault = isDefault
        }
        public let id: String
        public let name: String
        public let isDefault: Bool
    }

    public struct Camera: Equatable, Sendable {
        public init(id: String, name: String, isDefault: Bool = false) {
            self.id = id
            self.name = name
            self.isDefault = isDefault
        }
        public let id: String
        public let name: String
        public let isDefault: Bool
    }

    public struct SourceCatalog: Equatable, Sendable {
        public init(
            displays: [Display] = [], windows: [Window] = [], microphones: [Microphone] = [], cameras: [Camera] = []
        ) {
            self.displays = displays
            self.windows = windows
            self.microphones = microphones
            self.cameras = cameras
        }
        public var displays: [Display]
        public var windows: [Window]
        public var microphones: [Microphone]
        public var cameras: [Camera]
    }

    /// A rectangle of one display, in that display's own points with a top-left origin: the same
    /// coordinates a capture start carries, so nothing converts them a second time.
    public struct Region: Equatable, Sendable {
        public init(displayId: Int, displayName: String, x: Double, y: Double, width: Double, height: Double) {
            self.displayId = displayId
            self.displayName = displayName
            self.x = x
            self.y = y
            self.width = width
            self.height = height
        }
        public let displayId: Int
        public let displayName: String
        public let x: Double
        public let y: Double
        public let width: Double
        public let height: Double
    }

    public enum SelectedSource: Equatable, Sendable {
        case display(Display)
        case window(Window)
        case region(Region)
        /// Camera mode requires a selected device.
        case camera
    }

    /// These takes are narrated, so a fresh launch has the microphone on and the machine's own
    /// sound off. `.systemDefault` follows whatever the person's default input is at start time.
    public enum MicrophoneChoice: Equatable, Sendable {
        case off
        case systemDefault
        case device(id: String, name: String)
    }

    public struct CaptureSelection: Equatable, Sendable {
        public init() {}
        public var source: SelectedSource?
        public var microphone: MicrophoneChoice = .systemDefault
        public var systemAudio = false
        /// The camera a person picked: a camera-only take's source, or a screen take's companion.
        /// Nil follows the system default.
        public var cameraDeviceId: String?
        /// Whether a screen take's companion camera starts on. Off still reserves the camera, so it
        /// can be turned on during the take.
        public var cameraOn = false
        /// The microphone this person chose, while it is unplugged. Takes use the system default
        /// meanwhile, but the choice is theirs and is not thrown away — nor written over their
        /// saved preference — by the machine they happen to be recording on today.
        public var awaitedMicrophone: MicrophoneChoice?
    }

    public struct RecentTake: Equatable, Sendable, Decodable {
        public init(
            id: String, createdAt: String, state: String, sourceDurationUs: Int64?,
            interruptionReason: String?, finalizationError: FinalizationError? = nil,
            sourceId: String? = nil, sourceAdmissions: [LibraryState.SourceAdmission]? = nil
        ) {
            self.sourceAdmissions = sourceAdmissions
            self.sourceId = sourceId
            self.id = id
            self.createdAt = createdAt
            self.state = state
            self.sourceDurationUs = sourceDurationUs
            self.interruptionReason = interruptionReason
            self.finalizationError = finalizationError
        }
        public let id: String
        public let createdAt: String
        public let sourceId: String?
        public let sourceAdmissions: [LibraryState.SourceAdmission]?
        public let state: String
        public let sourceDurationUs: Int64?
        public let interruptionReason: String?
        public let finalizationError: FinalizationError?
    }

    public struct StorageObservation: Equatable, Sendable, Decodable {
        public init(totalBytes: Int64, modelBytes: Int64, observedAt: String) {
            self.totalBytes = totalBytes
            self.modelBytes = modelBytes
            self.observedAt = observedAt
        }
        public let totalBytes: Int64
        /// The part of the total that is prepared models, so media and models read apart.
        public let modelBytes: Int64
        public let observedAt: String
    }

    /// The take whose closed inputs no longer appear in capture status.
    public var takeNeedingResolution: String? {
        guard let take, !["complete", "interrupted", "canceled"].contains(take.state) else { return nil }
        return take.id
    }

    /// Returns whether a newly observed interruption needs the person's attention.
    @discardableResult
    public mutating func observeTake(_ observed: TakeStatus?) -> Bool {
        guard let observed else { return false }
        let newlyInterrupted = observed.state == "interrupted"
            && (take?.id != observed.id || take?.state != "interrupted")
        take = observed
        return newlyInterrupted
    }

    /// A confirmed deletion cannot keep controls attached to the missing take.
    public mutating func takeWasDeleted(_ recordingId: String) {
        if take?.id == recordingId { take = nil }
    }

    /// Native acquisition and service recovery both retain a take until finalization settles.
    public var isLive: Bool {
        if take?.state == "finalizing" { return true }
        guard let device else { return false }
        return device.state == .recording || device.state == .paused || device.state == .selecting || device.state == .finalizing
    }

    /// Whether the ink is up: while the device records or pauses, and from the moment a start
    /// answers that its take is live, since marks come straight from the capture and can arrive
    /// before a status read says the device is recording. Once the device has reported a take it
    /// alone decides, so a stopped take's ink comes down while the stored take still says recording.
    public var showsInk: Bool {
        if device?.state == .recording || device?.state == .paused { return true }
        guard let take, take.id != deviceReportedTake else { return false }
        return take.state == "recording" || take.state == "paused"
    }

    /// The source owned by the live take, retained before the next catalog poll can refresh the
    /// menu selection. A restart must use this identity when a hotkey chose another display. It
    /// belongs to one take: a later take, however it was started, restarts on its own selection.
    public var restartStart: CaptureSelection.Start? {
        if let activeStart, activeStart.recordingId == device?.recordingId { return activeStart.start }
        return start()
    }
}

extension ControlsState.CaptureSelection {
    /// What a start asks the service for, in the shape the service states a running take's
    /// selection. The protocol owns both audio defaults, so this always states both explicitly, and
    /// the microphone is on unless a person turned it off.
    public struct Start: Equatable, Sendable, Codable {
        public init(
            source: Source, microphone: Bool, microphoneDeviceId: String?, systemAudio: Bool,
            cameraDeviceId: String? = nil, cameraAtStart: ControlsState.CameraSwitch? = nil
        ) {
            self.source = source
            self.microphone = microphone
            self.microphoneDeviceId = microphoneDeviceId
            self.systemAudio = systemAudio
            self.cameraDeviceId = cameraDeviceId
            self.cameraAtStart = cameraAtStart
        }

        public let source: Source
        public let microphone: Bool
        public let microphoneDeviceId: String?
        public let systemAudio: Bool
        /// A screen take's reserved companion camera.
        public let cameraDeviceId: String?
        /// Whether that camera starts on; absent means on.
        public let cameraAtStart: ControlsState.CameraSwitch?

        public enum Source: Equatable, Sendable, Codable {
            case display(id: Int)
            case window(id: Int)
            case region(displayId: Int, x: Double, y: Double, width: Double, height: Double)
            case camera(id: String)

            private enum CodingKeys: String, CodingKey {
                case kind, id, displayId, x, y, width, height
            }

            public init(from decoder: Decoder) throws {
                let fields = try decoder.container(keyedBy: CodingKeys.self)
                switch try fields.decode(String.self, forKey: .kind) {
                case "display": self = .display(id: try fields.decode(Int.self, forKey: .id))
                case "window": self = .window(id: try fields.decode(Int.self, forKey: .id))
                case "camera": self = .camera(id: try fields.decode(String.self, forKey: .id))
                case "region":
                    self = .region(
                        displayId: try fields.decode(Int.self, forKey: .displayId),
                        x: try fields.decode(Double.self, forKey: .x),
                        y: try fields.decode(Double.self, forKey: .y),
                        width: try fields.decode(Double.self, forKey: .width),
                        height: try fields.decode(Double.self, forKey: .height))
                default:
                    throw DecodingError.dataCorruptedError(
                        forKey: .kind, in: fields, debugDescription: "Unknown capture source")
                }
            }

            public func encode(to encoder: Encoder) throws {
                var fields = encoder.container(keyedBy: CodingKeys.self)
                switch self {
                case .display(let id):
                    try fields.encode("display", forKey: .kind)
                    try fields.encode(id, forKey: .id)
                case .window(let id):
                    try fields.encode("window", forKey: .kind)
                    try fields.encode(id, forKey: .id)
                case .camera(let id):
                    try fields.encode("camera", forKey: .kind)
                    try fields.encode(id, forKey: .id)
                case .region(let displayId, let x, let y, let width, let height):
                    try fields.encode("region", forKey: .kind)
                    try fields.encode(displayId, forKey: .displayId)
                    try fields.encode(x, forKey: .x)
                    try fields.encode(y, forKey: .y)
                    try fields.encode(width, forKey: .width)
                    try fields.encode(height, forKey: .height)
                }
            }
        }
    }

}

extension ControlsState {
    public enum StartOrigin: Equatable, Sendable {
        case menu
        case hotkey(pointer: CGPoint)
    }

    /// What a start of the current selection asks for; nil until a source is selected.
    ///
    /// A screen take reserves a companion camera whenever camera access is granted: the picked
    /// camera, or the system default. It starts on or off as the switch says, and can be turned
    /// on later either way. Without access nothing is reserved, unless the switch is on: a camera
    /// a person asked for is still asked for, so the refusal names the missing permission.
    public func start(origin: StartOrigin = .menu) -> CaptureSelection.Start? {
        let selectedSource: SelectedSource?
        switch origin {
        case .menu:
            selectedSource = selection.source
        case .hotkey(let pointer):
            selectedSource = display(under: pointer).map { .display($0) }
        }
        guard let source = selectedSource else { return nil }
        let chosen: CaptureSelection.Start.Source
        switch source {
        case .display(let display): chosen = .display(id: display.id)
        case .window(let window): chosen = .window(id: window.id)
        case .camera:
            guard let deviceId = selection.cameraDeviceId, !deviceId.isEmpty else { return nil }
            chosen = .camera(id: deviceId)
        case .region(let region):
            chosen = .region(displayId: region.displayId, x: region.x, y: region.y,
                width: region.width, height: region.height)
        }
        let reserves = source != .camera && cameraAvailable && (permissions?.camera == .granted || selection.cameraOn)
        let companion = reserves ? selection.cameraDeviceId ?? defaultCamera : nil
        let cameraAtStart: CameraSwitch? = companion == nil ? nil : selection.cameraOn ? .on : .off
        let microphoneDeviceId: String?
        if case .device(let id, _) = selection.microphone { microphoneDeviceId = id } else { microphoneDeviceId = nil }
        return .init(
            source: chosen, microphone: selection.microphone != .off && microphoneAvailable,
            microphoneDeviceId: microphoneAvailable ? microphoneDeviceId : nil,
            systemAudio: selection.systemAudio, cameraDeviceId: companion, cameraAtStart: cameraAtStart)
    }

    /// Picks the display containing a pointer, falling back to the nearest display when the
    /// pointer is on a boundary or in the gap between displays. Catalog order is the final tie
    /// break, keeping an injected catalog deterministic.
    private func display(under pointer: CGPoint) -> Display? {
        sources.displays.enumerated().min { left, right in
            let leftContains = left.element.frame?.contains(pointer) == true
            let rightContains = right.element.frame?.contains(pointer) == true
            if leftContains != rightContains { return leftContains }
            let leftDistance = left.element.frame.map { distance(from: pointer, to: $0) } ?? .greatestFiniteMagnitude
            let rightDistance = right.element.frame.map { distance(from: pointer, to: $0) } ?? .greatestFiniteMagnitude
            if leftDistance != rightDistance { return leftDistance < rightDistance }
            return left.offset < right.offset
        }?.element
    }

    private func distance(from point: CGPoint, to rect: CGRect) -> CGFloat {
        let dx = max(rect.minX - point.x, 0, point.x - rect.maxX)
        let dy = max(rect.minY - point.y, 0, point.y - rect.maxY)
        return hypot(dx, dy)
    }

    /// The camera the system prefers, or the first listed.
    private var defaultCamera: String? {
        (sources.cameras.first(where: \.isDefault) ?? sources.cameras.first)?.id
    }

    /// The request a live toggle sends, `capture.setCamera`'s parameters.
    public struct SetCamera: Encodable, Equatable, Sendable {
        public init(recordingId: String, on: Bool) {
            self.recordingId = recordingId
            self.on = on
        }
        public let recordingId: String
        public let on: Bool
    }

    /// Turns the camera on or off, from the menu's switch or the floating controls alike. Before
    /// a take this is the start switch, and the picked camera stays picked. During a take that
    /// reserved a camera it is a request for the service, returned for the caller to send.
    public mutating func setCamera(_ on: Bool) -> SetCamera? {
        if isLive {
            guard device?.camera != nil, let recordingId = device?.recordingId else {
                failure = .init("This take has no camera to turn on or off.")
                return nil
            }
            return .init(recordingId: recordingId, on: on)
        }
        guard !counting, selection.source != .camera else { return nil }
        selection.cameraOn = on
        return nil
    }
}

extension ControlsState.CaptureSelection {
    /// A live take owns its selection, including when another client started it. Catalog labels
    /// are presentation only; absent labels must never replace the device's source identity.
    public mutating func apply(_ active: Start, catalog: ControlsState.SourceCatalog) {
        switch active.source {
        case .camera: source = .camera
        case .display(let id):
            source = .display(catalog.displays.first { $0.id == id }
                ?? .init(id: id, name: "Display \(id)", width: 0, height: 0))
        case .window(let id):
            source = .window(catalog.windows.first { $0.id == id }
                ?? .init(id: id, title: "Window \(id)", application: ""))
        case .region(let id, let x, let y, let width, let height):
            source = .region(.init(
                displayId: id, displayName: catalog.displays.first { $0.id == id }?.name ?? "Display \(id)",
                x: x, y: y, width: width, height: height))
        }
        if !active.microphone { microphone = .off }
        else if let id = active.microphoneDeviceId {
            microphone = .device(id: id, name: catalog.microphones.first { $0.id == id }?.name ?? id)
        } else { microphone = .systemDefault }
        systemAudio = active.systemAudio
        if case .camera(let deviceId) = active.source { cameraDeviceId = deviceId }
        else { cameraDeviceId = active.cameraDeviceId }
        cameraOn = active.cameraDeviceId != nil && active.cameraAtStart != .off
    }
}

extension ControlsState {
    /// Takes a fresh catalog, keeping the selection to what still exists.
    public mutating func observeSources(_ catalog: SourceCatalog) {
        sources = catalog
        if let lost = reconcileSelection(), failure == nil { failure = .init(lost) }
        // Until a person picks a camera, the system's preferred one is picked. Picking never turns
        // the camera on: the switch alone does that.
        if selection.cameraDeviceId == nil, let preferred = defaultCamera { selection.cameraDeviceId = preferred }
    }

    /// Picks which camera the switch turns on, leaving the switch as it is.
    public mutating func chooseCamera(_ id: String) {
        guard sources.cameras.contains(where: { $0.id == id }) else { return }
        selection.cameraDeviceId = id
    }

    /// A Mac with no camera, or no microphone, has nothing for that switch to turn on: it shows
    /// off and disabled, and a take records without it.
    public var cameraAvailable: Bool { !sources.cameras.isEmpty }
    public var microphoneAvailable: Bool { !sources.microphones.isEmpty }

    /// A camera-only take needs a camera to record; a screen take never waits for one.
    public var cameraBlocksStart: Bool { selection.source == .camera && selection.cameraDeviceId == nil }

    /// A catalog read that failed says nothing about which sources exist, so the last catalog and
    /// the selection stand. Absent screen authorization is a successful catalog with empty
    /// screen choices; cameras and microphones are discovered independently.
    public mutating func sourcesUnavailable(description: String) {
        if failure == nil || failure?.request == "capture.sources" {
            failure = .init(description, request: "capture.sources")
        }
    }

    /// Refreshes labels by identity: a browser navigation changes a title without closing its
    /// window. Until anything was ever selected, the first display is offered. A selected source
    /// that disappears is dropped and said so, and never replaced by a guess, so a shortcut cannot
    /// record something nobody chose.
    private mutating func reconcileSelection() -> String? {
        if selection.source != nil { sourceWasSelected = true }
        var failure: String?
        switch selection.source {
        case .display(let selected):
            selection.source = sources.displays.first { $0.id == selected.id }.map { .display($0) }
            if selection.source == nil { failure = "\(selected.name) is no longer available." }
        case .window(let selected):
            selection.source = sources.windows.first { $0.id == selected.id }.map { .window($0) }
            if selection.source == nil { failure = "That window has closed, so it is no longer selected." }
        case .region(let chosen) where !sources.displays.contains(where: { $0.id == chosen.displayId }):
            selection.source = nil
            failure = "\(chosen.displayName) is no longer available."
        case nil where !sourceWasSelected:
            selection.source = sources.displays.first.map { .display($0) }
        default: break
        }
        if case .device(let id, _) = selection.microphone,
            !sources.microphones.contains(where: { $0.id == id }) {
            selection.awaitedMicrophone = selection.microphone
            selection.microphone = .systemDefault
        }
        // Plugged back in, it is theirs again without their having to choose it a second time.
        if case .device(let id, _) = selection.awaitedMicrophone,
            let back = sources.microphones.first(where: { $0.id == id }) {
            selection.microphone = .device(id: back.id, name: back.name)
            selection.awaitedMicrophone = nil
        }
        return failure
    }
}

extension ControlsState {
    /// One request to start a take, under the ID the service allocates that take against.
    public struct StartRequest: Equatable, Sendable {
        public let requestId: String
        public let start: CaptureSelection.Start
        public let origin: StartOrigin
        /// Whether this asks again for a start whose answer had not arrived.
        public let repeatsUnanswered: Bool
    }

    /// What a start's answer means for the person who asked for it.
    public enum StartAnswer: Equatable, Sendable {
        /// The take it names is on the device.
        case live
        /// The take it names has already ended.
        case ended
        /// Refused: no take is left for this request to resolve.
        case refused
        /// No answer: a deadline, a stopped service, or a start the service has not proved yet.
        case unanswered

        public init(recordingState: String) {
            self = ["complete", "interrupted", "canceled"].contains(recordingState) ? .ended : .live
        }

        public init(failureCode: String) {
            let unanswered = ["TIMEOUT", "SERVICE_STOPPED", "UNRESOLVED_START"]
            self = unanswered.contains(failureCode) ? .unanswered : .refused
        }
    }

    /// The request for a start of the current selection, or nil with the reason when there is none.
    /// A start whose answer has not arrived is asked for again under its own request ID, so the
    /// service resolves the take it already allocated instead of allocating another.
    public mutating func beginStart(
        newRequestId: String, origin: StartOrigin = .menu, retrying: StartRequest? = nil
    ) -> StartRequest? {
        guard let start = retrying?.start ?? self.start(origin: origin) else {
            failure = .init("Choose a source before recording.")
            return nil
        }
        if let unansweredStart, unansweredStart.start == start {
            let replay = StartRequest(
                requestId: unansweredStart.requestId, start: start, origin: unansweredStart.origin,
                repeatsUnanswered: true)
            self.unansweredStart = replay
            return replay
        }
        if case .camera(let selected) = start.source {
            guard sources.cameras.contains(where: { $0.id == selected }) else {
                failure = .init("Choose an available camera before recording.")
                return nil
            }
        }
        let request = StartRequest(
            requestId: newRequestId, start: start, origin: retrying?.origin ?? origin, repeatsUnanswered: false)
        unansweredStart = request
        return request
    }

    /// Settles a start with its answer, and says whether the person's start still needs a new
    /// request: a repeated request that resolves to a take that already ended has settled the lost
    /// start, but recorded nothing for this one.
    public mutating func finishStart(_ request: StartRequest, _ answer: StartAnswer) -> Bool {
        guard answer != .unanswered else { return false }
        if unansweredStart?.requestId == request.requestId { unansweredStart = nil }
        // The answer's take has just been observed, so it names the take this start made.
        if answer == .live, let recordingId = take?.id { activeStart = ActiveStart(recordingId: recordingId, start: request.start) }
        else if answer == .refused || (answer == .ended && request.repeatsUnanswered) { activeStart = nil }
        return answer == .ended && request.repeatsUnanswered
    }

    /// A restart replaces the take under a new ID; the start it was made from moves to that take.
    public mutating func restarted(recordingId: String, start: CaptureSelection.Start) {
        activeStart = ActiveStart(recordingId: recordingId, start: start)
    }
}

/// Effective updater facts observed by the controls; Sparkle owns their persistence.
public struct UpdateControls: Equatable, Sendable {
    public init(available: Bool = false, enabled: Bool = false, status: String? = nil, canCheck: Bool = false) {
        self.available = available
        self.enabled = enabled
        self.status = status
        self.canCheck = canCheck
    }
    public var available: Bool
    public var enabled: Bool
    public var status: String?
    public var canCheck: Bool
}
