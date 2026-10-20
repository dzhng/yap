import Foundation
import YapMedia

public struct CaptureFailure: Error, LocalizedError, Codable, Sendable {
    public var errorDescription: String? { message }
    public let code: String
    public let message: String
    public init(_ code: String, _ message: String) {
        self.code = code
        self.message = message
    }
    package init(bounded error: any Error) {
        let diagnostic = CaptureFinalizationError(error)
        self.init(diagnostic.code, diagnostic.message)
    }
}

/// The bounded diagnostic for an unfinished publication attempt, shared by control and recovery.
public struct CaptureFinalizationError: Codable, Sendable {
    public let code: String
    public let message: String
    public var retryable: Bool { RefusalLedger.retryable(code) }
    package static func isOperationalRead(_ error: any Error) -> Bool {
        var cause = error as NSError
        while true {
            if (cause.domain == NSCocoaErrorDomain && cause.code == CocoaError.fileReadNoPermission.rawValue)
                || (cause.domain == NSPOSIXErrorDomain && [EACCES, EPERM, EIO].contains { Int($0) == cause.code }) {
                return true
            }
            guard let underlying = cause.userInfo[NSUnderlyingErrorKey] as? NSError else { return false }
            cause = underlying
        }
    }
    public init(_ error: any Error) {
        let failure = error as? CaptureFailure
        let native = error as? NativeFailure
        let rawCode = failure?.code ?? native?.code ?? "PUBLICATION_FAILED"
        code = String(rawCode.prefix(128))
        message = String(decoding: (failure?.message ?? native?.message ?? error.localizedDescription).utf16.prefix(4096), as: UTF16.self)
    }
}
