import Foundation
import Synchronization
import YapCapture
import YapMedia

@MainActor
func runMaximumTakeTests() async throws {
    let retained = ProcessInfo.processInfo.environment["YAP_MAXIMUM_TAKE_OUTPUT"]
    let root = retained.map { URL(fileURLWithPath: $0) } ?? FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
    defer { if retained == nil { try? FileManager.default.removeItem(at: root) } }
    let source = root.appendingPathComponent("input.mov")
    try await RecoveryFixture.writeVariableDurationVideo(to: source, timesUs: [0], endUs: 33333)
    let now = Mutex(CaptureHostTime.nowUs())
    let input = PrerecordedCaptureInput(source: source)
    let capture = NativeCapture(nowUs: { now.withLock { $0 } }, prepareInput: { _, _ in input })
    let destination = root.appendingPathComponent("take")
    try await capture.start(CaptureRequest(source: CaptureSource(kind: "offline-prerecorded"),
        outputDirectory: destination.path, microphone: false, systemAudio: false))
    let origin = input.fixtureOrigin!
    // Let the real idle-picture writer advance between clock jumps. A single 12-hour
    // sample gap cannot fit MOV's UInt32 sample-duration field at microsecond timescale.
    for step in 1...71 {
        now.withLock { $0 = origin + Int64(step) * 600_000_000 }
        try await Task.sleep(for: .milliseconds(100))
    }
    now.withLock { $0 = origin + Requirements.maximumTakeUs - 1_000_000 }
    try await Task.sleep(for: .milliseconds(150))
    try capture.pause()
    now.withLock { $0 += 20 * 60 * 60 * 1_000_000 }
    try await Task.sleep(for: .milliseconds(150))
    precondition(capture.deviceState == "paused" && input.stops == 0, "Pauses cannot consume the take budget")
    try capture.resume()
    now.withLock { $0 += 999_999 }
    try await Task.sleep(for: .milliseconds(150))
    precondition(capture.deviceState == "recording" && input.stops == 0, "Must admit source time below twelve hours")
    now.withLock { $0 += 1 }
    let deadline = ContinuousClock.now + .seconds(5)
    while capture.deviceState != "idle" && ContinuousClock.now < deadline {
        try await Task.sleep(for: .milliseconds(20))
    }
    precondition(capture.deviceState == "idle", "Twelve hours must run ordinary finish automatically")
    precondition(input.stops == 1 && input.finalizations == 1)
    guard case .published = capture.publication?.primary else { preconditionFailure("Take must publish normally") }
    let evidence = try CaptureJournal.readEvidence(directory: destination.path, maximumBytes: nil, retainTiming: false,
        geometry: { _ in }, samples: { _ in }, displaySpace: { _ in }, layout: try CaptureJournal.layout(directory: destination.path))
    precondition(evidence.finished && evidence.completion?.state == "complete"
        && evidence.completion?.failureCode == nil && evidence.completion?.durationUs == Requirements.maximumTakeUs, "Completion: \(String(describing: evidence.completion)); invalid=\(String(describing: evidence.invalidAtSequence))")
    precondition(evidence.lastLifecycle?.reason == "maximumDuration", "The stop is lifecycle provenance, never a failure code")
    if retained != nil { try JSONEncoder().encode(capture.publication!).write(to: root.appendingPathComponent("publication.json")) }
    print("PASS 12-hour prerecorded take completes and publishes, 20-hour pause excluded, lifecycle maximumDuration")
}
