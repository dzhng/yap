import Foundation

/// Joins existing native intent to the service's atomic permit. Sparkle owns the
/// update cycle and launch exclusion. This owner never closes resources to obtain idle;
/// it ends or restarts only a service that cannot answer for its own work.
@MainActor
final class UpdateCoordinator {
    struct Status: Equatable {
        var state = "unavailable"
        var availableVersion: String?
        var blockers: [String] = []
        var error: Failure?
        struct Failure: Equatable {
            let code: String
            let message: String
            let retryable: Bool
        }
        var parameters: [String: Any] {
            let workState: String
            let availability = state == "disabled" ? "disabled" : state == "unavailable" ? "unavailable" : "available"
            switch state {
            case "idle": workState = "idle"
            case "disabled", "unavailable": workState = "unavailable"
            case "checking", "downloading", "installing": workState = "running"
            case "failed": workState = "failed"
            case "waiting": workState = "queued"
            default: preconditionFailure("Unknown update state: \(state)")
            }
            return [
                "update": [
                    "state": workState, "jobId": NSNull(), "availability": availability, "availableVersion": availableVersion as Any? ?? NSNull(),
                    "blockers": blockers,
                    "error": error.map {
                        ["code": $0.code, "message": $0.message, "retryable": $0.retryable] as [String: Any]
                    } as Any? ?? NSNull(),
                ]
            ]
        }
    }
    private enum Phase { case waiting, preparing, committed, closing, authorized, cancelling, failed }
    private weak var host: ServiceHost?
    private let nativeBlockers: () -> [String]
    private let fence: (Bool) -> Void
    private let changed: () -> Void
    private var phase = Phase.waiting
    private var generation = UUID()
    private var permit: String?
    private var install: (() -> Void)?
    private var cancel: (() -> Void)?
    private var attempt: Task<Void, Never>?
    private var pendingProgress = false
    private var installerRequested = false
    private var manualCheck = false
    private var reported: Status?
    private(set) var status = Status()
    private(set) var available = false
    private(set) var enabled = false
    private(set) var cleanServiceExit = false
    private var serviceFailed = false
    /// This coordinator ended the service and is waiting for it to exit.
    private var endingService = false
    /// The app is quitting: its termination path stops the service, so nothing restarts it.
    private var quitting = false
    /// Consecutive cycles in which a running service answered the permit request with a refusal.
    private var refusedCycles = 0
    private(set) var checkMessage: String?
    var preferenceChanged: ((Bool) -> Void)?
    /// Ends the current service, if any, and starts a fresh one. A permit lives only in the running
    /// service, so this settles one the coordinator could not confirm, without asking anyone to
    /// quit and reopen the app.
    var restartService: (() -> Void)?
    /// Ends `host` so the update can install without it, telling the rest of the app that the
    /// service is gone; once it has exited, `serviceUnavailable` follows.
    var endService: ((ServiceHost) -> Void)?

    var mayUpdate: Bool { enabled || manualCheck }
    var canStartManualCheck: Bool {
        available && !cleanServiceExit && phase == .waiting
            && install == nil && attempt == nil
            && ["idle", "disabled", "failed"].contains(status.state)
    }
    var checkFailure: ServiceFailure {
        ServiceFailure(code: "UPDATE_BUSY", message: "An update is already in progress.")
    }
    func beginManualCheck() throws(ServiceFailure) {
        guard canStartManualCheck else { throw checkFailure }
        manualCheck = true
        checking()
    }

