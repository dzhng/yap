import Foundation
import YapCapture
import YapMedia
import Synchronization

func diagnostic(_ message: String) { FileHandle.standardError.write(Data((message + "\n").utf8)) }

@main
@MainActor
struct ControllerLifecycle {
    static func until(_ label: String, _ predicate: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(5)
        while !predicate() {
            precondition(Date() < deadline, "Deadline: \(label)")
            try await Task.sleep(for: .milliseconds(5))
        }
    }
    static func response(_ value: Result<Data, ServiceFailure>) throws -> [String: Any] {
        guard case .success(let bytes) = value else { fatalError("Control refused: \(value)") }
        return try JSONSerialization.jsonObject(with: bytes) as! [String: Any]
    }
    static func main() async throws {
        let env = ProcessInfo.processInfo.environment
        let mode = env["YAP_CONTROLLER_MODE"]!
        let cleanup = ["cleanup-pending", "maximum-cleanup"].contains(mode)
        let now = Mutex(CaptureHostTime.nowUs())
        let root = URL(fileURLWithPath: env["YAP_CONTROLLER_REPORT_ROOT"]!)
        let source = URL(fileURLWithPath: env["YAP_CONTROLLER_VIDEO"] ?? root.appendingPathComponent("input.mov").path)
        if env["YAP_CONTROLLER_VIDEO"] == nil {
            try await RecoveryFixture.writeVariableDurationVideo(to: source,
                timesUs: [0, 100000, 200000, 300000], endUs: 400000)
        }
        let input = PrerecordedCaptureInput(source: source)
        if cleanup { input.audio = URL(fileURLWithPath: env["YAP_CONTROLLER_AUDIO"]!) }
        input.videoDeliveryInterval = .milliseconds(10)
        input.holdStop = true
        let prepareEntered = InputGate(), prepareRelease = InputGate()
        var preparationCount = 0
        let pendingStart = mode == "pending-start" || mode == "failed-start"
        if pendingStart { input.holdStop = false }
        if mode == "pending-start" { input.companionFailure = CaptureFailure("SOURCE_LOST", "controlled input closure failure") }
        let capture = NativeCapture(nowUs: { mode == "maximum-cleanup" ? now.withLock { $0 } : CaptureHostTime.nowUs() }, prepareInput: { _, _ in
            preparationCount += 1
            if pendingStart && preparationCount == 1 {
                prepareEntered.release()
                await prepareRelease.wait()
                if mode == "failed-start" { throw CaptureFailure("START_FAILED", "controlled preparation refusal") }
            }
            return input
        })
        let controller = CaptureController(fixtureWindow: nil, capture: capture)
        let ready = InputGate()
        let host = ServiceHost(bundle: ServiceBundle(
            script: URL(fileURLWithPath: env["YAP_CONTROLLER_PEER"]!),
            node: env["YAP_CONTROLLER_NODE"]!, native: source,
            controlFrameBytes: 1_048_576, maxPendingCalls: 32, callTimeout: 10,
            startupDeadline: Date().addingTimeInterval(10)),
            onNativeCall: { _, _, answer in answer(.failure(ServiceFailure(code: "UNKNOWN_OPERATION", message: "No native calls from report peer"))) },
            onState: { state in if case .ready = state { Task { @MainActor in ready.release() } } })
        controller.attach(to: host)
        host.start()
        await ready.wait()
        defer { host.shutdown() }
        let fields: [String: Any] = ["recordingId": "recording-stop", "sourceId": "source-stop",
            "outputDirectory": root.appendingPathComponent("source").path,
            "source": ["kind": "window", "id": 1], "microphone": cleanup, "systemAudio": false]
        if pendingStart {
            let start = Task { await controller.handle("capture.start", try! JSONSerialization.data(withJSONObject: fields)) }
            await prepareEntered.wait()
            // Native's existing callback is the event boundary; media ownership remains concrete.
            capture.onInterruption?(CaptureFailure("SOURCE_LOST", "controlled input handoff"))
            try await Task.sleep(for: .milliseconds(10))
            precondition(input.stops == 0)
            prepareRelease.release()
            let result = await start.value
            if mode == "failed-start" {
                guard case .failure(let error) = result else { fatalError("Preparation must refuse") }
                precondition(error.code == "START_FAILED")
                var replacement = fields
                replacement["recordingId"] = "recording-replacement"
                replacement["sourceId"] = "source-replacement"
                replacement["outputDirectory"] = root.appendingPathComponent("replacement").path
                _ = try response(await controller.handle("capture.start", JSONSerialization.data(withJSONObject: replacement)))
                try await Task.sleep(for: .milliseconds(30))
                precondition(input.stops == 0 && capture.deviceState == "recording")
                await controller.finalizeBeforeQuit()
                print("PASS refused pending start releases its waiter and an old callback does not end the replacement take")
            } else {
                _ = try response(result)
                try await until("pending interruption settled") { !controller.isCapturing }
                precondition(input.stops == 1 && input.finalizations == 1)
                let reports = try String(contentsOf: root.appendingPathComponent("reports.jsonl"), encoding: .utf8)
                    .split(separator: "\n").map { try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any] }
                let terminal = reports.map { $0["params"] as! [String: Any] }
                    .first { $0["state"] as? String == "interrupted" }!
                precondition(terminal["message"] as? String == "controlled input closure failure")
                print("PASS pending-start interruption waits then closes the actual input and reports its failure")
            }
            return
        }
        _ = try response(await controller.handle("capture.start", JSONSerialization.data(withJSONObject: fields)))
        if cleanup {
            let attempt = root.appendingPathComponent("source/.capture-publication-narration")
            try FileManager.default.createDirectory(at: attempt, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            try Data("retain unknown working member".utf8).write(to: attempt.appendingPathComponent("retained-diagnostic"))
        }
        if mode == "maximum-cleanup" {
            let origin = input.fixtureOrigin!
            for step in 1...71 {
                now.withLock { $0 = origin + Int64(step) * 600_000_000 }
                try await Task.sleep(for: .milliseconds(100))
            }
            now.withLock { $0 = origin + Requirements.maximumTakeUs }
            await input.stopEntered.wait()
        }
        let control = try JSONSerialization.data(withJSONObject: ["recordingId": "recording-stop"])
        let first = try response(await controller.handle("capture.stop", control))
        if mode == "cancel-before-stop" {
            try await until("initial finalizing report held") { FileManager.default.fileExists(atPath: root.appendingPathComponent("finalizing-entered").path) }
            precondition(input.stops == 0)
            let cancel = Task { await controller.handle("capture.cancel", control) }
            try await Task.sleep(for: .milliseconds(20))
            precondition(input.stops == 0 && controller.isCapturing)
            try Data().write(to: root.appendingPathComponent("finalizing-release"))
            await input.stopEntered.wait()
            input.releaseStop.release()
            _ = try response(await cancel.value)
            precondition(input.stops == 1 && input.finalizations == 1)
            precondition(capture.deviceState == "idle" && capture.publication == nil && !controller.isCapturing)
            print("PASS cancellation before native stop survives the held initial finalizing report and closes input once")
            return
        }
        await input.stopEntered.wait()
        precondition(first["state"] as? String == "finalizing" && input.stops == 1)
        let again = try response(await controller.handle("capture.stop", control))
        precondition(again["sequence"] as? Int == first["sequence"] as? Int && input.stops == 1)
        if mode == "cancel-publication" {
            let cancel = Task { await controller.handle("capture.cancel", control) }
            try await Task.sleep(for: .milliseconds(20))
            precondition(controller.isCapturing && input.finalizations == 0)
            input.releaseStop.release()
            _ = try response(await cancel.value)
            precondition(input.stops == 1 && input.finalizations == 1)
            precondition(capture.deviceState == "idle" && capture.publication == nil && !controller.isCapturing)
            print("PASS controller cancellation waits for actual physical closure and publication unwind before releasing the take")
            return
        }
        input.releaseStop.release()
        try await until("terminal report held") { FileManager.default.fileExists(atPath: root.appendingPathComponent("terminal-entered").path) }
        let during = try response(await controller.handle("capture.stop", control))
        precondition(during["state"] as? String == "finalizing")
        precondition(during["sequence"] as? Int == first["sequence"] as? Int,
            "An acknowledged stop cannot borrow a newer publication/terminal sequence")
        let cancel = Task { await controller.handle("capture.cancel", control) }
        try await Task.sleep(for: .milliseconds(20))
        precondition(input.discards == 0)
        try Data().write(to: root.appendingPathComponent("terminal-release"))
        let terminal = try response(await cancel.value)
        precondition(terminal["state"] as? String == "complete", "Expected completed winner: \(terminal)")
        if cleanup {
            precondition(terminal["reason"] as? String == "CLEANUP_PENDING")
            if mode == "maximum-cleanup" {
                precondition(terminal["completionReason"] as? String == "maximumDuration",
                    "Cleanup pending must retain the successful maximum-duration ending")
                let evidence = try CaptureJournal.inspect(directory: root.appendingPathComponent("source").path)
                precondition(evidence.lastLifecycle?.completionReason == "maximumDuration")
            }
            precondition(FileManager.default.fileExists(atPath: root.appendingPathComponent("source/.capture-publication-narration/retained-diagnostic").path))
        }
        precondition(input.discards == 0 && input.stops == 1 && input.finalizations == 1)
        print("PASS actual controller preserves the original stop acknowledgment during newer source publications and terminal report; completed capture wins cancellation")
    }
}
