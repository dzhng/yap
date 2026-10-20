import Foundation

/// Product requirements are loaded from the protocol's single JSON authority.
public enum Requirements {
    private struct Values: Decodable {
        let maximumTakeSeconds: Int64
        let maximumStrokeSeconds: Int64
        let journalRecordMargin: Int64
        let strokeBytesPerSecond: Int64
    }

    private static let values: Values = {
        let source = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../packages/protocol/src/requirements.json")
            .standardizedFileURL
        let bundled = Bundle.main.bundleURL.pathExtension == "app"
        let url = bundled
            ? Bundle.main.url(forResource: "requirements", withExtension: "json", subdirectory: "service")
            : source
        guard let url, let data = try? Data(contentsOf: url),
            let values = try? JSONDecoder().decode(Values.self, from: data)
        else { fatalError(bundled
            ? "Missing or invalid bundled requirements at service/requirements.json"
            : "Missing or invalid checkout requirements") }
        return values
    }()

    public static let journalRecordBytes = Int(values.strokeBytesPerSecond * values.maximumStrokeSeconds * values.journalRecordMargin)
    public static let maximumTakeUs = values.maximumTakeSeconds * 1_000_000
    public static let maximumStrokeUs = values.maximumStrokeSeconds * 1_000_000
}
