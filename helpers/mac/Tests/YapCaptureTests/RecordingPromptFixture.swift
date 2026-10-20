import CoreMedia
import Foundation
import YapCapture
import YapMedia

/// Fixed pictures, PCM and pointer observations replace physical input; all durable bytes use
/// the journal, audio and source publication owners.
@MainActor
func writeRecordingPromptFixture(directory: String, options: String) async throws {
    let config = try JSONSerialization.jsonObject(with: Data(options.utf8)) as! [String: Any]
    let root = URL(fileURLWithPath: directory)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    let sourceId = config["sourceId"] as? String ?? "take-2"
    let kind = config["kind"] as? String ?? "display"
    let version = config["kind"] == nil || config["legacy"] as? Bool == true ? 3 : 4
    let mic = config["mic"] as? Bool ?? false
    let system = config["system"] as? Bool ?? false
    let duration: Int64 = 190_000_000
    let source = CaptureSource(kind: kind, displayID: kind == "camera" ? nil : 1)
    try await RecoveryFixture.writeVariableDurationVideo(to: root.appendingPathComponent("video.mov"),
        timesUs: [0, duration - 100_000], endUs: duration)
    let journal = try CaptureJournal(directory: root.path, header: .init(
        schemaVersion: version, sessionID: sourceId, source: source, width: 160, height: 120,
        microphone: mic, systemAudio: system, cursorSampling: version == 4 ? CursorSampling() : nil))
    defer { journal.lease.release() }
    try journal.recordPCMOrigin(.init(rawPTS: .zero, declaredHostUs: 0))
    let marks = config["marks"] as? [String: Bool] ?? [:]
    for (name, enabled) in [("pin", marks["pins"] == true), ("stroke", marks["strokes"] == true)] where enabled {
        try journal.recordMark(.init(hostUs: 100, sourceUs: 100, epoch: 1, id: name,
            kind: name, pin: name == "pin" ? 1 : nil,
            points: [.init(globalX: 10, globalY: 20, x: 10, y: 20, hostUs: 100)]))
    }
    var tracks: [CapturedTrack] = []
    if mic || system {
        let input = try captureMaterializerFixture(in: root, name: "pcm-input", accepted: 4800)
        for role in ["narration", "system"] where role == "narration" ? mic : system {
            try FileManager.default.copyItem(at: input.appendingPathComponent("narration.packed.mov"),
                to: root.appendingPathComponent("\(role).packed.mov"))
            try journal.recordPCMTrack(.init(role: role, rate: 48000, channels: 1, phaseUs: 0))
            try journal.recordPCMAppend(.init(role: role, physicalFirstFrame: 0, frameCount: 4800,
                declaredFirstFrame: 0, rawPTS: .zero, removedPauseUs: 0))
            let data: [String: Any] = ["role": role, "file": "\(role).mov", "samples": 4800,
                "droppedSamples": 0, "omittedSamples": 0, "heldTailUs": 0, "sampleRate": 48000, "channelCount": 1]
            tracks.append(try JSONDecoder().decode(CapturedTrack.self, from: JSONSerialization.data(withJSONObject: data)))
        }
    }
    try journal.recordFinished(.init(state: "complete", source: source, width: 160, height: 120,
        durationUs: duration, hostOriginUs: 0, pauses: [], tracks: tracks, failure: nil,
        systemAudioScope: system ? "system" : "disabled"))
    for role in ["narration", "system"] where role == "narration" ? mic : system {
        guard case .published = try await CaptureAudioPublication.publish(lease: journal.lease, role: role) else {
            preconditionFailure("Fixture PCM must publish")
        }
    }
    let primary = try await CaptureSourcePublication.publish(kind: .primary, durationUs: duration,
        originHostUs: 0, tracks: tracks, diagnostic: nil, lease: journal.lease, layout: version)
    var camera: CaptureSourcePublicationOutcome?
    if config["camera"] as? Bool == true {
        let inputFile = root.appendingPathComponent("camera-input.mov")
        try await RecoveryFixture.writeVariableDurationVideo(to: inputFile, timesUs: [0, 100000], endUs: 200000)
        let folder = root.appendingPathComponent("companion")
        let input = PrerecordedCaptureInput(source: inputFile)
        input.probeDirectory = folder
        input.cameraBinding = .init(recordingId: config["recordingId"] as? String ?? "take-1",
            sourceId: config["cameraSourceId"] as? String ?? "take-3", deviceId: "camera")
        let capture = NativeCapture(prepareInput: { _, _ in input })
        try await capture.start(.init(source: .init(kind: "display", displayID: 1),
            outputDirectory: folder.path, sourceId: "companion-primary"))
        _ = try await capture.stop()
        camera = capture.publication?.camera
        guard case .published = camera else { preconditionFailure("Fixture companion must publish") }
    }
    let primaryValue = try JSONSerialization.jsonObject(with: JSONEncoder().encode(primary))
    let cameraValue = try camera.map { try JSONSerialization.jsonObject(with: JSONEncoder().encode($0)) }
    let observation: [String: Any] = ["generation": UUID().uuidString, "sourceId": sourceId,
        "inputsClosed": true, "primary": ["state": "published", "source": primaryValue],
        "camera": cameraValue ?? NSNull()]
    try JSONSerialization.data(withJSONObject: observation).write(to: root.appendingPathComponent("publication.json"))
}
