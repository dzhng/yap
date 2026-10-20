import Foundation
import YapMedia
import YapCapture

func runRequirementsTests() throws {
    let requirementsURL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("packages/protocol/src/requirements.json")
    let values = try JSONDecoder().decode(
        [String: Int64].self, from: Data(contentsOf: requirementsURL))
    let expected = values.filter { $0.key != "strokeBytesPerSecond" }.mapValues { $0 * 1_000_000 }
    precondition(Requirements.strokeBytesPerSecond == values["strokeBytesPerSecond"])
    let mirrored = [
        "maximumTakeSeconds": Requirements.maximumTakeUs,
        "maximumStrokeSeconds": Requirements.maximumStrokeUs,
    ]
    precondition(mirrored == expected,
        "Swift requirements \(mirrored) differ from JSON \(expected)")
    print("PASS requirements match protocol JSON: take \(Requirements.maximumTakeUs) us, stroke \(Requirements.maximumStrokeUs) us")
    let recordBytes = Int(ceil(Double(values["strokeBytesPerSecond"]!) * Double(values["maximumStrokeSeconds"]!) * 2))
    precondition(CaptureJournal.maximumRecordBytes == recordBytes,
        "Swift's schema-4 record bound must match protocol's stroke derivation")
    print("PASS derived journal record bound \(recordBytes) bytes")
}
