@preconcurrency import AVFoundation
import CoreGraphics
import Foundation
@preconcurrency import ScreenCaptureKit

/// Explicit internal selection. Source allocation and public request admission are separate gates.
package struct CaptureCameraSelection {
    package let id: String
    package let directory: URL
    package let observations: URL
    package let binding: CameraCaptureBinding?
    /// Whether the camera is on when the take starts; off reserves it without opening the device.
    package let startsOn: Bool
    package init(id: String, directory: URL, observations: URL, binding: CameraCaptureBinding? = nil, startsOn: Bool = true) {
        self.id = id; self.directory = directory; self.observations = observations; self.binding = binding
        self.startsOn = startsOn
    }
}

extension CaptureCameraRequest {
    /// The companion camera this request reserves, as a take prepares it.
    package var selection: CaptureCameraSelection {
        let directory = URL(fileURLWithPath: outputDirectory)
        return CaptureCameraSelection(id: binding.deviceId, directory: directory,
            observations: directory.appendingPathComponent(CameraMedia.mappingFile), binding: binding,
            startsOn: startsOn)
    }
}

/// Probe orchestration controls; ordinary capture retains device cadence and cursor sampling.
@MainActor
package struct CameraCaptureMeasurement {
    package var framesPerSecond: Int? = nil
    package var samplesCursor = true
    package var beforeStart: @MainActor () async throws -> Bool = { true }
    package init(framesPerSecond: Int? = nil, samplesCursor: Bool = true,
        beforeStart: @escaping @MainActor () async throws -> Bool = { true }) {
        self.framesPerSecond = framesPerSecond; self.samplesCursor = samplesCursor; self.beforeStart = beforeStart
    }
}

@MainActor
package protocol CaptureCameraDevice {
    var id: String { get }
    func makeSession(framesPerSecond: Int?, microphone: AVCaptureDevice?) throws -> any CaptureCameraSession
}

@MainActor
package protocol CaptureCameraSession: AnyObject, Sendable {
    var width: Int { get }
    var height: Int { get }
    nonisolated var synchronizationClock: CMClockOrTimebase? { get }
    func start(ingress: CaptureClockIngress) async throws
    func observeDeviceLoss(onFailure: @escaping @Sendable (CaptureFailure) -> Void)
    func stop() async -> CaptureFailure?
}

