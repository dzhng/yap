import CoreMedia
import Darwin
import Foundation
@testable import YapCapture
import YapMedia

// Fake hardware supplies fixed clocks and coordinates; journal serialization and all readers are real.
private let origin: Int64 = 100_000_000_000
private let source = CaptureSource(kind: "display", displayID: 1)
private func emit(_ value: [String: Any]) throws {
    let bytes = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    try FileHandle.standardOutput.write(contentsOf: bytes + Data([10]))
}
private func progress(_ message: String) {
    try? FileHandle.standardError.write(contentsOf: Data((message + "\n").utf8))
}

private func generate(directory: String, profile: String, seconds: Double, strokeSeconds: Double,
    pcmHz: Int, cursorHz: Int, cameraHz: Int) throws -> [String: Any] {
    try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: false)
    let pcm = profile == "pcm" || profile.hasPrefix("combined")
    let cursor = profile.hasPrefix("cursor") || profile.hasPrefix("combined")
    let marks = profile == "events" || profile.hasPrefix("combined")
    let camera = profile == "camera" || profile.hasPrefix("combined")
    let typical = profile.hasSuffix("typical")
    let duration = Int64((seconds * 1_000_000).rounded())
    let normalizedSeconds = Double(duration) / 1_000_000
    let journal = try CaptureJournal(directory: directory, header: CaptureJournalHeader(
        schemaVersion: 3, sessionID: "long-take-fixture", source: source, width: 1920, height: 1080,
        microphone: pcm, systemAudio: false))
    try journal.recordPCMOrigin(JournalPCMOrigin(rawPTS: CMTime(value: origin, timescale: 1_000_000), declaredHostUs: origin))
    if pcm { try journal.recordPCMTrack(JournalPCMTrack(role: "narration", rate: 48000, channels: 1, phaseUs: 0)) }
    func geometry(_ epoch: Int) -> CaptureGeometry { CaptureGeometry(outputWidth: 1920, outputHeight: 1080,
        contentRect: GeometryRect(x: 0, y: 0, width: 1920, height: 1080), contentScale: 1,
        scaleFactor: 1, screenRect: GeometryRect(x: Double((epoch - 1) % 2) * 20, y: 0, width: 1920, height: 1080),
        boundingRect: nil, requestedSourceRect: nil) }
    if cursor || marks {
        try journal.recordDisplaySpace(hostUs: origin, zeroOriginHeight: 1080)
        try journal.recordGeometry(epoch: 1, hostUs: origin, sourceUs: 0, geometry: geometry(1))
    }
    var pcmCount = 0, cursorCount = 0, changes = 0, cameraCount = 0, markCount = 0, epoch = 1
    var physical: Int64 = 0
    var samples: [CursorSample] = []
    let mappingURL = URL(fileURLWithPath: directory).appendingPathComponent("camera.mapping.jsonl")
    let mapping: FileHandle?
    if camera {
        _ = FileManager.default.createFile(atPath: mappingURL.path, contents: nil)
        mapping = try FileHandle(forWritingTo: mappingURL)
    } else { mapping = nil }
    defer { try? mapping?.close() }
    // The production callback envelope is private to CaptureClockIngress.log. This size model uses
    // its documented fields and production rational/frame encoders; no movie/receipt is fabricated.
    struct MappingRow: Encodable {
        let role = "camera", clockDomain = "camera-session"
        let generation = "00000000-0000-0000-0000-000000000000"
        let rawPTS: CaptureRationalTime
        let convertedHostPTS: CaptureRationalTime
        let arrivalHostUs: Int64
        let duration: CaptureRationalTime
        let sourceUs: Int64
        let disposition = "accepted"
        let relativeRate = 1.0
        let cameraFrame: CameraFrameMapping
    }
    let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
    var strokeWritten = false
    for second in 0..<Int(ceil(normalizedSeconds)) {
        let remaining = min(1, normalizedSeconds - Double(second))
        if pcm {
            for tick in 0..<Int(ceil(remaining * Double(pcmHz))) {
                let ordinal = Int64(second * pcmHz + tick)
                let end = min(Int64((Double(ordinal + 1) * 48000 / Double(pcmHz)).rounded()), duration * 48000 / 1_000_000)
                guard end > physical else { continue }
                let host = origin + ordinal * 1_000_000 / Int64(pcmHz)
                try journal.recordPCMAppend(JournalPCMAppend(role: "narration", physicalFirstFrame: physical,
                    frameCount: end - physical, declaredFirstFrame: physical,
                    rawPTS: CMTime(value: host, timescale: 1_000_000), removedPauseUs: 0))
                physical = end; pcmCount += 1
            }
        }
        if (cursor || marks) && second > 0 && second.isMultiple(of: 60) {
            epoch += 1
            try journal.recordGeometry(epoch: epoch, hostUs: origin + Int64(second) * 1_000_000,
                sourceUs: Int64(second) * 1_000_000, geometry: geometry(epoch))
        }
        if cursor {
            for tick in 0..<Int(ceil(remaining * Double(cursorHz))) {
                let ordinal = second * cursorHz + tick
                let step = typical ? ordinal * 26 / 100 : ordinal
                let previous = typical ? max(0, ordinal - 1) * 26 / 100 : max(0, ordinal - 1)
                if step != previous { changes += 1 }
                // Fractional, asymmetric coordinates approximate ordinary Retina pointer precision.
                let x = Double((step * 17) % 1920) + 0.125, y = Double((step * 11) % 1080) + 0.375
                samples.append(CursorSample(sourceUs: Int64(ordinal) * 1_000_000 / Int64(cursorHz),
                    x: x, y: y, globalX: x + Double((epoch - 1) % 2) * 20, globalY: y, buttons: 0, eligibility: "inside", geometryEpoch: epoch))
                cursorCount += 1
                if samples.count == 30 { try journal.recordCursorSamples(samples); samples.removeAll(keepingCapacity: true) }
            }
        }
        if marks && second == 0 {
            for kind in ["pin", "click"] {
                try journal.recordMark(JournalMark(hostUs: origin, sourceUs: 0, epoch: epoch,
                    id: kind, kind: kind, pin: kind == "pin" ? 1 : nil,
                    points: [JournalMarkPoint(globalX: 100.125, globalY: 200.375, x: 100.125, y: 200.375, hostUs: origin)]))
                markCount += 1
            }
        }
        if marks && !strokeWritten && Double(second + 1) >= min(normalizedSeconds, strokeSeconds) {
            let count = max(2, Int(min(normalizedSeconds, strokeSeconds) * Double(cursorHz)))
            let points: [JournalMarkPoint] = (0..<count).map { n in
                let x = Double(n % 1920) + 0.125
                let y = Double(n % 1080) + 0.375
                return JournalMarkPoint(globalX: x, globalY: y, x: x, y: y,
                    hostUs: origin + Int64(n) * 1_000_000 / Int64(cursorHz))
            }
            try journal.recordMark(JournalMark(hostUs: points.last!.hostUs, sourceUs: points.last!.hostUs - origin,
                epoch: epoch, id: "five-minute-stroke", kind: "stroke", points: points))
            markCount += 1; strokeWritten = true
        }
        if let mapping {
            for tick in 0..<Int(ceil(remaining * Double(cameraHz))) {
                let ordinal = second * cameraHz + tick
                let start = CMTime(value: Int64(ordinal), timescale: Int32(cameraHz))
                let end = CMTime(value: Int64(ordinal + 1), timescale: Int32(cameraHz))
                let host = origin + Int64(ordinal) * 1_000_000 / Int64(cameraHz)
                let raw = CaptureRationalTime(CMTime(value: host, timescale: 1_000_000))
                let row = MappingRow(rawPTS: raw, convertedHostPTS: raw, arrivalHostUs: host + 1000,
                    duration: CaptureRationalTime(CMTime(value: 1, timescale: Int32(cameraHz))),
                    sourceUs: host - origin, cameraFrame: CameraFrameMapping(ordinal: ordinal,
                        start: CaptureRationalTime(start), nominalEnd: CaptureRationalTime(end)))
                try mapping.write(contentsOf: encoder.encode(row) + Data([10])); cameraCount += 1
            }
        }
        if (second + 1).isMultiple(of: 600) {
            progress("generated \(second + 1)/\(normalizedSeconds)s pcm=\(pcmCount) cursor=\(cursorCount) camera=\(cameraCount)")
        }
    }
    try journal.recordCursorSamples(samples)
    try journal.recordFinished(CaptureResult(state: "complete", source: source, width: 1920, height: 1080,
        durationUs: duration, hostOriginUs: origin, pauses: [], tracks: [], failure: nil, systemAudioScope: "none"))
    try journal.lease.synchronize()
    return ["pcmAppends": pcmCount, "cursorSamples": cursorCount, "cursorChanges": changes,
        "cameraRows": cameraCount, "markEvents": markCount]
}

