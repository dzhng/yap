import Foundation
import YapMedia

func runRequirementsTests() throws {
    let requirementsURL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("packages/protocol/src/requirements.json")
    let seconds = try JSONDecoder().decode(
        [String: Int64].self, from: Data(contentsOf: requirementsURL))
    let expected = seconds.mapValues { $0 * 1_000_000 }
    let mirrored = [
        "maximumTakeSeconds": Requirements.maximumTakeUs,
        "maximumStrokeSeconds": Requirements.maximumStrokeUs,
    ]
    precondition(mirrored == expected,
        "Swift requirements \(mirrored) differ from JSON \(expected)")
    print("PASS requirements match protocol JSON: take \(Requirements.maximumTakeUs) us, stroke \(Requirements.maximumStrokeUs) us")
}
