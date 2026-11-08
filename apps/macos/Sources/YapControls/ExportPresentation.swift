import Foundation

/// Shared export facts and only the actions still admitted by the observed owner state.
public enum ExportPresentation {
    public static func items(for state: ControlsState, exports: ExportsState) -> SavedPage {
        var items: [SavedItem] = []
        if let failure = exports.discoveryFailure { items.append(.init(id: "exports.discovery", kind: .message, title: "Unfinished exports could not be read — \(failure)")) }
        items += exports.requests.map { requestItem($0, exports: exports, ready: state.service == .ready) }
        items += exports.records.map { recordItem($0, exports: exports, ready: state.service == .ready) }
        return .init(items: items)
    }
    public static func title(for exports: ExportsState) -> String {
        let attention = !exports.failures.isEmpty || !exports.readFailures.isEmpty || exports.discoveryFailure != nil
            || exports.requests.contains { $0.unconfirmed != nil }
            || exports.records.contains { $0.abandoning || $0.cleanupPending || $0.stopped }
        if attention { return "Exports — needs attention" }
        let working = exports.requests.count + exports.records.filter { !$0.settled }.count
        return working > 0 ? "Exports — \(working) in progress" : "Exports"
    }
    public static func kindTitle(_ kind: ExportsState.Kind) -> String {
        switch kind { case .video: "Video"; case .audio: "Audio"; case .package: "AI Package"; case .srt, .vtt: "Captions" }
    }
    private static func requestItem(_ request: ExportsState.Request, exports: ExportsState, ready: Bool) -> SavedItem {
        let acting = exports.acting[request.exportId]
        var details = ["\(kindTitle(request.kind)) · \(path(request.directory, request.leaf))"]
        if let reason = request.unconfirmed { details.append("Request not confirmed — \(reason)") }
        if let failure = exports.failures[request.exportId] { details.append(failure) }
        if let failure = exports.readFailures[request.exportId] { details.append(failure) }
        let actionable = ready && request.unconfirmed != nil && acting == nil
        let status = request.unconfirmed == nil ? "sending…" : "not confirmed"
        let attention = request.unconfirmed != nil || exports.failures[request.exportId] != nil || exports.readFailures[request.exportId] != nil
        return .init(id: request.exportId, kind: .export, title: request.leaf, status: status, details: details, actions: [
            .init(.resendExport(request.exportId), "Send Export Again", enabled: actionable),
            .init(.abandonExport(request.exportId), acting == .abandon ? "Abandoning…" : "Abandon Export", enabled: actionable),
        ], attention: attention)
    }
    private static func recordItem(_ record: ExportsState.Record, exports: ExportsState, ready: Bool) -> SavedItem {
        let acting = exports.acting[record.exportId]
        var details = ["\(kindTitle(record.kind)) · \(record.output ?? path(record.directory, record.leaf))"]
        if let reason = record.reason { details.append(reason) }
        if let failure = exports.failures[record.exportId] { details.append(failure) }
        if let failure = exports.readFailures[record.exportId] { details.append(failure) }
        var actions: [PresentedControlsAction] = []
        if record.committed { actions.append(.init(.revealExport(record.exportId), "Show in Finder", enabled: record.output != nil)) }
        // A committed export's retry finishes private cleanup; it never republishes output.
        if !record.abandoning && (record.committed ? record.cleanupPending : record.stopped) {
            actions.append(.init(.retryExport(record.exportId), acting == .retry ? "Retrying…" : record.committed ? "Retry Cleanup" : "Retry Export",
                enabled: ready && acting == nil && record.jobId != nil && (record.committed || record.retryable || record.state != "failed")))
        }
        if !record.committed || record.abandoning {
            actions.append(.init(.abandonExport(record.exportId), acting == .abandon ? "Abandoning…" : record.abandoning ? "Retry Abandon" : "Abandon Export", enabled: ready && acting == nil))
        }
        if record.committed && record.settled { actions.append(.init(.dismissExport(record.exportId), "Remove from List", enabled: acting == nil)) }
        let status = stateTitle(record)
        // The same rule the Exports tab title uses for "needs attention", per row.
        let attention = record.abandoning || record.cleanupPending || record.stopped
            || exports.failures[record.exportId] != nil || exports.readFailures[record.exportId] != nil
        return .init(id: record.exportId, kind: .export, title: record.leaf, status: status, details: details, actions: actions, attention: attention)
    }
    public static func stateTitle(_ record: ExportsState.Record) -> String {
        if record.abandoning { return "abandoning" }
        switch record.state {
        case "ready": return record.cleanupPending ? "exported, cleanup pending" : "exported"
        case "queued": return "waiting"
        case "running": return "exporting…"
        case "idle": return "not started"
        default: return record.state
        }
    }
    private static func path(_ directory: String, _ leaf: String) -> String { (directory as NSString).appendingPathComponent(leaf) }
}
