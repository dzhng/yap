import Darwin
import Foundation

/// The app's own listener for the operations it owns: updating, the installed command and skill,
/// and the login item. They answer here even when the service cannot, since an update is how a
/// broken service gets fixed. Framing matches the service socket: one JSON request line in, one
/// response line out, then the connection closes.
final class AppSocket: @unchecked Sendable {
    typealias Answer = @Sendable (Result<Data, ServiceFailure>) -> Void
    typealias Handler = @Sendable (_ operation: String, _ params: Data, _ answer: @escaping Answer) -> Void

    private let path: String
    private let maxRequestBytes: Int
    private let handle: Handler
    private let queue = DispatchQueue(label: "com.dzhng.yap.app-socket", attributes: .concurrent)
    private var source: DispatchSourceRead?
    private var bound: ino_t = 0

    init(path: String, maxRequestBytes: Int, handle: @escaping Handler) {
        self.path = path
        self.maxRequestBytes = maxRequestBytes
        self.handle = handle
    }

    func start() throws(ServiceFailure) {
        // A first launch can run before anything else has made the personal root.
        let directory = (path as NSString).deletingLastPathComponent
        do {
            try FileManager.default.createDirectory(
                atPath: directory, withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700])
        } catch {
            throw ServiceFailure(code: "SOCKET_UNAVAILABLE", message: "Could not create \(directory): \(error.localizedDescription)")
        }
        try reclaimLeftover()
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: address.sun_path) else {
            throw ServiceFailure(code: "SOCKET_PATH_TOO_LONG", message: "App socket path is too long: \(path)")
        }
        withUnsafeMutableBytes(of: &address.sun_path) { raw in
            raw.copyBytes(from: bytes)
            raw[bytes.count] = 0
        }
        let listener = socket(AF_UNIX, SOCK_STREAM, 0)
        guard listener >= 0 else { throw failure("Could not open the app socket") }
        // Accepted sockets inherit this when they are created, so a caller that hangs up before
        // its answer is written can never raise SIGPIPE, however quickly it leaves.
        var noSignal: Int32 = 1
        setsockopt(listener, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
        let length = socklen_t(MemoryLayout<sockaddr_un>.size)
        let result = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listener, $0, length) }
        }
        guard result == 0, chmod(path, 0o600) == 0, listen(listener, 16) == 0 else {
            let error = failure("Could not listen on \(path)")
            close(listener)
            throw error
        }
        var info = stat()
        if lstat(path, &info) == 0 { bound = info.st_ino }
        _ = fcntl(listener, F_SETFL, fcntl(listener, F_GETFL) | O_NONBLOCK)
        let source = DispatchSource.makeReadSource(fileDescriptor: listener, queue: queue)
        source.setEventHandler { [weak self] in
            while case let client = accept(listener, nil, nil), client >= 0 { self?.serve(client) }
        }
        source.setCancelHandler { close(listener) }
        self.source = source
        source.resume()
    }

    /// Removes the socket only if it is still the one this listener bound.
    func stop() {
        source?.cancel()
        source = nil
        var info = stat()
        if bound != 0, lstat(path, &info) == 0, info.st_ino == bound { unlink(path) }
    }

    /// A live app keeps its socket; a file left by one that crashed is removed. Anything that is
    /// not a socket is refused rather than deleted, since this listener never created it.
    private func reclaimLeftover() throws(ServiceFailure) {
        var info = stat()
        guard lstat(path, &info) == 0 else { return }
        guard (info.st_mode & S_IFMT) == S_IFSOCK else {
            throw ServiceFailure(code: "SOCKET_PATH_OCCUPIED", message: "\(path) exists and is not a socket")
        }
        let probe = socket(AF_UNIX, SOCK_STREAM, 0)
        defer { close(probe) }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &address.sun_path) { raw in
            let bytes = Array(path.utf8)
            raw.copyBytes(from: bytes)
            raw[bytes.count] = 0
        }
        let connected = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                connect(probe, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        if connected == 0 {
            throw ServiceFailure(code: "SOCKET_IN_USE", message: "Another app already answers at \(path)")
        }
        unlink(path)
    }

    private func serve(_ client: Int32) {
        // An accepted socket inherits the listener's non-blocking mode; reads here block, bounded.
        _ = fcntl(client, F_SETFL, fcntl(client, F_GETFL) & ~O_NONBLOCK)
        // Bounds a caller that stalls sending its request or stops reading the answer. Accepted
        // sockets do not inherit these from the listener, unlike SO_NOSIGPIPE.
        var deadline = timeval(tv_sec: 5, tv_usec: 0)
        setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &deadline, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &deadline, socklen_t(MemoryLayout<timeval>.size))
        queue.async { [self] in
            guard let line = readLine(client) else {
                // Nothing arrived (a probe that hung up, or a stalled caller): nothing to answer.
                close(client)
                return
            }
            guard let request = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                let id = request["id"] as? String, !id.isEmpty,
                let operation = request["operation"] as? String,
                let params = request["params"] as? [String: Any],
                let encoded = try? JSONSerialization.data(withJSONObject: params)
            else {
                respond(client, id: "app", .failure(ServiceFailure(code: "INVALID_REQUEST", message: "Expected a request with id, operation and params")))
                return
            }
            // The handler answers on the main actor; the reply is written here, off it.
            handle(operation, encoded) { [self] result in queue.async { self.respond(client, id: id, result) } }
        }
    }

    private func readLine(_ client: Int32) -> Data? {
        var buffered = Data()
        var chunk = [UInt8](repeating: 0, count: 64 * 1024)
        // Each read is bounded by SO_RCVTIMEO; this bounds a caller that trickles bytes.
        let deadline = Date().addingTimeInterval(5)
        while buffered.count <= maxRequestBytes, Date() < deadline {
            let count = read(client, &chunk, chunk.count)
            guard count > 0 else { return nil }
            if let end = chunk[0..<count].firstIndex(of: 0x0A) {
                buffered.append(contentsOf: chunk[0..<end])
                return buffered.count <= maxRequestBytes ? buffered : nil
            }
            buffered.append(contentsOf: chunk[0..<count])
        }
        return nil
    }

    private func respond(_ client: Int32, id: String, _ result: Result<Data, ServiceFailure>) {
        var line: Data
        switch result {
        case .success(let data):
            let identity = (try? JSONSerialization.data(withJSONObject: id, options: .fragmentsAllowed)) ?? Data("\"app\"".utf8)
            line = Data(#"{"id":"#.utf8) + identity + Data(#","ok":true,"data":"#.utf8) + data + Data("}".utf8)
        case .failure(let failure):
            let envelope: [String: Any] = [
                "id": id, "ok": false,
                "error": failure.envelope,
            ]
            line = (try? JSONSerialization.data(withJSONObject: envelope)) ?? Data()
        }
        line.append(0x0A)
        line.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let written = write(client, raw.baseAddress! + offset, raw.count - offset)
                if written <= 0 { break }
                offset += written
            }
        }
        close(client)
    }

    private func failure(_ message: String) -> ServiceFailure {
        ServiceFailure(code: "SOCKET_UNAVAILABLE", message: "\(message): \(String(cString: strerror(errno)))")
    }
}