/// Permission and exact selection precede session creation. Only the selected descriptor opens IO.
@MainActor
package struct CaptureInputPreparation {
    package init() {}
    package var requireScreenAuthorization: @MainActor (CaptureRequest) throws -> Void = ScreenCaptureInput.requireAuthorization
    package var prepareScreen: @MainActor (CaptureRequest) async throws -> any CaptureInputSession = { try await ScreenCaptureInput.prepare($0) }
    package var cameraAuthorized: @MainActor () -> Bool = { NativeCapture.cameraPermission == "authorized" }
    package var cameras: @MainActor () -> [any CaptureCameraDevice] = { NativeCapture.cameraCandidates().map { NativeCameraDevice($0) } }

    package func prepare(_ request: CaptureRequest, camera: CaptureCameraSelection? = nil,
        measurement: CameraCaptureMeasurement = .init(),
        checkInterruption: @MainActor () throws -> Void) async throws -> any CaptureInputSession {
        try checkInterruption()
        if request.source.kind == "camera" {
            guard camera == nil, request.camera == nil, let id = request.source.deviceID, !id.isEmpty,
                measurement.framesPerSecond.map({ $0 > 0 && $0 <= Int(Int32.max) }) ?? true else {
                throw CaptureFailure("INVALID_REQUEST", "Primary camera requires one explicit device and no companion camera.")
            }
            guard cameraAuthorized() else {
                throw CaptureFailure("CAMERA_PERMISSION_REQUIRED", "Camera access must already be authorized. No permission was requested automatically.")
            }
            let microphone: AVCaptureDevice?
            if request.microphone {
                guard NativeCapture.microphonePermission == "authorized" else {
                    throw CaptureFailure("MICROPHONE_PERMISSION_REQUIRED", "Microphone access must already be authorized.")
                }
                microphone = request.microphoneDeviceID.flatMap { id in NativeCapture.microphoneCandidates().first { $0.uniqueID == id } }
                    ?? (request.microphoneDeviceID == nil ? AVCaptureDevice.default(for: .audio) : nil)
                guard microphone != nil else { throw CaptureFailure("SOURCE_UNAVAILABLE", "The selected microphone is unavailable.") }
            } else { microphone = nil }
            if request.systemAudio { try requireScreenAuthorization(request) }
            guard let selected = cameras().first(where: { $0.id == id }) else {
                throw CaptureFailure("SOURCE_UNAVAILABLE", "The selected camera is unavailable.")
            }
            let session = try selected.makeSession(framesPerSecond: measurement.framesPerSecond, microphone: microphone)
            return PrimaryCameraCaptureInput(camera: session, systemAudio: request.systemAudio)
        }
        guard let camera else { return try await prepareScreen(request) }
        guard !camera.id.isEmpty,
            measurement.framesPerSecond.map({ $0 > 0 && $0 <= Int(Int32.max) }) ?? true else {
            throw CaptureFailure("INVALID_REQUEST", "Camera selection and measurement cadence must be valid.")
        }
        try camera.binding?.validate()
        guard camera.binding.map({ $0.deviceId == camera.id }) ?? true else {
            throw CaptureFailure("INVALID_REQUEST", "Camera binding differs from the selected device.")
        }
        try requireScreenAuthorization(request)
        let selected = try companionCamera(camera.id)
        let screen = try await prepareScreen(request)
        do {
            try Task.checkCancellation(); try checkInterruption()
            // A camera that starts off is reserved, not opened. One that starts on is opened here,
            // so a camera that cannot open refuses the take before any output exists.
            let opened = camera.startsOn
                ? try selected.makeSession(framesPerSecond: measurement.framesPerSecond, microphone: nil) : nil
            return CameraCaptureInput(primary: screen, selection: camera, measurement: measurement,
                devices: self, opened: opened)
        } catch {
            _ = await screen.stop()
            await screen.discardMedia()
            throw error
        }
    }

    /// A companion camera may be opened only while access is authorized and the device is present.
    func companionCamera(_ id: String) throws -> any CaptureCameraDevice {
        guard cameraAuthorized() else {
            throw CaptureFailure("CAMERA_PERMISSION_REQUIRED", "Camera access must already be authorized. No permission was requested automatically.")
        }
        guard let selected = cameras().first(where: { $0.id == id }) else {
            throw CaptureFailure("SOURCE_UNAVAILABLE", "The selected camera is unavailable.")
        }
        return selected
    }
}

/// Camera pictures and optional narration share the AV session clock and ordinary primary writer.
@MainActor
private final class PrimaryCameraCaptureInput: CaptureInputSession {
    private let camera: any CaptureCameraSession
    private let systemAudio: Bool
    private let acquisition = CaptureStreamInputs()
    private var ingress: CaptureClockIngress?
    private var audioDelegate: CaptureStreamDelegate?
    private var observing = false
    var width: Int { camera.width }
    var height: Int { camera.height }
    let requestedSourceRect: CGRect? = nil
    var previewFrame: (@Sendable (NativeCapture.CameraPreviewFrame) -> Void)?
    init(camera: any CaptureCameraSession, systemAudio: Bool) { self.camera = camera; self.systemAudio = systemAudio }
    func start(writer: CaptureWriter, output: any SCStreamOutput, framesPerSecond: Int?,
        onFailure: @escaping @Sendable (CaptureFailure) -> Void, checkInterruption: @escaping @MainActor () throws -> Void) async throws {
        let ingress = try CaptureClockIngress(writer: writer, destination: .primary(width: width, height: height), failure: onFailure)
        self.ingress = ingress
        ingress.previewFrame = previewFrame
        ingress.captureSessionClock = { [camera] in camera.synchronizationClock }
        var operations = [CaptureStreamOperation(start: { [self] in
            observeDeviceLoss(onFailure: onFailure)
            try await camera.start(ingress: ingress)
        },
            stop: { [camera] in if let failure = await camera.stop() { throw failure } })]
        if systemAudio {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            try Task.checkCancellation(); try checkInterruption()
            let delegate = CaptureStreamDelegate(onFailure: onFailure)
            audioDelegate = delegate
            let stream = try WholeSystemAudioCapture.stream(content: content, output: ingress, queue: writer.queue, delegate: delegate)
            operations.append(CaptureStreamOperation(start: { try await stream.startCapture() }, stop: { try await stream.stopCapture() }))
        }
        try await acquisition.start(operations, checkInterruption: checkInterruption)
    }
    func startCursorSampling(writer: CaptureWriter) {}
    func observeDeviceLoss(onFailure: @escaping @Sendable (CaptureFailure) -> Void) {
        guard !observing else { return }; observing = true
        camera.observeDeviceLoss(onFailure: onFailure)
    }
    func stop() async -> CaptureFailure? {
        let failure = await acquisition.stop().value
        if let ingress { ingress.writer.queue.sync {} }
        audioDelegate = nil
        return failure
    }
    func closeMedia(clock: CaptureClock, failure: CaptureFailure?) async -> CaptureInputClosure {
        do { try ingress?.close(); return CaptureInputClosure() }
        catch { return CaptureInputClosure(failure: CaptureFailure("WRITE_FAILED", error.localizedDescription)) }
    }
    func discardMedia() async { try? ingress?.close() }
}

