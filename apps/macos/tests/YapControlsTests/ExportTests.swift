import Foundation
import YapControls

private func exportItems(_ state: ControlsState, _ exports: ExportsState) -> [SavedItem] {
    ExportPresentation.items(for: state, exports: exports).items
}

private func entry(_ items: [SavedItem], _ id: String) -> PresentedControlsAction? {
    items.flatMap(\.actions).first { $0.action.id == id }
}

private func record(
    _ exportId: String, state: String, projectId: String = "rec-1", output: String? = nil,
    retryable: Bool = false, abandoning: Bool = false, cleanupPending: Bool = false
) -> ExportsState.Record {
    .init(
        exportId: exportId, target: .project(projectId), kind: .video, revisionId: "r2", state: state,
        directory: "/Users/me/Exports", leaf: "demo.mp4", output: output, reason: nil,
        retryable: retryable, abandoning: abandoning, cleanupPending: cleanupPending)
}

func runExportTests() {
    var state = ready()
    state.library.projects = [try! JSONDecoder().decode(LibraryState.Project.self, from: Data(#"{"id":"rec-1","title":"Caller project","createdAt":"2026-09-15T18:04:05Z","currentRevisionId":"r-existing"}"#.utf8))]
    var exports = ExportsState()
    precondition(exportItems(state, exports).isEmpty, "No exports section until there is an export to show")

    // One save panel at a time; the project is exportable again once the destination is chosen.
    precondition(exports.beginChoice(target: .project("rec-1"), kind: .video) != nil, "A project can start an export")
    precondition(exports.beginChoice(target: .project("rec-1"), kind: .package) == nil, "A second panel is not opened")
    let items = LibraryPresentation.projects(for: state, exports: exports).items
    precondition(entry(items, "project.export.video.rec-1")?.enabled == false
        && entry(items, "project.export.processed-package.rec-1")?.enabled == false,
        "Export choices wait while a destination is being chosen")
    let request = ExportsState.Request(
        exportId: "e1", target: .project("rec-1"), kind: .video, revisionId: "r2",
        directory: "/Users/me/Exports", leaf: "demo.mp4")
    exports.send(request)
    precondition(entry(LibraryPresentation.projects(for: state, exports: exports).items, "project.export.video.rec-1")?.enabled == true,
        "A sent request does not block exporting again")
    precondition(exports.resend("e1") == nil, "An outstanding send is not sent twice")

    // A lost reply keeps the original identity for the person's explicit retry.
    exports.unanswered("e1", reason: "TIMEOUT: export.create did not answer in time")
    let pending = exportItems(state, exports)
    precondition(ExportPresentation.title(for: exports) == "Exports — needs attention", "An unconfirmed request needs attention")
    precondition(pending.first?.title == "demo.mp4" && pending.first?.status == "not confirmed"
                 && pending.first?.details.first?.hasPrefix("Video · ") == true && pending.first?.attention == true,
                 "The request names its file, says once that it is unconfirmed, and asks for attention")
    precondition(entry(pending, "export.resend.e1")?.enabled == true
        && entry(pending, "export.abandon.e1")?.enabled == true,
        "An unconfirmed request can be sent again or abandoned")
    precondition(exports.observed == ["e1"], "Status is read for an unconfirmed request in case it was admitted")
    precondition(exports.resend("e1") == request, "Sending again names the same export and destination")
    exports.unanswered("e1", reason: "SERVICE_STOPPED")

    var unavailable = state
    unavailable.service = .unavailable("offline")
    precondition(entry(exportItems(unavailable, exports), "export.resend.e1")?.enabled == false,
        "Nothing is sent while the service is unavailable")

    // Admission replaces the request with the service's description.
    exports.admit(record("e1", state: "queued"))
    precondition(exports.requests.isEmpty && exports.records.map(\.exportId) == ["e1"], "Admitted exports are records")
    precondition(ExportPresentation.title(for: exports) == "Exports — 1 in progress", "Queued work is in progress")
    precondition(exportItems(state, exports).first.map { $0.title == "demo.mp4" && $0.status == "waiting" && !$0.attention } == true,
        "A queued export waits, without asking for attention")
    precondition(entry(exportItems(state, exports), "export.abandon.e1")?.enabled == true,
        "An unfinished export can be abandoned")
    precondition(entry(exportItems(state, exports), "export.jobRetry.e1") == nil,
        "Work still running offers no retry")

    // Rediscovered exports keep their order behind this session's own.
    exports.update(record("e0", state: "failed", projectId: "rec-0"))
    exports.admit(record("e2", state: "running"))
    precondition(exports.records.map(\.exportId) == ["e2", "e1", "e0"], "Newest requests first, discovered after")

    // A non-retryable failure is abandoned, not retried; an action is sent once.
    var failed = exportItems(state, exports)
    precondition(entry(failed, "export.jobRetry.e0")?.enabled == false, "A permanent failure is not retried")
    precondition(exports.begin(.abandon, "e0") && !exports.begin(.abandon, "e0"), "Abandon is sent once")
    failed = exportItems(state, exports)
    precondition(entry(failed, "export.abandon.e0")?.title == "Abandoning…"
        && entry(failed, "export.abandon.e0")?.enabled == false, "A pending abandonment says so")
    exports.finish("e0", failure: "EXPORT_CLEANUP_FAILED: staging changed")
    precondition(exportItems(state, exports).last!.details.contains {
        $0 == "EXPORT_CLEANUP_FAILED: staging changed"
    }, "A refused abandonment stays visible with its reason")
    exports.update(record("e0", state: "failed", projectId: "rec-0", abandoning: true))
    precondition(entry(exportItems(state, exports), "export.abandon.e0")?.title == "Retry Abandon",
        "Unfinished abandonment is retried under the same export")
    exports.forget("e0")

    // A committed export keeps its receipt while private cleanup is retried.
    exports.update(record("e1", state: "ready", output: "/Users/me/Exports/demo.mp4", cleanupPending: true))
    let committed = exportItems(state, exports)
    precondition(entry(committed, "export.reveal.e1")?.enabled == true, "A committed file can be shown")
    precondition(entry(committed, "export.jobRetry.e1")?.title == "Retry Cleanup", "Retrying a commit only cleans up")
    precondition(entry(committed, "export.abandon.e1") == nil, "A committed export is not offered for abandonment")
    precondition(entry(committed, "export.dismiss.e1") == nil, "Pending cleanup cannot be dismissed")
    precondition(committed.contains { $0.title == "demo.mp4" && $0.status == "exported, cleanup pending" && $0.attention },
        "Cleanup does not hide that the export committed, and needs attention")
    precondition(exports.observed.contains("e1"), "Pending cleanup is still observed")
    exports.update(record("e1", state: "ready", output: "/Users/me/Exports/demo.mp4"))
    precondition(!exports.observed.contains("e1"), "A clean commit is no longer polled")
    precondition(entry(exportItems(state, exports), "export.dismiss.e1")?.enabled == true,
        "A clean commit can leave the list")
    exports.dismiss("e1")
    exports.dismiss("e2")
    precondition(exports.records.map(\.exportId) == ["e2"], "Only settled commits are dismissed")

    exports.forget(target: .project("rec-1"))
    precondition(exports.records.isEmpty && exportItems(state, exports).isEmpty,
        "A deleted project's exports leave the list")

    let status = Data(#"""
        {"id":"e9","kind":"processed-package","abandoning":false,"recovery":null,"projectId":"rec-9",
         "snapshot":{"revisionId":"r4","historyOrdinal":3},"state":"failed",
         "destination":{"directory":"/Volumes/Work","leaf":"take.zip"},"cleanupPending":true,
         "receipt":null,"output":null,"jobId":"j","reason":"Required evidence is unavailable","retryable":true}
        """#.utf8)
    guard let decoded = try? JSONDecoder().decode(ExportsState.Record.self, from: status) else {
        preconditionFailure("A service status decodes")
    }
    precondition(decoded.kind == .package && decoded.revisionId == "r4" && decoded.leaf == "take.zip"
        && decoded.output == nil && decoded.cleanupPending && decoded.retryable,
        "Status fields keep their meaning")
    for leaf in ["mix.wav", "mix.m4a"] {
        let fields: [String: Any] = [
            "id": "audio-" + leaf, "projectId": "p", "kind": "audio",
            "snapshot": ["revisionId": "r", "settings": ["container": leaf.hasSuffix("wav") ? "wav" : "m4a"]],
            "state": "failed", "destination": ["directory": "/tmp", "leaf": leaf],
            "retryable": true, "abandoning": false, "cleanupPending": false,
            "output": NSNull(), "reason": "fixture failure",
        ]
        let record = try! JSONDecoder().decode(ExportsState.Record.self,
            from: JSONSerialization.data(withJSONObject: fields))
        precondition(record.kind == .audio && record.leaf == leaf && record.target == .project("p"))
        var audio = ExportsState()
        audio.admit(record)
        let delivered = exportItems(ready(), audio)
        precondition(delivered.first.map { $0.title == leaf && $0.status == "failed" && $0.details.first?.hasPrefix("Audio · ") == true && $0.attention } == true)
        precondition(entry(delivered, "export.jobRetry.audio-" + leaf)?.enabled == true)
    }
    for kind in ["srt", "vtt"] {
        let fields: [String: Any] = [
            "id": "captions-" + kind, "projectId": "p", "kind": kind,
            "snapshot": ["revisionId": "r", "placementIds": ["caption"]],
            "state": "failed", "destination": ["directory": "/tmp", "leaf": "captions." + kind],
            "retryable": true, "abandoning": false, "cleanupPending": false,
            "output": NSNull(), "reason": "fixture failure",
        ]
        guard let record = try? JSONDecoder().decode(ExportsState.Record.self,
            from: JSONSerialization.data(withJSONObject: fields)) else {
            preconditionFailure("Managed caption status must decode: " + kind)
        }
        precondition(record.kind.rawValue == kind && record.target == .project("p"))
        var captions = ExportsState()
        captions.update(record)
        let delivered = exportItems(ready(), captions)
        precondition(delivered.first.map { $0.title == "captions." + kind && $0.status == "failed" && $0.details.first?.hasPrefix("Captions · ") == true && $0.attention } == true)
        precondition(entry(delivered, "export.jobRetry.captions-" + kind)?.enabled == true)
        precondition(entry(delivered, "export.abandon.captions-" + kind)?.enabled == true)
        precondition(captions.beginChoice(target: .project("p"), kind: record.kind) == nil,
            "The app has no caption-placement selection for authoring a sidecar")
    }
    if let path = ProcessInfo.processInfo.environment["YAP_AUDIO_EXPORT_RECORDS"] {
        let records = try! JSONDecoder().decode([ExportsState.Record].self,
            from: Data(contentsOf: URL(fileURLWithPath: path)))
        precondition(!records.isEmpty && records.allSatisfy { $0.kind == .audio })
        for record in records {
            var audio = ExportsState()
            audio.admit(record)
            precondition(exportItems(ready(), audio).first?.title.hasPrefix("Audio — " + record.leaf) == true)
        }
    }
    print("PASS exports keep one identity through lost replies, retry, abandonment and cleanup")
}
