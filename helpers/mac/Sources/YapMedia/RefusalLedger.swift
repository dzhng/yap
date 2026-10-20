import Foundation

/// The app and native workers share the protocol ledger for retry verdicts and delays.
public enum RefusalLedger {
    private struct Ledger: Decodable {
        struct Entry: Decodable, Sendable { let retryable: Bool; let retryAfterMs: Int? }
        let codes: [String: Entry]
    }
    private static let codes: [String: Ledger.Entry] = {
        // Installed executables share the app's service resource. Source-built tools read the
        // authoritative JSON directly, so development never needs a second copy or code table.
        let source = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../../../packages/protocol/src/refusal-ledger.json").standardizedFileURL
        let bundled = Bundle.main.bundleURL.pathExtension == "app"
        let url = bundled
            ? Bundle.main.url(forResource: "refusal-ledger", withExtension: "json", subdirectory: "service")
            : source
        guard let url, let data = try? Data(contentsOf: url),
            let ledger = try? JSONDecoder().decode(Ledger.self, from: data)
        else { fatalError(bundled
            ? "Missing or invalid bundled refusal ledger at service/refusal-ledger.json"
            : "Missing or invalid checkout refusal ledger") }
        return ledger.codes
    }()
    public static func retryable(_ code: String) -> Bool { codes[code]?.retryable ?? false }
    public static func retryAfterMs(_ code: String) -> Int? { codes[code]?.retryAfterMs }
}