/// One acquisition/ingress owner; NativeCapture owns termination, closed media and publication.
/// The companion camera is reserved for the whole take but opened only while it is on: each
/// turn-on opens a new session on the device and each turn-off releases it.
@MainActor
package final class CameraCaptureInput: CaptureInputSession, CompanionCameraSwitch {
    private let primary: any CaptureInputSession
    private let selection: CaptureCameraSelection
    private let measurement: CameraCaptureMeasurement
    private let devices: CaptureInputPreparation
    /// Opened by preparation for a camera that starts on; the first turn-on uses it.
    private var opened: (any CaptureCameraSession)?
    /// The session acquiring now; nil while the camera is off.
    private var session: (any CaptureCameraSession)?
    private var ingress: CaptureClockIngress?
    private var onFailure: (@Sendable (CaptureFailure) -> Void)?
    private var observing = false
    /// The last switch requested; the next one, stop and discard wait for it.
    private var switching: Task<Void, Never>?
    private var ended = false
    /// Whether the camera is meant to be on: from the start or the last accepted turn-on, until
    /// the person turns it off. A camera meant on at stop that recorded nothing is `NO_CAMERA`.
    private var meantOn: Bool
    package var deviceId: String { selection.id }
    package var isOn: Bool { session != nil }
    package var companionCamera: (any CompanionCameraSwitch)? { self }
    package var width: Int { primary.width }
    package var height: Int { primary.height }
    package var requestedSourceRect: CGRect? { primary.requestedSourceRect }
    package var previewFrame: (@Sendable (NativeCapture.CameraPreviewFrame) -> Void)? {
        get { primary.previewFrame }
        set { primary.previewFrame = newValue }
    }

    init(primary: any CaptureInputSession, selection: CaptureCameraSelection, measurement: CameraCaptureMeasurement,
        devices: CaptureInputPreparation, opened: (any CaptureCameraSession)?) {
        self.primary = primary; self.selection = selection; self.measurement = measurement
        self.devices = devices; self.opened = opened; meantOn = selection.startsOn
    }
    package func start(writer: CaptureWriter, output: any SCStreamOutput, framesPerSecond: Int?,
        onFailure: @escaping @Sendable (CaptureFailure) -> Void, checkInterruption: @escaping @MainActor () throws -> Void) async throws {
        let cameraWriter = try CameraWriter(directory: selection.directory,
            framesPerSecond: measurement.framesPerSecond ?? 30, binding: selection.binding)
        if !selection.startsOn { cameraWriter.stopAcquiring(atHostUs: CaptureHostTime.nowUs()) }
        cameraWriter.runEnded = { [weak self] reason in Task { @MainActor in self?.endRun(reason) } }
        let ingress = try CaptureClockIngress(writer: writer, destination: .companion(cameraWriter),
            observations: selection.binding == nil ? selection.observations : selection.directory.appendingPathComponent(CameraMedia.mappingFile),
            failure: onFailure)
        self.ingress = ingress
        self.onFailure = onFailure
        ingress.previewFrame = previewFrame
        observeDeviceLoss(onFailure: onFailure)
        try await primary.start(writer: writer, output: ingress,
            framesPerSecond: measurement.framesPerSecond, onFailure: onFailure, checkInterruption: checkInterruption)
        try checkInterruption()
        guard selection.startsOn, try await measurement.beforeStart() else { return }
        try Task.checkCancellation(); try checkInterruption()
        // Startup is fenced by NativeCapture's generation, so this turn-on is not joined: a stop
        // during startup stops the session it is opening.
        try await turnOn()
        try Task.checkCancellation(); try checkInterruption()
    }
    package func setOn(_ on: Bool) async throws {
        let previous = switching
        let change = Task { @MainActor [self] in
            await previous?.value
            guard !ended else { throw CaptureFailure("INVALID_STATE", "The take has stopped capturing.") }
            if on, session == nil {
                try await turnOn()
                // A stop or discard while the session was starting cancels this turn-on. Its
                // session is released and the camera closes as if it had never been asked.
                if ended, let session {
                    throw Self.refusal(CaptureFailure("INVALID_STATE", "The take stopped while the camera was turning on."),
                        released: await turnOff(session), by: "cancelled turn-on")
                }
                meantOn = true
            }
            if !on, let session {
                let released = await turnOff(session)
                meantOn = false
                if let released { throw Self.refusal(nil, released: released, by: "turn-off") }
            }
        }
        switching = Task { _ = await change.result }
        try await change.value
    }
    /// The writer refused a picture that cannot join this take and closed the acquisition window.
    /// Turns the camera off after any switch in flight; the take keeps recording. A turn-on that
    /// reopened the window since then keeps its session.
    private func endRun(_ reason: CaptureFailure) {
        let previous = switching
        let change = Task { @MainActor [self] in
            await previous?.value
            guard !ended, let session, let camera = ingress?.companion,
                !ingress!.writer.queue.sync(execute: { camera.isAcquiring }) else { return }
            Self.diagnose("camera off: cause=incompatible picture; code=\(reason.code); message=\(reason.message)")
            let released = await turnOff(session)
            meantOn = false
            if let released { _ = Self.refusal(reason, released: released, by: "incompatible picture") }
        }
        switching = Task { await change.value }
    }
    /// Opens a new session on the reserved device. Any refusal leaves the camera off.
    private func turnOn() async throws {
        guard let ingress, let camera = ingress.companion else { throw CaptureFailure("INVALID_STATE", "The take is not capturing.") }
        let device = opened == nil ? try devices.companionCamera(selection.id) : nil
        ingress.writer.queue.sync { camera.startAcquiring(atHostUs: CaptureHostTime.nowUs()) }
        var starting: (any CaptureCameraSession)?
        do {
            let fresh = try opened ?? device!.makeSession(framesPerSecond: measurement.framesPerSecond, microphone: nil)
            opened = nil
            guard ingress.writer.queue.sync(execute: { camera.admits(width: fresh.width, height: fresh.height) }) else {
                throw CaptureFailure("CAMERA_FORMAT_CHANGED", "The camera now delivers a different picture size than earlier in this take.")
            }
            ingress.writer.queue.sync { ingress.captureSessionClock = { [fresh] in fresh.synchronizationClock } }
            session = fresh; starting = fresh
            if let onFailure { fresh.observeDeviceLoss(onFailure: onFailure) }
            try await fresh.start(ingress: ingress)
        } catch {
            ingress.writer.queue.sync { camera.stopAcquiring(atHostUs: CaptureHostTime.nowUs()) }
            // A stop during startup has already taken and stopped this session.
            if let starting, session === starting {
                session = nil
                if let released = await starting.stop() {
                    throw Self.refusal(error as? CaptureFailure ?? CaptureFailure(bounded: error),
                        released: released, by: "failed turn-on")
                }
            }
            throw error
        }
    }
    /// Closes acquisition before the session stops, so nothing recorded crosses the turn-off.
    /// Returns what releasing the session reported.
    private func turnOff(_ current: any CaptureCameraSession) async -> CaptureFailure? {
        if let ingress, let camera = ingress.companion {
            ingress.writer.queue.sync { camera.stopAcquiring(atHostUs: CaptureHostTime.nowUs()) }
        }
        session = nil
        return await current.stop()
    }
    /// A release that fails during a take belongs to the toggle that released the session: it is
    /// logged and reported on that toggle's call, never as the take's failure. The toggle's own
    /// refusal, if it has one, keeps its code and names the release failure too.
    private static func refusal(_ cause: CaptureFailure?, released: CaptureFailure?, by toggle: String) -> CaptureFailure {
        guard let released else { return cause! }
        diagnose("camera release: toggle=\(toggle); code=\(released.code); message=\(released.message)")
        guard let cause else { return released }
        return CaptureFailure(cause.code, "\(cause.message) Releasing the camera also failed (\(released.code)): \(released.message)")
    }
    private static func diagnose(_ line: String) { FileHandle.standardError.write(Data("\(line)\n".utf8)) }
    package func startCursorSampling(writer: CaptureWriter) {
        if measurement.samplesCursor { primary.startCursorSampling(writer: writer) }
    }
    package func observeDeviceLoss(onFailure: @escaping @Sendable (CaptureFailure) -> Void) {
        guard !observing else { return }
        observing = true
        primary.observeDeviceLoss(onFailure: onFailure)
    }
    package func stop() async -> CaptureFailure? {
        ended = true
        await switching?.value
        // The end-of-take release: a camera still open at stop fails the take if it cannot be released.
        var releaseFailure: CaptureFailure?
        for open in [session, opened].compactMap({ $0 }) {
            let failure = await open.stop()
            releaseFailure = releaseFailure ?? failure
        }
        session = nil; opened = nil
        let primaryFailure = await primary.stop()
        if let ingress { ingress.writer.queue.sync {} }
        return primaryFailure ?? releaseFailure
    }
    package func closeMedia(clock: CaptureClock, failure: CaptureFailure?) async -> CaptureInputClosure {
        guard let ingress, let camera = ingress.companion else { return CaptureInputClosure() }
        var closeFailure: CaptureFailure?
        do { try ingress.close() } catch { closeFailure = CaptureFailure("WRITE_FAILED", error.localizedDescription) }
        // Off at stop with nothing recorded: nothing failed, the camera was simply not used.
        if !meantOn, ingress.writer.queue.sync(execute: { camera.isEmpty }) {
            return CaptureInputClosure(camera: .notTurnedOn, failure: closeFailure)
        }
        return CaptureInputClosure(camera: .closed(await camera.close(clock: clock, failure: failure ?? closeFailure,
            observations: ingress.observationURL!)))
    }
    package func discardMedia() async {
        ended = true
        await switching?.value
        guard let ingress else { return }
        await ingress.companion!.discard()
        try? ingress.close()
    }
}

