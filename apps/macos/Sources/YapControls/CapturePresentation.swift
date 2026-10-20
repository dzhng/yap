import Foundation
import YapMedia

/// Capture labels and action applicability; observations supply lifecycle and time.
public enum CapturePresentation {
    public static let screenSelectionPermissionNotice = "Allow Screen Recording access to choose a display, window, or area."

    public static func statusTitle(for state: ControlsState) -> String {
        if case .unavailable(let message) = state.service { return "Unavailable — \(message)" }
        if state.take?.state == "finalizing" {
            return state.take?.finalizationError == nil ? "Finishing take…" : "Finalization needs attention"
        }
        guard let device = state.device else {
            return state.service == .starting ? "Starting…" : "Idle"
        }
        let elapsed = ElapsedTime.format(device.elapsedUs)
        switch device.state {
        case .recording: return "Recording — \(elapsed)"
        case .paused: return "Paused — \(elapsed)"
        case .finalizing: return "Finishing take…"
        case .selecting: return "Preparing take…"
        case .idle: return "Idle"
        }
    }

    public static func sourceTitle(for state: ControlsState) -> String {
        switch state.selection.source {
        case .display(let display):
            display.width > 0 ? "\(display.name) (\(display.width)×\(display.height))" : display.name
        case .window(let window):
            window.label
        case .region(let region):
            "Region \(Int(region.width))×\(Int(region.height)) of \(region.displayName)"
        case .camera:
            state.sources.cameras.first { $0.id == state.selection.cameraDeviceId }?.name
                ?? state.selection.cameraDeviceId ?? "Choose a camera"
        case nil: "none chosen"
        }
    }

    public static func microphoneTitle(for state: ControlsState) -> String {
        // A chosen device that is unplugged says so, rather than reading as though this take will
        // be narrated through it: the take uses the system default until it is back.
        if case .device(_, let name)? = state.selection.awaitedMicrophone {
            return "system default, waiting for \(name)"
        }
        switch state.selection.microphone {
        case .off: return "off"
        case .systemDefault:
            return state.sources.microphones.first(where: \.isDefault).map { "\($0.name) (default)" }
                ?? "system default"
        case .device(_, let name): return name
        }
    }

    public static func transport(for state: ControlsState) -> [PresentedControlsAction] {
        let ready = state.service == .ready
        let live = state.isLive
        let recovering = state.take?.state == "finalizing" && state.device?.state == .idle
        let mayRetryFinalization = state.take?.finalizationError?.retryable != false
        let availableCamera = state.selection.source != .camera || state.sources.cameras.contains { $0.id == state.selection.cameraDeviceId }
        let replay = state.unansweredStart?.start == state.start()
        return [
            .init(.startOrStop, state.counting ? "Cancel Countdown" : live ? (state.take?.finalizationError == nil ? "Finish Recording" : "Retry Finalization") : "Start Recording",
                  enabled: state.counting || ready && (live && mayRetryFinalization || !live && state.start() != nil && (availableCamera || replay))),
            .init(.pauseOrResume, state.device?.state == .paused ? "Resume Recording" : "Pause Recording",
                  enabled: ready && (state.device?.state == .recording || state.device?.state == .paused)),
            .init(.cancel, recovering ? "Cancel Finalization" : "Cancel Take", enabled: live && ready),
            .init(.restart, "Restart Take", enabled: live && ready && !recovering),
        ].filter { $0.action != .startOrStop || mayRetryFinalization }
    }

    public static func failureAction(for state: ControlsState) -> PresentedControlsAction? {
        guard let failure = state.failure, failure.scope == .capture, let action = failure.action else { return nil }
        switch action {
        case .start: return .init(.retryFailure, "Retry", enabled: state.service == .ready && !state.isLive && !state.counting)
        case .copyPrompt: return .init(.retryFailure, "Copy", enabled: state.service == .ready)
        }
    }

    public static func noticeLines(for state: ControlsState) -> [String] {
        var lines: [String] = []
        if let failure = state.take?.finalizationError { lines.append("Finalization failed — \(RefusalLedger.cause(failure.code) ?? failure.message)") }
        if let take = state.take, take.state == "interrupted", !state.isLive {
            let cause = take.interruptionReason.flatMap(RefusalLedger.cause) ?? take.interruptionMessage ?? "The reason is unavailable."
            lines.append("Last take interrupted — \(cause)")
        }
        if state.take?.state == "complete", state.take?.completionReason == "maximumDuration" {
            let hours = Requirements.maximumTakeUs / 3_600_000_000
            lines.append("Take complete — reached \(hours) hours.")
        }
        let refused = ShortcutBindings.catalog.filter { state.unavailableShortcuts.contains($0.action.id) }
        if !refused.isEmpty {
            let names = refused.map(\.name).joined(separator: " and ")
            lines.append("The \(names) shortcut\(refused.count == 1 ? " was" : "s were") refused by macOS.")
        }
        return lines
    }
}
