import Foundation

/// The one failure a native worker operation reports. Retryability is assigned by the service's
/// shared refusal ledger from the code carried across the wire.
public struct NativeFailure: Error, LocalizedError, Sendable, Equatable {
    public let code: String
    public let message: String
    /// Facts the caller can act on, such as the specific cause behind a classified refusal.
    public let details: [String: String]
    public var errorDescription: String? { message }

    public init(_ code: String, _ message: String, details: [String: String] = [:]) {
        self.code = code
        self.message = message
        self.details = details
    }

    /// Media could not be opened, decoded, encoded or written by the platform.
    public static func decodeFailed(_ message: String) -> NativeFailure {
        NativeFailure("NATIVE_DECODE_FAILED", message)
    }
}