@MainActor
private struct NativeCameraDevice: CaptureCameraDevice {
    let device: AVCaptureDevice
    var id: String { device.uniqueID }
    init(_ device: AVCaptureDevice) { self.device = device }
    func makeSession(framesPerSecond: Int?, microphone: AVCaptureDevice?) throws -> any CaptureCameraSession {
        try NativeCameraSession(camera: device, framesPerSecond: framesPerSecond, microphone: microphone)
    }
}

/// SDK start/stop blocks the dedicated queue, never the control actor.
private final class CameraSessionIO: @unchecked Sendable {
    let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "com.dzhng.yap.camera-session")
    func start() async { await withCheckedContinuation { c in queue.async { self.session.startRunning(); c.resume() } } }
    func stop() async { await withCheckedContinuation { c in queue.async { self.session.stopRunning(); c.resume() } } }
}

@MainActor
private final class NativeCameraSession: CaptureCameraSession {
    private let camera: AVCaptureDevice
    private let framesPerSecond: Int?
    nonisolated private let io = CameraSessionIO()
    nonisolated var synchronizationClock: CMClockOrTimebase? { io.session.synchronizationClock }
    private let output = AVCaptureVideoDataOutput()
    private let audioOutput: AVCaptureAudioDataOutput?
    private let microphone: AVCaptureDevice?
    private(set) var width = 0
    private(set) var height = 0
    private var observers: [NSObjectProtocol] = []
    private var priorFrameDurations: (minimum: CMTime, maximum: CMTime, format: AVCaptureDevice.Format)?