    init(
        blockers: @escaping () -> [String], fence: @escaping (Bool) -> Void,
        changed: @escaping () -> Void
    ) {
        nativeBlockers = blockers
        self.fence = fence
        self.changed = changed
    }
    func attach(to host: ServiceHost) {
        self.host = host
        serviceFailed = false
        endingService = false
        refusedCycles = 0
        reported = nil
        publish()
        progress()
    }
    /// A failed service has already ended its process, so it has no work left to protect and no
    /// permit to grant. Waiting on one would hold back the very update that replaces the broken
    /// service; the update installs once native work (a take) is idle instead.
    func serviceUnavailable() {
        // Closing the service is this coordinator's own step of an installation in progress.
        guard phase != .closing, phase != .authorized else { return }
        host = nil
        let ended = endingService
        endingService = false
        // A service ended for an update that is no longer pending must not stay down. One that
        // failed on its own is not restarted here, so a broken release cannot restart in a loop.
        if ended, install == nil {
            restart()
            return
        }
        serviceFailed = true
        progress()
    }
    func setAvailability(_ available: Bool, enabled: Bool) {
        self.available = available
        self.enabled = available && enabled
        status.state = available ? (self.enabled ? "idle" : "disabled") : "unavailable"
        publish()
    }
    func setEnabled(_ value: Bool) {
        guard available else { return }
        enabled = value
        preferenceChanged?(value)
        // Final authorization is the irreversible SDK boundary. A preference changed
        // here applies to the relaunched app, without retracting the granted replacement.
        if phase == .authorized {
            publish()
            return
        }
        if cleanServiceExit {
            publish()
            return
        }
        if !value {
            manualCheck = false
            stop(state: "disabled")
        } else if manualCheck {
            publish()
        } else {
            status.state = "idle"
            publish()
            progress()
        }
    }
    func checking() {
        guard mayUpdate, !cleanServiceExit else { return }
        checkMessage = nil
        status.error = nil
        status.availableVersion = nil
        status.state = "checking"
        publish()
    }
    func candidate(version: String) {
        status.availableVersion = version
        if cleanServiceExit {
            publish()
            return
        }
        status.error = nil
        status.state = mayUpdate ? "downloading" : "disabled"
        publish()
    }
    func ready(install: @escaping () -> Void, cancel: @escaping () -> Void) {
        self.install = install
        self.cancel = cancel
        if cleanServiceExit {
            cancel()
            return
        }
        if !mayUpdate {
            stop(state: "disabled")
            return
        }
        phase = .waiting
        status.state = "waiting"
        progress()
    }
    /// Owner notifications, not a retry timer, provide another installation opportunity.
    func progress() {
        guard mayUpdate, !cleanServiceExit, install != nil else { return }
        if phase == .preparing || (phase == .waiting && attempt != nil) {
            pendingProgress = true
            return
        }
        guard phase == .waiting else { return }
        status.blockers = nativeBlockers()
        status.state = "waiting"
        publish()
        guard status.blockers.isEmpty else { return }
        if serviceFailed {
            phase = .committed
            fence(true)
            status.blockers = ["launcher"]
            publish()
            installerRequested = true
            install?()
            return
        }
        guard let host else { return }
        phase = .preparing
        fence(true)
        let current = generation
        attempt = Task { @MainActor in
            defer {
                attempt = nil
                if pendingProgress {
                    pendingProgress = false
                    progress()
                }
            }
            var granted: String?
            do {
                let data = try await host.call("update.prepare")
                let answer = try JSONDecoder().decode(Preparation.self, from: data)
                if answer.kind == "blocked" {
                    refusedCycles = 0
                    guard generation == current else { return }
                    phase = .waiting
                    fence(false)
                    status.blockers = answer.blockers ?? []
                    publish()
                    return
                }
                guard answer.kind == "prepared", let id = answer.permitId else {
                    throw ServiceFailure(code: "INVALID_RESPONSE", message: "Unreadable update permit")
                }
                granted = id
                guard generation == current, mayUpdate, nativeBlockers().isEmpty else {
                    guard await release(id, from: host) else { return }
                    if generation == current {
                        phase = .waiting
                        fence(false)
                        progress()
                    }
                    return
                }
                permit = id
                _ = try await host.call("update.commit", ["permitId": id])
                guard generation == current, mayUpdate, nativeBlockers().isEmpty else {
                    guard await release(id, from: host) else { return }
                    if generation == current {
                        permit = nil
                        phase = .waiting
                        fence(false)
                        progress()
                    }
                    return
                }
                phase = .committed
                refusedCycles = 0
                status.blockers = ["launcher"]
                publish()
                installerRequested = true
                install?()
            } catch {
                guard generation == current else { return }
                // A service that cannot answer, or keeps refusing, cannot protect anything either.
                // Ending it settles any permit it holds, and the update installs without it.
                if !Self.answered(error) || refusedCycles >= 2 {
                    permit = nil
                    endService(host)
                    return
                }
                refusedCycles += 1
                if let granted, !(await release(granted, from: host)) { return }
                permit = nil
                phase = .failed
                fence(false)
                fail(code: "UPDATE_PREPARATION_FAILED", message: error.localizedDescription)
                cancel?()
            }
        }
    }
    /// Only the patched SDK's installing callback carries exclusion authority.
    /// Its retained retry callback grants final replacement after actual clean EOF.
    func installing(authorize: @escaping () -> Void) {
        guard phase == .committed else { return }
        if serviceFailed {
            guard mayUpdate, nativeBlockers().isEmpty else {
                stop(state: "failed")
                return
            }
            cleanServiceExit = true
            phase = .authorized
            status.state = "installing"
            status.blockers = []
            publish()
            authorize()
            return
        }
        guard mayUpdate, permit != nil,
            nativeBlockers().isEmpty, let host
        else {
            stop(state: "failed")
            return
        }
        phase = .closing
        status.state = "installing"
        status.blockers = []
        publish()
        let current = generation
        Task { @MainActor in
            do {
                try await host.shutdownForUpdate()
                guard generation == current else { return }
                cleanServiceExit = true
                guard mayUpdate, phase == .closing else { return }
                phase = .authorized
                authorize()
            } catch {
                guard generation == current else { return }
                stop(state: "failed")
                fail(code: "UPDATE_SHUTDOWN_FAILED", message: error.localizedDescription)
            }
        }
    }
    var mayTerminateForUpdate: Bool { phase == .authorized && cleanServiceExit }
    func ordinaryQuit() {
        quitting = true
        stop(state: enabled ? "idle" : "disabled")
    }
    func cycleFinished(error: Error?, upToDate: Bool = false) {
        manualCheck = false
        let wasClosing = phase == .closing || phase == .authorized || cleanServiceExit
        generation = UUID()
        install = nil
        cancel = nil
        let oldPermit = permit
        permit = nil
        if wasClosing {
            // The service already exited for this installation; the next cycle needs one again.
            installerRequested = false
            cleanServiceExit = false
            phase = .waiting
            fence(false)
            fail(code: "UPDATE_FAILED", message: error?.localizedDescription ?? "Update installation stopped.")
            restart()
            return
        }
        phase = .cancelling
        let current = generation
        let activeAttempt = attempt
        Task { @MainActor in
            await activeAttempt?.value
            if let oldPermit, let host {
                guard await release(oldPermit, from: host) else { return }
            }
            guard generation == current else { return }
            installerRequested = false
            phase = .waiting
            fence(false)
            status.blockers = []
            // A service ended for this update, or one that failed, must not stay down because
            // the update did not install.
            if serviceFailed { restart() }
            if let error {
                fail(code: "UPDATE_FAILED", message: error.localizedDescription)
            } else {
                checkMessage = upToDate ? "You’re up to date." : nil
                status.state = status.error == nil ? (enabled ? "idle" : "disabled") : "failed"
                publish()
            }
        }
    }
    func fail(code: String, message: String) {
        status.state = "failed"
        status.error = .init(code: code, message: message, retryable: false)
        publish()
    }
    private func stop(state: String) {
        generation = UUID()
        let old = phase
        if old == .closing {
            // The service was told to exit for this installation, which is not going ahead.
            restart()
        }
        phase = .cancelling
        status.state = state
        cancel?()
        // Before Sparkle receives Install there is no installer exclusion to drain.
        if old == .waiting || old == .failed, !installerRequested,
            !cleanServiceExit, permit == nil, attempt == nil
        {
            if install == nil { phase = .waiting }
            fence(false)
        }
        publish()
    }
    private func publish() {
        changed()
        guard status != reported, let host else { return }
        reported = status
        let parameters = status.parameters
        Task { @MainActor in _ = try? await host.call("update.report", parameters) }
    }
    /// False when the service could not confirm the release; the coordinator has then restarted
    /// the service, which settles the permit, and the caller has nothing left to undo.
    private func release(_ id: String, from host: ServiceHost) async -> Bool {
        do {
            _ = try await host.call("update.release", ["permitId": id])
            return true
        } catch {
            permit = nil
            installerRequested = false
            self.host = nil
            phase = .waiting
            fence(false)
            status.blockers = []
            status.state = install == nil ? (enabled ? "idle" : "disabled") : "waiting"
            publish()
            restart()
            return false
        }
    }
    /// The one way this coordinator restarts the service: it forgets the old one, including any
    /// end it was waiting on, and never restarts during a quit, whose path stops the service.
    private func restart() {
        host = nil
        serviceFailed = false
        endingService = false
        guard !quitting else { return }
        restartService?()
    }
    /// The service is stopped off the main actor: a hung one is escalated against within
    /// ServiceHost's own deadlines. Its exit reaches `serviceUnavailable`, which installs.
    private func endService(_ host: ServiceHost) {
        if self.host === host { self.host = nil }
        endingService = true
        phase = .waiting
        fence(false)
        if let endService {
            endService(host)
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            host.shutdown()
            DispatchQueue.main.async { MainActor.assumeIsolated { self.serviceUnavailable() } }
        }
    }
    /// Whether a running service answered at all. No answer, or an unreadable one, means the
    /// service is not working; a refusal is an answer and is retried in a later cycle.
    private static func answered(_ error: Error) -> Bool {
        guard let failure = error as? ServiceFailure else { return false }
        return failure.code != "TIMEOUT" && failure.code != "INVALID_RESPONSE"
            && !failure.code.hasPrefix("SERVICE_")
    }
    private struct Preparation: Decodable {
        let kind: String
        let permitId: String?
        let blockers: [String]?
    }
}
