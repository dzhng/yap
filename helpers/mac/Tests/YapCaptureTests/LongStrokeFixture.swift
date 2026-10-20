import CoreMedia
import Foundation
import YapCapture

/// Fixed hardware observations; serialization is the capture writer's, including schema-3 thinning.
func writeLongStrokeFixture(to output: URL, strokeCount: Int = 1) throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: directory) }
    let source = CaptureSource(kind: "display", displayID: 1)
    let journal = try CaptureJournal(directory: directory.path, header: CaptureJournalHeader(
        schemaVersion: 3, sessionID: "schema3-long-stroke", source: source,
        width: 1920, height: 1080, microphone: false, systemAudio: false))
    let origin: Int64 = 100_000_000_000
    try journal.recordPCMOrigin(JournalPCMOrigin(
        rawPTS: CMTime(value: origin, timescale: 1_000_000), declaredHostUs: origin))
    try journal.recordGeometry(epoch: 1, hostUs: origin, sourceUs: 0,
        geometry: CaptureGeometry(outputWidth: 1920, outputHeight: 1080,
            contentRect: GeometryRect(x: 0, y: 0, width: 1920, height: 1080),
            contentScale: 1, scaleFactor: 1, screenRect: nil, boundingRect: nil,
            requestedSourceRect: nil))
    for stroke in 0..<strokeCount {
        let sourceUs = Int64(stroke) * 11_000_000
        let points = (0..<660).map { i in
            JournalMarkPoint(globalX: Double(i) / 7, globalY: Double(i) / 11,
                x: Double(i) / 7, y: Double(i) / 11,
                hostUs: origin + sourceUs + Int64(i) * 1_000_000 / 60)
        }
        try journal.recordMark(JournalMark(hostUs: origin + sourceUs, sourceUs: sourceUs, epoch: 1,
            id: stroke == 0 ? "eleven-second-stroke" : "stroke-\(stroke)", kind: "stroke", points: points))
    }
    try journal.recordFinished(CaptureResult(state: "complete", source: source, width: 1920,
        height: 1080, durationUs: Int64(strokeCount) * 11_000_000, hostOriginUs: origin, pauses: [], tracks: [],
        failure: nil, systemAudioScope: "disabled"))
    try FileManager.default.copyItem(at: directory.appendingPathComponent("capture.journal.jsonl"), to: output)
}
