import Foundation
import YapMedia
import YapProtocol
import YapCapture

func runRequirementsTests() throws {
    let requirementsURL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("packages/protocol/src/requirements.json")
    let values = try JSONDecoder().decode(
        [String: Int64].self, from: Data(contentsOf: requirementsURL))
    precondition(Requirements.maximumTakeUs == values["maximumTakeSeconds"]! * 1_000_000)
    precondition(Requirements.maximumStrokeUs == values["maximumStrokeSeconds"]! * 1_000_000)
    precondition(CaptureJournal.maximumRecordBytes == Requirements.journalRecordBytes)
    print("PASS Swift requirements load the JSON authority used by TypeScript")
}
