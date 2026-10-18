import Darwin
import Foundation

/// Owns the one Node service child this app launches, and the inherited JSON-lines
/// control channel to it. The child owns the private socket listener; this type owns
/// only its lifetime. There is no installed daemon and no automatic restart: a child
/// that fails or dies leaves a reported, actionable failure.
final class ServiceHost: @unchecked Sendable {
    /// How the service reaches this app's native capture session. The handler answers exactly
    /// once; the channel correlates and bounds the call around it.
    /// Parameters and results cross this boundary as JSON bytes: the two sides run on different
    /// executors and share no object graph.
    typealias NativeHandler = @Sendable (
        String, Data, @escaping @Sendable (Result<Data, ServiceFailure>) -> Void
    ) -> Void

    enum State: Sendable {
        case starting
        case ready(pid: Int32, socketPath: String)
        case unavailable(code: String, message: String)
    }

    /// Bounded quit budget: EOF first, then signals against this child's own PID only.
    static let eofDeadline: TimeInterval = 4
    static let signalDeadline: TimeInterval = 2

    private let bundle: ServiceBundle
    private let queue = DispatchQueue(label: "com.dzhng.yap.service-host")
    private let child = Process()
    private let input = Pipe()
    private let output = Pipe()
    private var state: State = .starting
    private var buffer = Data()
    private var discarding = false
    private var pending: [String: @Sendable (Result<Data, ServiceFailure>) -> Void] = [:]
    private var stopping = false
    private var finished = false
    private var writerClosed = false
    private var outbound = 0
    /// Control writes go through an asynchronous channel rather than a blocking file
    /// handle. A child that stops reading its stdin must not stall the queue that owns
    /// every pending call's deadline, and must not grow this process's memory.
    private lazy var writer: DispatchIO = {
        let handle = input.fileHandleForWriting
        return DispatchIO(
            type: .stream, fileDescriptor: handle.fileDescriptor, queue: queue,
            cleanupHandler: { _ in try? handle.close() })
    }()

    private let onState: @Sendable (State) -> Void
    private let onUpdateProgress: @Sendable () -> Void
    private let onNativeCall: NativeHandler
    private var inbound = 0
    private var updateExit: (@Sendable (Result<Void, ServiceFailure>) -> Void)?
    private var exitResult: Result<Void, ServiceFailure>?

    init(
        bundle: ServiceBundle, onNativeCall: @escaping NativeHandler,
        onState: @escaping @Sendable (State) -> Void,
        onUpdateProgress: @escaping @Sendable () -> Void = {}
    ) {
        self.bundle = bundle
        self.onNativeCall = onNativeCall
        self.onState = onState
        self.onUpdateProgress = onUpdateProgress
    }

    /// How long one call may wait for its answer, as the protocol states it.
    var callTimeout: TimeInterval { bundle.callTimeout }

