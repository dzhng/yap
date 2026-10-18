import Foundation

/// A refusal as the service states it: its own code, and a message a person can act on.
struct ServiceFailure: LocalizedError, Sendable {
    let code: String
    let message: String
    var retryable: Bool = false
    /// The refusal's structured details as the service sent them (JSON), such as the users an
    /// `IN_USE` delete names.
    var details: Data? = nil

    var errorDescription: String? { "\(code): \(message)" }
}

/// What the build placed in `Contents/Resources/service`: the bundled entrypoint, the
/// interpreter the build validated against, and the shared control-channel limits.
/// Those limits are written from the protocol package so this app restates none of them.
struct ServiceBundle {
    let script: URL
    let node: String
    /// The bundled native worker the service runs for bounded media work, named once here from
    /// this app's own executable directory.
    let native: URL
    var ffmpegDirectory: URL? = nil
    var ffmpegReceiptSha256: String? = nil
    let controlFrameBytes: Int
    let maxPendingCalls: Int
    let callTimeout: TimeInterval
    /// When startup as a whole must have produced an answer. It is fixed before the
    /// interpreter is probed, so resolving an interpreter and the child reporting its
    /// listener share one budget instead of each getting a fresh one.
    let startupDeadline: Date

    private struct Manifest: Decodable {
        let nodePath: String
        let ffmpegDirectory: String?
        let ffmpegReceiptSha256: String?
        let controlFrameBytes: Int
        let maxPendingCalls: Int
        let callTimeoutMs: Int
    }

    /// Probing interpreters runs child processes, so resolution answers on a background
    /// queue and the caller stays responsive while the startup deadline runs down.
    @discardableResult
    static func resolve(
        in bundle: Bundle = .main,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        completion: @escaping @Sendable (Result<ServiceBundle, ServiceFailure>) -> Void
    ) -> Operation? {
        guard let executable = bundle.executableURL,
            let script = bundle.url(forResource: "main", withExtension: "mjs", subdirectory: "service"),
            let manifestURL = bundle.url(forResource: "runtime", withExtension: "json", subdirectory: "service"),
            let data = try? Data(contentsOf: manifestURL),
            let manifest = try? JSONDecoder().decode(Manifest.self, from: data)
        else {
            completion(
                .failure(
                    ServiceFailure(
                        code: "SERVICE_MISSING",
                        message: "This build has no usable service in Contents/Resources/service")))
            return nil
        }
        let callTimeout = TimeInterval(manifest.callTimeoutMs) / 1000
        let deadline = Date().addingTimeInterval(callTimeout)
        let operation = BlockOperation()
        operation.addExecutionBlock { [weak operation] in
            guard let operation, !operation.isCancelled else { return }
            let result = NodeRuntime.resolve(
                recorded: URL(
                    fileURLWithPath: manifest.nodePath,
                    relativeTo: manifestURL.deletingLastPathComponent()
                ).standardizedFileURL.path,
                environment: environment, deadline: deadline,
                isCancelled: { operation.isCancelled }
            ).map { node in
                ServiceBundle(
                    script: script,
                    node: node,
                    native: executable.deletingLastPathComponent().appendingPathComponent(
                        "yap-native"),
                    ffmpegDirectory: manifest.ffmpegDirectory.map {
                        URL(fileURLWithPath: $0, relativeTo: manifestURL.deletingLastPathComponent()).standardizedFileURL
                    },
                    ffmpegReceiptSha256: manifest.ffmpegReceiptSha256,
                    controlFrameBytes: manifest.controlFrameBytes,
                    maxPendingCalls: manifest.maxPendingCalls,
                    callTimeout: callTimeout,
                    startupDeadline: deadline)
            }
            if !operation.isCancelled { completion(result) }
        }
        DispatchQueue.global(qos: .userInitiated).async { operation.start() }
        return operation
    }
}
