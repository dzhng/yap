import Foundation
import YapCapture
import YapMedia

/// Equivalent hardware observations, serialized by the production journal writer.
func writeCursorHoldFixtures(to root: URL) throws {
    for mode in ["dense", "sparse", "historical", "everyTick", "denseMotion", "sparseMotion", "busy"] {
        let directory = root.appendingPathComponent(mode)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let journal = try CaptureJournal(directory: directory.path, header: CaptureJournalHeader(
            schemaVersion: mode == "historical" ? 3 : 4, sessionID: "2",
            source: CaptureSource(kind: "display"), width: 100, height: 80,
            microphone: false, systemAudio: false,
            cursorSampling: mode == "historical" ? nil : CursorSampling(holds: mode != "everyTick")))
        try journal.recordPCMOrigin(JournalPCMOrigin(rawPTS: time(microseconds: 1000), declaredHostUs: 1000))
        let geometry = CaptureGeometry(outputWidth: 100, outputHeight: 80,
            contentRect: GeometryRect(x: 0, y: 0, width: 100, height: 80), contentScale: 1,
            scaleFactor: 1, screenRect: GeometryRect(x: 0, y: 0, width: 100, height: 80),
            boundingRect: nil, requestedSourceRect: nil)
        try journal.recordGeometry(epoch: 1, hostUs: 1000, sourceUs: 0, geometry: geometry)
        let times: [Int64] = mode == "busy" ? (0..<6001).map { Int64($0) * 500 }
            : mode.hasPrefix("dense") ? (0..<180).map { Int64($0) * 1_000_000 / 60 }
            : mode == "sparseMotion" ? [0, 1_000_000, 2_000_000] : [0]
        try journal.recordCursorSamples(times.enumerated().map { i, at in
            let x: Double = mode == "busy" ? Double(i % 80)
                : mode.hasSuffix("Motion") ? (at < 1_000_000 ? 42 : at < 2_000_000 ? 50 : 35) : 42
            return CursorSample(sourceUs: at, x: x, y: 20,
                globalX: x, globalY: 20, buttons: 0, eligibility: "inside", geometryEpoch: 1)
        })
    }
}
