@preconcurrency import AVFoundation
import CoreGraphics
import Foundation
@preconcurrency import ScreenCaptureKit

/// An app-identity measurement entry point, not a production recording operation.
@MainActor
public final class SelectedCaptureProbe {
    public init() {}
    private var stopping = false
    private var stopStartup: (() -> Void)?

    /// Graceful user stop wakes waits; it never cancels the shared publication task.
    public func requestStop() {
        guard !stopping else { return }
        stopping = true
        stopStartup?()
    }

    public func run(action: String, requestPath: String? = nil) async throws -> Data {
        switch action {
        case "validate":
            let request = try Self.read(requestPath)
            try request.validate()
            return try JSONEncoder().encode(request)
        case "recover":
            let request = try Self.read(requestPath)
            try request.validate()
            let root = URL(fileURLWithPath: request.outputDirectory)
            let lease = try CaptureJournalLease(directory: root.appendingPathComponent("camera").path)
            defer { lease.release() }
            return try JSONEncoder().encode(await CameraMedia.publish(lease: lease,
                observationURL: root.appendingPathComponent("timestamps.jsonl")))
        case "status":
            return try JSONSerialization.data(withJSONObject: [
                "screen": NativeCapture.screenPermission,
                "camera": NativeCapture.cameraPermission, "microphone": NativeCapture.microphonePermission,
                "bundleIdentifier": Bundle.main.bundleIdentifier ?? "unbundled",
                "executable": Bundle.main.executableURL?.path ?? "unknown",
            ])
        case "sources":
            guard NativeCapture.screenPermission else {
                throw CaptureFailure("PERMISSION_REQUIRED", "Screen access must already be authorized for discovery.")
            }
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            return try JSONSerialization.data(withJSONObject: [
                "cameras": NativeCapture.cameraDevices().map { ["id": $0.id, "name": $0.name, "isDefault": $0.isDefault] },
                "microphones": NativeCapture.microphoneCandidates().map { ["id": $0.uniqueID, "name": $0.localizedName] },
                "displays": content.displays.map { ["id": $0.displayID, "width": $0.width, "height": $0.height] },
                "windows": content.windows.map { ["id": $0.windowID, "title": $0.title ?? ""] as [String: Any] },
            ])
        case "permission-camera":
            let granted = await AVCaptureDevice.requestAccess(for: .video)
            return try JSONSerialization.data(withJSONObject: ["camera": granted])
        case "permission-screen", "permission-microphone":
            let kind = String(action.dropFirst("permission-".count))
            let granted = try await NativeCapture.requestPermission(kind)
            return try JSONSerialization.data(withJSONObject: [kind: granted])
        case "capture":
            let request = try Self.read(requestPath)
            try request.validate()
            // Every grant is checked before enumeration, capture inputs or output creation.
            try request.requireAuthorization(screen: NativeCapture.screenPermission,
                camera: NativeCapture.cameraPermission == "authorized",
                microphone: NativeCapture.microphonePermission == "authorized")
            let root = URL(fileURLWithPath: request.outputDirectory)
            guard !FileManager.default.fileExists(atPath: root.path) else {
                throw CaptureFailure("INVALID_REQUEST", "Evidence destination must not already exist.")
            }
            let screenRequest = CaptureRequest(source: request.source,
                outputDirectory: root.appendingPathComponent("screen").path,
                microphone: request.microphone.enabled, microphoneDeviceID: request.microphone.deviceID)
            let delay = ProbeStartDelay()
            let selection = CaptureCameraSelection(id: request.cameraID,
                directory: root.appendingPathComponent("camera"), observations: root.appendingPathComponent("timestamps.jsonl"))
            let measurement = CameraCaptureMeasurement(framesPerSecond: request.framesPerSecond,
                samplesCursor: false, beforeStart: { [weak self] in
                    guard self?.stopping == false else { return false }
                    try await delay.wait(seconds: request.cameraDelaySeconds)
                    return self?.stopping == false
                })
            guard !stopping else { throw CancellationError() }
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700])
            try JSONEncoder().encode(request).write(to: root.appendingPathComponent("request.json"), options: .atomic)
            let capture = NativeCapture(prepareInput: { [weak self] request, check in
                try await CaptureInputPreparation().prepare(request, camera: selection, measurement: measurement,
                    checkInterruption: {
                        try check()
                        guard self?.stopping == false else { throw CancellationError() }
                    })
            })
            stopStartup = { delay.finish() }
            capture.onInterruption = { _ in delay.cancel() }
            defer { stopStartup = nil }
            return try await record(capture, request: request, screenRequest: screenRequest)

        default: throw CaptureFailure("INVALID_REQUEST", "Unknown selected-device probe action.")
        }
    }
    /// Shared selected-probe run: physical closure and publication stay in NativeCapture.
    package func record(_ capture: NativeCapture, request: SelectedCaptureRequest,
        screenRequest: CaptureRequest) async throws -> Data {
        var interrupted = false
        let priorInterruption = capture.onInterruption
        capture.onInterruption = { reason in interrupted = true; priorInterruption?(reason) }
        func wait(_ seconds: Double) async throws {
            let deadline = ContinuousClock.now.advanced(by: .seconds(seconds))
            while !stopping && !interrupted && ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(50))
            }
        }
        do {
            try await capture.start(screenRequest)
            if let pause = request.pause {
                let before = pause.atSeconds - request.cameraDelaySeconds
                guard before > 0 else { throw CaptureFailure("INVALID_REQUEST", "Pause must follow camera startup.") }
                try await wait(before)
                if !stopping && !interrupted { try capture.pause() }
                try await wait(pause.durationSeconds)
                if !stopping && !interrupted { try capture.resume() }
                try await wait(request.durationSeconds - pause.atSeconds - pause.durationSeconds)
            } else { try await wait(request.durationSeconds - request.cameraDelaySeconds) }
            let result = try await capture.stop()
            let data = try JSONEncoder().encode(result)
            try data.write(to: URL(fileURLWithPath: request.outputDirectory)
                .appendingPathComponent("screen-result.json"), options: .atomic)
            return data
        } catch {
            if capture.deviceState != "idle" { _ = try? await capture.stop() }
            throw error
        }
    }
    private static func read(_ path: String?) throws -> SelectedCaptureRequest {
        guard let path else { throw CaptureFailure("INVALID_REQUEST", "Supply a selected-device request file.") }
        return try JSONDecoder().decode(SelectedCaptureRequest.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
    }
}

/// Only the deliberately staggered start wait; NativeCapture remains the termination owner.
@MainActor
package final class ProbeStartDelay {
    package init() {}
    private var task: Task<Void, Error>?
    private var finished = false
    package func wait(seconds: Double) async throws {
        if finished { return }
        let pending = Task { try await Task.sleep(for: .seconds(seconds)) }
        task = pending
        defer { task = nil }
        do { try await withTaskCancellationHandler { try await pending.value } onCancel: { pending.cancel() } }
        catch is CancellationError where finished && !Task.isCancelled { return }
    }
    package func finish() { finished = true; task?.cancel() }
    package func cancel() { task?.cancel() }
}