    init(camera: AVCaptureDevice, framesPerSecond: Int?, microphone: AVCaptureDevice?) throws {
        self.camera = camera; self.framesPerSecond = framesPerSecond
        self.microphone = microphone
        audioOutput = microphone.map { _ in AVCaptureAudioDataOutput() }
        try validateCadence()
        io.session.beginConfiguration()
        var configured = false
        defer { if !configured { io.session.commitConfiguration() } }
        let input = try AVCaptureDeviceInput(device: camera)
        guard io.session.canAddInput(input), io.session.canAddOutput(output) else {
            throw CaptureFailure("SOURCE_UNAVAILABLE", "Selected camera cannot provide video callbacks.")
        }
        io.session.addInput(input)
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        output.alwaysDiscardsLateVideoFrames = true
        io.session.addOutput(output)
        if let microphone, let audioOutput {
            let audioInput = microphone.uniqueID == camera.uniqueID ? input : try AVCaptureDeviceInput(device: microphone)
            if audioInput !== input {
                guard io.session.canAddInput(audioInput) else {
                    throw CaptureFailure("SOURCE_UNAVAILABLE", "Selected microphone cannot provide audio alongside the camera.")
                }
                io.session.addInput(audioInput)
            }
            guard io.session.canAddOutput(audioOutput) else {
                throw CaptureFailure("SOURCE_UNAVAILABLE", "Selected microphone cannot provide audio callbacks.")
            }
            // Automatic connections can choose a camera's audio ports instead of the selected mic.
            io.session.addOutputWithNoConnections(audioOutput)
            let ports = audioInput.ports.filter { $0.mediaType == .audio }
            guard !ports.isEmpty else { throw CaptureFailure("SOURCE_UNAVAILABLE", "Selected microphone has no audio ports.") }
            let connection = AVCaptureConnection(inputPorts: ports, output: audioOutput)
            guard io.session.canAddConnection(connection) else {
                throw CaptureFailure("SOURCE_UNAVAILABLE", "Selected microphone cannot connect its audio output.")
            }
            io.session.addConnection(connection)
            // Device-native LPCM; CapturePCM owns representation normalization without resampling.
            audioOutput.audioSettings = nil
        }
        io.session.commitConfiguration(); configured = true
        let dimensions = CMVideoFormatDescriptionGetDimensions(camera.activeFormat.formatDescription)
        width = Int(dimensions.width); height = Int(dimensions.height)
        guard width > 0, height > 0 else { throw CaptureFailure("FORMAT_UNAVAILABLE", "Selected camera has no usable picture dimensions.") }
    }
    private func validateCadence() throws {
        guard let framesPerSecond else { return }
        guard camera.activeFormat.videoSupportedFrameRateRanges.contains(where: {
            $0.minFrameRate <= Double(framesPerSecond) && Double(framesPerSecond) <= $0.maxFrameRate
        }) else { throw CaptureFailure("FORMAT_UNAVAILABLE", "Selected camera's active format does not support requested fps.") }
    }
    func start(ingress: CaptureClockIngress) async throws {
        output.setSampleBufferDelegate(ingress, queue: ingress.writer.queue)
        audioOutput?.setSampleBufferDelegate(ingress, queue: ingress.writer.queue)
        try validateCadence()
        if let framesPerSecond {
            try camera.lockForConfiguration()
            priorFrameDurations = (camera.activeVideoMinFrameDuration, camera.activeVideoMaxFrameDuration, camera.activeFormat)
            camera.activeVideoMinFrameDuration = CMTime(value: 1, timescale: Int32(framesPerSecond))
            camera.activeVideoMaxFrameDuration = CMTime(value: 1, timescale: Int32(framesPerSecond))
            camera.unlockForConfiguration()
        }
        await io.start()
        guard io.session.isRunning else { throw CaptureFailure("SOURCE_UNAVAILABLE", "Camera session did not start.") }
    }
    func observeDeviceLoss(onFailure: @escaping @Sendable (CaptureFailure) -> Void) {
        guard observers.isEmpty else { return }
        observers.append(NotificationCenter.default.addObserver(forName: AVCaptureDevice.wasDisconnectedNotification,
            object: camera, queue: nil) { _ in onFailure(CaptureFailure("SOURCE_LOST", "Selected camera disconnected.")) })
        if let microphone {
            observers.append(NotificationCenter.default.addObserver(forName: AVCaptureDevice.wasDisconnectedNotification,
                object: microphone, queue: nil) { _ in onFailure(CaptureFailure("SOURCE_LOST", "Selected microphone disconnected.")) })
        }
        for event in [AVCaptureSession.runtimeErrorNotification, AVCaptureSession.wasInterruptedNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: event, object: io.session, queue: nil) { _ in
                onFailure(CaptureFailure("SOURCE_LOST", "Selected camera session interrupted."))
            })
        }
    }
    func stop() async -> CaptureFailure? {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }; observers = []
        await io.stop()
        var failure: CaptureFailure?
        if let prior = priorFrameDurations, camera.activeFormat == prior.format {
            do {
                try camera.lockForConfiguration()
                camera.activeVideoMinFrameDuration = prior.minimum
                camera.activeVideoMaxFrameDuration = prior.maximum
                camera.unlockForConfiguration()
            } catch { failure = CaptureFailure("DEVICE_RESTORE_FAILED", error.localizedDescription) }
        }
        priorFrameDurations = nil
        output.setSampleBufferDelegate(nil, queue: nil)
        audioOutput?.setSampleBufferDelegate(nil, queue: nil)
        return failure
    }
}