@main struct LongTake {
    static func main() async {
        do {
            let args = CommandLine.arguments
            let stage = args[1], directory = args[2]
            let detail: [String: Any]
            switch stage {
            case "generate":
                detail = try generate(directory: directory, profile: args[3], seconds: Double(args[4])!,
                    strokeSeconds: Double(args[5])!, pcmHz: Int(args[6])!, cursorHz: Int(args[7])!, cameraHz: Int(args[8])!)
            case "stream":
                var marks = 0, cursors = 0
                let summary = try CaptureJournal.streamEvidence(directory: directory, samples: { batch in
                    cursors += batch.count
                    if cursors.isMultiple(of: 36000) { progress("streamed cursor=\(cursors)") }
                }, mark: { _ in marks += 1 })
                var result = try JSONSerialization.jsonObject(with: JSONEncoder().encode(summary)) as! [String: Any]
                result["markEvents"] = marks
                guard summary.header?.schemaVersion == 3, summary.finished, !summary.incompleteTail,
                    summary.invalidAtSequence == nil else { throw CaptureFailure("INVALID_JOURNAL", "Generated fixture did not survive production reader.") }
                detail = result
            case "publish":
                let lease = try CaptureJournalLease(directory: directory); defer { lease.release() }
                // Journal-only fixture: deliberately no video.mov. The first failure is the result.
                let result = try await CaptureSourcePublication.publish(kind: .primary,
                    durationUs: Int64(args[3])!, originHostUs: origin, tracks: [], diagnostic: nil, lease: lease, layout: 3)
                detail = try JSONSerialization.jsonObject(with: JSONEncoder().encode(result)) as! [String: Any]
            case "export":
                let result = try await SourceEvidenceExport.write(directory: directory, output: args[3])
                try JSONEncoder().encode(result).write(to: URL(fileURLWithPath: args[4]))
                detail = ["bytes": result.bytes, "cursorSamples": result.cursorSamples, "markEvents": result.markEvents]
            default: throw CaptureFailure("INVALID_REQUEST", "Unknown probe stage")
            }
            try emit(["status": "pass", "detail": detail])
        } catch {
            let failure = error as? CaptureFailure
            try? emit(["status": "fail", "code": failure?.code ?? "PROBE_FAILED",
                "message": failure?.message ?? String(describing: error)])
            exit(1)
        }
    }
}