    func start() {
        publish(state)
        child.executableURL = URL(fileURLWithPath: bundle.node)
        child.arguments = [bundle.script.path]
        // The bundle is the one owner of where the native worker executable lives; the service
        // resolves no bundle layout of its own.
        var environment = ProcessInfo.processInfo.environment
        environment["YAP_NATIVE"] = bundle.native.path
        environment["YAP_FFMPEG_DIRECTORY"] = bundle.ffmpegDirectory?.path
        environment["YAP_FFMPEG_RECEIPT_SHA256"] = bundle.ffmpegReceiptSha256
        child.environment = environment
        child.standardInput = input
        child.standardOutput = output
        // Diagnostics stay on the app's stderr; stdout carries control messages only.
        child.standardError = FileHandle.standardError
        // Never inherit a developer shell's working directory: the packaged service
        // must resolve nothing relative to a repository checkout.
        child.currentDirectoryURL = URL(fileURLWithPath: "/")
        child.terminationHandler = { [weak self] process in
            let status = process.terminationStatus
            let clean = process.terminationReason == .exit && status == 0
            guard let self else { return }
            queue.async { self.childExited(status: status, clean: clean) }
        }
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard let self else { return }
            queue.async { data.isEmpty ? self.channelClosed() : self.consume(data) }
        }
        do {
            try child.run()
        } catch {
            queue.async {
                self.fail(
                    code: "SERVICE_UNAVAILABLE",
                    message: "Could not launch \(self.bundle.node): \(error.localizedDescription)")
            }
            return
        }
        // One startup budget covers interpreter resolution and this child's readiness,
        // so what is left of it — not a fresh copy — bounds the wait for its listener.
        queue.asyncAfter(deadline: .now() + max(0, bundle.startupDeadline.timeIntervalSinceNow)) {
            [weak self] in
            guard let self, case .starting = state else { return }
            fail(
                code: "SERVICE_TIMEOUT",
                message: "Service was not ready within \(Int(bundle.callTimeout))s of launch")
        }
    }

    /// Calls one service operation over the inherited pipe and answers with its `data` as JSON.
    /// Every call is correlated, bounded by the in-flight limit, and settled by an answer, a
    /// deadline or the channel ending. The request is encoded here, on the caller's actor, so only
    /// bytes cross to the queue that owns the channel.
    @MainActor
    func call(_ operation: String, _ params: [String: Any] = [:]) async throws(ServiceFailure) -> Data {
        let id = "app-\(UUID().uuidString)"
        guard
            let line = try? JSONSerialization.data(withJSONObject: [
                "event": "request",
                "request": ["id": id, "operation": operation, "params": params],
            ])
        else {
            throw ServiceFailure(code: "INVALID_REQUEST", message: "Could not encode \(operation)")
        }
        let answer = await withCheckedContinuation { continuation in
            queue.async {
                self.request(id: id, operation: operation, line: line) { continuation.resume(returning: $0) }
            }
        }
        return try answer.get()
    }

    /// The same call, with its answer read as `T`. An answer of another shape is a failed call.
    @MainActor
    func call<T: Decodable>(
        _ operation: String, _ params: [String: Any] = [:], as type: T.Type
    ) async throws(ServiceFailure) -> T {
        let data = try await call(operation, params)
        guard let value = try? JSONDecoder().decode(type, from: data) else {
            throw ServiceFailure(code: "INVALID_RESPONSE", message: "\(operation) returned unreadable data")
        }
        return value
    }

    private func request(
        id: String, operation: String, line: Data,
        _ completion: @escaping @Sendable (Result<Data, ServiceFailure>) -> Void
    ) {
        guard case .ready = state, !stopping else {
            completion(.failure(unavailableFailure()))
            return
        }
        guard pending.count < bundle.maxPendingCalls else {
            completion(
                .failure(
                    ServiceFailure(
                        code: "LIMIT_EXCEEDED",
                        message: "Too many service requests are already in flight.")))
            return
        }
        pending[id] = completion
        queue.asyncAfter(deadline: .now() + bundle.callTimeout) { [weak self] in
            guard let self, let waiting = pending.removeValue(forKey: id) else { return }
            waiting(.failure(ServiceFailure(code: "TIMEOUT", message: "\(operation) did not answer in time")))
        }
        // A child that died, or one that stopped reading, must surface as a settled
        // failure here, never as a signal or a blocked queue.
        if !send(line + Data([0x0a])) {
            pending.removeValue(forKey: id)
            completion(
                .failure(
                    ServiceFailure(
                        code: "LIMIT_EXCEEDED",
                        message: "Service is not reading its control channel.")))
        }
    }

    /// Queues one control line without ever blocking this queue, refusing it once the
    /// unwritten backlog reaches the shared control-frame bound. Reaching that bound
    /// means the peer has stopped reading entirely, which the caller is told about.
    private func send(_ line: Data) -> Bool {
        guard !writerClosed, outbound + line.count <= bundle.controlFrameBytes else { return false }
        outbound += line.count
        let chunk = line.withUnsafeBytes { DispatchData(bytes: $0) }
        writer.write(offset: 0, data: chunk, queue: queue) { [weak self] done, _, error in
            guard done, let self else { return }
            outbound -= line.count
            // Closing this channel deliberately cancels its outstanding writes, so only
            // an error that is not our own teardown describes a lost peer.
            if error != 0 && !stopping && !finished {
                fail(code: "SERVICE_STOPPED", message: "Service control channel is closed")
            }
        }
        return true
    }

    /// Closing the write channel is what gives the child EOF; its cleanup handler owns
    /// the descriptor, so nothing else ever closes it.
    private func closeWriter() {
        guard !writerClosed else { return }
        writerClosed = true
        writer.close(flags: .stop)
    }

    /// Normal quit: close the control pipe so the child closes its listener and unlinks
    /// its own socket, then escalate against this child's PID within a bounded deadline.
    func shutdown() {
        queue.sync {
            stopping = true
            closeWriter()
        }
        guard child.isRunning else { return }
        if waitForExit(Self.eofDeadline) { return }
        child.terminate()
        if waitForExit(Self.signalDeadline) { return }
        kill(child.processIdentifier, SIGKILL)
        _ = waitForExit(Self.signalDeadline)
    }

    /// Installation never borrows normal quit's signal escalation. EOF is irreversible:
    /// a timeout leaves this host closing, and only an observed clean exit permits replacement.
    func shutdownForUpdate(timeout: TimeInterval = eofDeadline) async throws(ServiceFailure) {
        let result: Result<Void, ServiceFailure> = await withCheckedContinuation { continuation in
            queue.async {
                if let result = self.exitResult { continuation.resume(returning: result); return }
                guard !self.stopping, !self.finished else {
                    continuation.resume(returning: .failure(self.unavailableFailure()))
                    return
                }
                self.stopping = true
                self.state = .unavailable(code: "SERVICE_STOPPED", message: "Service is closing for update")
                self.publish(self.state)
                self.updateExit = { continuation.resume(returning: $0) }
                let pending = self.pending
                self.pending.removeAll()
                for answer in pending.values { answer(.failure(self.unavailableFailure())) }
                self.closeWriter()
                self.queue.asyncAfter(deadline: .now() + max(0, timeout)) {
                    guard let answer = self.updateExit else { return }
                    self.updateExit = nil
                    answer(.failure(ServiceFailure(code: "UPDATE_SHUTDOWN_TIMEOUT",
                        message: "Service did not exit cleanly for the update; the app restarts it.")))
                }
            }
        }
        try result.get()
    }

    private func waitForExit(_ deadline: TimeInterval) -> Bool {
        let limit = Date().addingTimeInterval(deadline)
        while child.isRunning && Date() < limit { Thread.sleep(forTimeInterval: 0.02) }
        return !child.isRunning
    }

    // MARK: control channel

    private func consume(_ data: Data) {
        // A failed child is being ended; nothing it still had buffered may act on this app.
        guard !finished, !stopping else { return }
        var rest = data[...]
        while let terminator = rest.firstIndex(of: 0x0a) {
            let line = rest[rest.startIndex..<terminator]
            rest = rest[rest.index(after: terminator)...]
            if discarding {
                discarding = false
                buffer.removeAll()
                continue
            }
            if buffer.count + line.count + 1 > bundle.controlFrameBytes {
                buffer.removeAll()
                oversizedControlData()
                return
            }
            buffer.append(contentsOf: line)
            let complete = buffer
            buffer.removeAll()
            deliver(complete)
        }
        if discarding { return }
        if buffer.count + rest.count + 1 > bundle.controlFrameBytes {
            buffer.removeAll()
            discarding = true
            oversizedControlData()
            return
        }
        buffer.append(contentsOf: rest)
    }

    private func oversizedControlData() {
        fail(code: "CONTROL_LIMIT_EXCEEDED", message: "Service control message exceeds the byte limit")
    }

    private func deliver(_ line: Data) {
        guard let message = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any],
            let event = message["event"] as? String
        else {
            fail(code: "CONTROL_PROTOCOL", message: "Service sent an unreadable control message")
            return
        }
        switch event {
        case "started":
            guard let pid = (message["pid"] as? NSNumber)?.int32Value,
                let socketPath = message["socketPath"] as? String, !socketPath.isEmpty
            else {
                fail(code: "CONTROL_PROTOCOL", message: "Service announced an incomplete listener")
                return
            }
            guard case .starting = state else { return }
            state = .ready(pid: pid, socketPath: socketPath)
            publish(state)
        case "failed":
            let error = message["error"] as? [String: Any]
            fail(
                code: error?["code"] as? String ?? "SERVICE_UNAVAILABLE",
                message: error?["message"] as? String ?? "Service reported a startup failure")
        case "call":
            guard let request = message["request"] as? [String: Any],
                let id = request["id"] as? String, !id.isEmpty,
                let operation = request["operation"] as? String, !operation.isEmpty,
                let fields = request["params"] as? [String: Any],
                let params = try? JSONSerialization.data(withJSONObject: fields)
            else {
                fail(code: "CONTROL_PROTOCOL", message: "Service sent an unreadable native call")
                return
            }
            guard inbound < bundle.maxPendingCalls else {
                answer(
                    id: id,
                    .failure(
                        ServiceFailure(
                            code: "LIMIT_EXCEEDED", message: "Too many native calls are in flight.")))
                return
            }
            inbound += 1
            onNativeCall(operation, params) { [weak self] result in
                guard let self else { return }
                queue.async {
                    self.inbound -= 1
                    self.answer(id: id, result)
                }
            }
        case "update.progress":
            let notify = onUpdateProgress
            DispatchQueue.main.async { notify() }
        case "result":
            guard let response = message["response"] as? [String: Any] else {
                fail(code: "CONTROL_PROTOCOL", message: "Service sent a result without a response")
                return
            }
            guard let id = response["id"] as? String, let waiting = pending.removeValue(forKey: id) else {
                // An uncorrelated failure carries a null ID; it settles no specific call.
                return
            }
            if response["ok"] as? Bool == true {
                let payload = response["data"] ?? NSNull()
                guard
                    let data = try? JSONSerialization.data(
                        withJSONObject: payload, options: [.fragmentsAllowed])
                else {
                    waiting(
                        .failure(
                            ServiceFailure(code: "INVALID_RESPONSE", message: "Service returned unreadable data")))
                    return
                }
                waiting(.success(data))
            } else {
                let error = response["error"] as? [String: Any]
                waiting(
                    .failure(
                        ServiceFailure(
                            code: error?["code"] as? String ?? "INTERNAL_ERROR",
                            message: error?["message"] as? String ?? "Service operation failed",
                            retryable: error?["retryable"] as? Bool ?? false,
                            details: (error?["details"]).flatMap { try? JSONSerialization.data(withJSONObject: $0) })))
            }
        default:
            fail(code: "CONTROL_PROTOCOL", message: "Unknown service control event: \(event)")
        }
    }

    /// Answers one service-initiated call. A payload this process cannot encode is reported as a
    /// failure rather than left unanswered.
    private func answer(id: String, _ result: Result<Data, ServiceFailure>) {
        var response: [String: Any] = ["id": id]
        switch result {
        case .success(let payload):
            guard
                let data = try? JSONSerialization.jsonObject(
                    with: payload, options: [.fragmentsAllowed])
            else {
                answer(
                    id: id,
                    .failure(
                        ServiceFailure(
                            code: "INVALID_RESPONSE", message: "Capture result could not be read")))
                return
            }
            response["ok"] = true
            response["data"] = data
        case .failure(let failure):
            response["ok"] = false
            response["error"] = [
                "code": failure.code, "message": failure.message, "retryable": failure.retryable, "details": [:],
            ]
        }
        let message: [String: Any] = ["event": "result", "response": response]
        guard let line = try? JSONSerialization.data(withJSONObject: message) else {
            answer(
                id: id,
                .failure(
                    ServiceFailure(
                        code: "INVALID_RESPONSE", message: "Capture result could not be encoded")))
            return
        }
        _ = send(line + Data([0x0a]))
    }

    private func channelClosed() {
        output.fileHandleForReading.readabilityHandler = nil
        guard !stopping else { return }
        fail(code: "SERVICE_STOPPED", message: "Service closed its control channel")
    }

    private func childExited(status: Int32, clean: Bool) {
        let result: Result<Void, ServiceFailure> = clean ? .success(()) : .failure(
            ServiceFailure(code: "UPDATE_SHUTDOWN_FAILED", message: "Service exited with status \(status)"))
        exitResult = result
        let answer = updateExit
        updateExit = nil
        answer?(result)
        guard !stopping else { return }
        fail(code: "SERVICE_STOPPED", message: "Service exited with status \(status)")
    }

    /// One terminal failure per child. Settling every pending call here is what keeps a
    /// dead or unreadable channel from leaving callers waiting forever.
    private func fail(code: String, message: String) {
        let settled = pending
        pending.removeAll()
        if !finished {
            finished = true
            state = .unavailable(code: code, message: message)
            closeWriter()
            endChild()
            publish(state)
        }
        for waiting in settled.values { waiting(.failure(ServiceFailure(code: code, message: message))) }
    }

    /// A child that ignores EOF and SIGTERM is killed within the same bounded deadline
    /// normal quit uses, so a failed start never leaves a live process holding the
    /// runtime socket. The escalation is scheduled rather than awaited: this queue owns
    /// every pending deadline and must keep running.
    private func endChild() {
        guard child.isRunning else { return }
        let pid = child.processIdentifier
        child.terminate()
        queue.asyncAfter(deadline: .now() + Self.signalDeadline) { [weak self] in
            guard let self, child.isRunning else { return }
            kill(pid, SIGKILL)
        }
    }

    private func publish(_ value: State) {
        let notify = onState
        DispatchQueue.main.async { notify(value) }
    }

    private func unavailableFailure() -> ServiceFailure {
        if case .unavailable(let code, let message) = state {
            return ServiceFailure(code: code, message: message)
        }
        if stopping {
            return ServiceFailure(code: "SERVICE_STOPPED", message: "Service is shutting down")
        }
        return ServiceFailure(
            code: "SERVICE_STARTING", message: "Service has not reported a listener yet")
    }
}
