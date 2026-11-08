import Darwin
import Foundation
import YapCapture

func diagnostic(_ message: String) {
    FileHandle.standardError.write(Data((message + "\n").utf8))
}

/// Test commands control prerecorded input and physical closure only. Product operations travel
/// through the actual service's socket and inherited control channel.
@main
@MainActor
struct ControllerJourney {
    static func emit(_ value: [String: Any]) {
        let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        FileHandle.standardOutput.write(data + Data([10]))
    }

    static func main() async throws {
        let config = try JSONSerialization.jsonObject(with: Data(contentsOf:
            URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String: Any]
        let inputs = JourneyInputs(video: config["video"] as! String, audio: config["audio"] as? String)
        let capture = NativeCapture(prepareInput: { request, check in
            try check()
            return try await inputs.prepare(request)
        })
        let controller = CaptureController(fixtureWindow: nil, capture: capture)
        let host = ServiceHost(bundle: ServiceBundle(
            script: URL(fileURLWithPath: config["script"] as! String),
            node: config["node"] as! String,
            native: URL(fileURLWithPath: config["native"] as! String),
            controlFrameBytes: config["controlFrameBytes"] as! Int,
            maxPendingCalls: config["maxPendingCalls"] as! Int,
            callTimeout: Double(config["callTimeoutMs"] as! Int) / 1000,
            startupDeadline: Date().addingTimeInterval(30)),
            onNativeCall: { operation, params, answer in
                Task { @MainActor in answer(await controller.handle(operation, params)) }
            }, onState: { state in
                Task { @MainActor in
                    switch state {
                    case .starting: break
                    case .ready(let pid, let socketPath):
                        emit(["event": "ready", "pid": pid, "socketPath": socketPath])
                    case .unavailable(let code, let message):
                        await controller.serviceLost()
                        emit(["event": "unavailable", "code": code, "message": message])
                    }
                }
            })
        controller.attach(to: host)
        host.start()
        let commands = AsyncStream<String> { continuation in
            Task.detached {
                while let line = readLine() { continuation.yield(line) }
                continuation.finish()
            }
        }
        for await line in commands {
            do {
                let command = try JSONSerialization.jsonObject(with: Data(line.utf8)) as! [String: Any]
                let id = command["id"] as! String
                switch command["operation"] as! String {
                case "configure":
                    inputs.configuration = command["params"] as? [String: Any] ?? [:]
                    emit(["id": id, "ok": true])
                case "release":
                    inputs.releasePreparation.release()
                    inputs.current?.releaseStop.release()
                    try inputs.restoreDirectories()
                    emit(["id": id, "ok": true])
                case "inspect":
                    emit(["id": id, "ok": true, "isCapturing": controller.isCapturing,
                        "stops": inputs.current?.stops ?? 0,
                        "closures": inputs.current?.finalizations ?? 0,
                        "cameraOpens": inputs.cameraDevice?.opens ?? 0,
                        "cameraStarts": inputs.cameraDevice?.sessions.reduce(0) { $0 + $1.starts } ?? 0,
                        "cameraStops": inputs.cameraDevice?.sessions.reduce(0) { $0 + $1.stops } ?? 0,
                        "inputBoundary": inputs.cameraDevice == nil ? "PrerecordedCaptureInput" : "CameraCaptureInput",
                        "requests": inputs.requests])
                case "close":
                    inputs.releasePreparation.release()
                    inputs.current?.releaseStop.release()
                    try inputs.restoreDirectories()
                    await controller.finalizeBeforeQuit()
                    host.shutdown()
                    emit(["id": id, "ok": true])
                    return
                default: throw CaptureFailure("INVALID_REQUEST", "Unknown fixture command")
                }
            } catch { emit(["event": "fixtureFailure", "message": error.localizedDescription]) }
        }
        inputs.releasePreparation.release()
        inputs.current?.releaseStop.release()
        try inputs.restoreDirectories()
        await controller.finalizeBeforeQuit()
        host.shutdown()
    }
}

@MainActor
final class JourneyInputs {
    let video: String
    let audio: String?
    var configuration: [String: Any] = [:]
    var current: PrerecordedCaptureInput?
    var cameraDevice: FixtureCameraDevice?
    var requests: [[String: Any]] = []
    var heldDirectories: [String] = []
    let releasePreparation = InputGate()

    init(video: String, audio: String?) { self.video = video; self.audio = audio }

    func prepare(_ request: CaptureRequest) async throws -> any CaptureInputSession {
        requests.append(try JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as! [String: Any])
        if configuration["holdPreparation"] as? Bool == true { await releasePreparation.wait() }
        if let camera = request.camera {
            guard camera.binding.deviceId == "fixture-camera" else {
                throw CaptureFailure("CAMERA_UNAVAILABLE", "The selected fixture camera is absent")
            }
            if configuration["cameraDenied"] as? Bool == true {
                throw CaptureFailure("CAMERA_PERMISSION_REQUIRED", "The selected fixture camera is denied")
            }
        }
        let input = PrerecordedCaptureInput(source: URL(fileURLWithPath: video),
            refusesAfterDelivery: configuration["refuseAfterDelivery"] as? Bool ?? false)
        input.holdStop = configuration["holdStop"] as? Bool ?? false
        input.primaryFramesEnabled = configuration["primaryFrames"] as? Bool ?? true
        input.cameraFramesEnabled = configuration["cameraFrames"] as? Bool ?? true
        input.cameraPrologueEnabled = configuration["cameraPrologue"] as? Bool ?? true
        input.videoDeliveryInterval = .milliseconds(10)
        if request.microphone, let audio { input.audio = URL(fileURLWithPath: audio) }
        if let camera = request.camera {
            let directory = URL(fileURLWithPath: request.outputDirectory).deletingLastPathComponent()
            precondition(directory.appendingPathComponent("camera").path == camera.outputDirectory)
            if configuration["productionCamera"] as? Bool == true {
                let video = URL(fileURLWithPath: video)
                // A camera opened mid-take stamps its pictures from the moment it opens.
                func session(now: Bool) -> FixtureCameraSession {
                    let session = FixtureCameraSession(source: video, origin: { input.fixtureOrigin! })
                    session.startsAtNow = now
                    return session
                }
                let device = FixtureCameraDevice(camera.binding.deviceId, session: session(now: !camera.startsOn))
                device.reopen = { session(now: true) }
                cameraDevice = device
                current = input
                return try await prepareFixtureCompanion(request, screen: input, device: device,
                    selection: camera.selection)
            }
            input.probeDirectory = directory
            input.cameraBinding = camera.binding
            let held = configuration["pending"] as? String
            input.afterCameraClose = { [weak self] in
                guard let self, let held else { return }
                let path = held == "primary" ? request.outputDirectory : camera.outputDirectory
                guard chmod(path, 0o500) == 0 else { throw CocoaError(.fileWriteNoPermission) }
                heldDirectories.append(path)
            }
        }
        current = input
        return input
    }

    func restoreDirectories() throws {
        for directory in heldDirectories {
            guard chmod(directory, 0o700) == 0 else { throw CocoaError(.fileWriteNoPermission) }
        }
        heldDirectories.removeAll()
    }
}
