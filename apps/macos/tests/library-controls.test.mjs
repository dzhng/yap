import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compileControlsCheck } from "./fixtures/swift-controls.mjs";

test(
  "native library reads explicit project pages and preserves fresh source facts",
  { timeout: 90_000 },
  () => {
    const scratch = mkdtempSync(join(tmpdir(), "yap-library-controls-"));
    try {
      const executable = compileControlsCheck(
        scratch,
        ["LibraryController", "ServiceBundle", "NodeRuntime"],
        String.raw`
import Foundation
import YapControls
@MainActor final class Script {
    var calls: [(String, [String: Any])] = []
    static var exchanges: [[String: Any]] = []
    var recordingCursorOverride: Any?
    var recordingCatalog: [[String: Any]]?
    var recordingNext: Any = NSNull()
    var next: Any = "project-cursor"
    var projects: [[String: Any]] = [["projectId": "same", "title": "Caller project", "createdAt": "2026-10-01T01:00:00Z", "currentRevisionId": "r-project"]]
    var recording: [String: Any] = ["recordingId": "same", "createdAt": "2026-10-01T01:00:00Z", "state": "complete", "sourceId": "source-one", "creationSequence": 1, "lifecycleSequence": 3, "interruptionReason": NSNull(), "interruptionMessage": NSNull(), "finalizationError": NSNull(), "sourceDurationUs": 9000000, "sourceAdmissions": []]
    var deletes: [MediaTarget] = []
    var deletedTargets: Set<MediaTarget> = []
    var wrongDelete = false
    /// When set, a plain delete is refused IN_USE with these details; a cascade goes through.
    var inUse: [String: Any]?
    var lostDelete: String?
    var failure: (String, String)?
    var hold: String?
    var held: CheckedContinuation<Data, Never>?
    var heldAnswer: Data?
    var job: [String: Any] = ["jobId": "job-one", "state": "running", "attemptId": "attempt-one", "artifact": "acquisition.import", "lane": "heavy", "attemptGeneration": 1, "reason": NSNull(), "errorCode": NSNull(), "errorDetails": NSNull(), "retryable": false, "inputSha256": String(repeating: "1", count: 64), "result": NSNull(), "target": ["kind": "acquisition", "acquisitionId": "acq-one"]]
    func count(_ operation: String) -> Int { calls.filter { $0.0 == operation }.count }
    func release() { let waiting = held; held = nil; waiting?.resume(returning: heldAnswer!); heldAnswer = nil }

    func call(_ operation: String, _ params: [String: Any]) async throws(ServiceFailure) -> Data {
        calls.append((operation, params))
        if let failure, failure.0 == operation {
            self.failure = nil
            Self.exchanges.append(["operation": operation, "params": params, "error": failure.1])
            throw ServiceFailure(code: failure.1, message: "scripted refusal")
        }
        let answer: [String: Any]
        switch operation {
        case "media.list":
            // The Recordings tab pages media.list; each recording's own facts come from recording.get.
            func row(_ take: [String: Any]) -> [String: Any] {
                ["kind": "recording", "recordingId": take["recordingId"]!, "title": take["createdAt"]!,
                 "durationUs": take["sourceDurationUs"] as? Int ?? 0, "sizeBytes": 4096, "createdAt": take["createdAt"]!]
            }
            if let recordingCatalog {
                // The fake's opaque cursor still pins the page position, as the service's does.
                let before = (params["cursor"] as? String).flatMap { Int($0.dropFirst("before-".count)) } ?? Int.max
                let eligible = recordingCatalog.filter { ($0["creationSequence"] as! Int) < before && !deletedTargets.contains(.recording($0["recordingId"] as! String)) }
                let page = Array(eligible.prefix(params["limit"] as! Int))
                answer = ["media": page.map(row), "nextCursor": recordingCursorOverride ?? (eligible.count > page.count ? "before-\(page.last!["creationSequence"] as! Int)" : NSNull())]
            } else {
                answer = ["media": deletedTargets.contains(.recording(recording["recordingId"] as! String)) ? [] : [row(recording)], "nextCursor": recordingNext]
            }
        case "project.list": answer = ["projects": projects.filter { !deletedTargets.contains(.project($0["projectId"] as? String ?? "")) }, "nextCursor": next]
        case "recording.get":
            answer = recordingCatalog?.first { $0["recordingId"] as? String == params["recordingId"] as? String } ?? recording
        case "job.get": answer = job
        case "processing.status": answer = ["state": params["artifact"] as? String == "transcript" ? "processing" : "ready", "reason": NSNull()]
        case "index.get": answer = ["state": "ready", "page": [:], "reason": NSNull()]
        case "recording.delete", "project.delete", "asset.delete":
            let target: MediaTarget = params["projectId"].map { .project($0 as! String) }
                ?? params["assetId"].map { .asset($0 as! String) } ?? .recording(params["recordingId"] as! String)
            if let inUse, params["cascade"] as? Bool != true {
                Self.exchanges.append(["operation": operation, "params": params, "error": "IN_USE"])
                throw ServiceFailure(code: "IN_USE", message: "used by projects", details: try! JSONSerialization.data(withJSONObject: inUse))
            }
            deletes.append(target)
            if !wrongDelete { deletedTargets.insert(deletes.last!) }
            let owner: [String: Any] = target.parameters
            answer = (wrongDelete ? ["projectId": "wrong-target"] : owner).merging(["deleted": true, "freedBytes": 4096]) { first, _ in first }
        default: throw ServiceFailure(code: "UNKNOWN_OPERATION", message: operation)
        }
        if let lostDelete, operation.hasSuffix(".delete") {
            self.lostDelete = nil
            Self.exchanges.append(["operation": operation, "params": params, "error": lostDelete, "admittedReceipt": answer])
            throw ServiceFailure(code: lostDelete, message: "accepted deletion lost its reply")
        }
        Self.exchanges.append(["operation": operation, "params": params, "answer": answer])
        let bytes = try! JSONSerialization.data(withJSONObject: answer)
        if hold == operation {
            hold = nil; heldAnswer = bytes
            return await withCheckedContinuation { held = $0 }
        }
        return bytes
    }
}
@main struct Check {
    @MainActor static func until(line: Int = #line, _ ready: () -> Bool) async {
        for _ in 0..<200 where !ready() { try? await Task.sleep(for: .milliseconds(10)) }
        precondition(ready(), "Timed out at \(line)")
    }
    @MainActor static func main() async {
        let script = Script()
        var closed: [MediaTarget] = [], forgotten: [MediaTarget] = [], previews: [MediaTarget] = []
        var exports: [(MediaTarget, ExportsState.Kind)] = []
        let library = LibraryController(call: { operation, params throws(ServiceFailure) in try await script.call(operation, params) }, confirm: { _ in true }, changed: {}, closePreview: { closed.append($0) }, forgetExports: { forgotten.append($0) }, deleted: {}, preview: { previews.append(.project($0)) }, export: { exports.append((.project($0), $1)) })
        library.serviceChanged(ready: true)
        await until { !library.state.projectsRefreshing && library.state.recent.count == 1 }
        precondition(library.state.projects.map(\.projectId) == ["same"])
        let originalRecordings = library.state.recent
        script.recordingNext = ["afterSequence": 7]
        library.refreshRecordings()
        await until { library.state.recordingFailure != nil }
        precondition(library.state.recent == originalRecordings, "A project cursor cannot authorize recording continuation")
        script.recordingNext = NSNull()
        library.refreshRecordings()
        await until { library.state.recordingFailure == nil }
        script.recordingNext = ["beforeSequence": 0]
        library.refreshRecordings()
        await until { library.state.recordingFailure != nil }
        precondition(library.state.recent == originalRecordings, "Recording continuation must move toward older positive sequences")
        script.recordingNext = NSNull()
        library.refreshRecordings()
        await until { library.state.recordingFailure == nil }


        var state = ControlsState(); state.service = .ready; state.library = library.state
        let recordingActions = LibraryPresentation.recordings(for: state).items.flatMap(\.actions)
        precondition(recordingActions.map(\.action) == [.playRecording("same"), .copyRecordingPrompt("same"), .deleteRecording("same")], "Recordings expose playback, agent handoff and deletion")
        let projectActions = LibraryPresentation.projects(for: state, exports: .init()).items.flatMap(\.actions)
        precondition(projectActions.first { $0.action == .previewProject("same") }?.enabled == true)
        precondition(!script.calls.contains { ["processing.status", "index.get"].contains($0.0) })
        precondition(library.perform(.previewProject("same")))
        precondition(library.perform(.exportProject("same", .package)))
        precondition(previews == [.project("same")] && exports.count == 1 && exports[0].0 == .project("same") && exports[0].1 == .package, "Explicit actions preserve namespace and refuse a fresh recording composition")
        precondition(!library.perform(.pauseOrResume), "Capture transport remains with its existing owner")
        script.projects = [["projectId": "later", "title": "Later caller project", "createdAt": "2026-10-01T02:00:00Z", "currentRevisionId": "r-later"]]; script.next = NSNull()
        library.nextProjects()
        for _ in 0..<200 where !(library.state.projects.first?.projectId == "later" && !library.state.projectsRefreshing) { try? await Task.sleep(for: .milliseconds(10)) }
        precondition(library.state.projects.first?.projectId == "later" && !library.state.projectsRefreshing)
        precondition(script.calls.last { $0.0 == "project.list" }!.1["cursor"] as? String == "project-cursor")
        precondition(library.state.hasPreviousProjectPage && library.state.nextProjectCursor == nil)
        // A bad page retains the last usable page and cannot invent navigation.
        let lastProjects = library.state.projects
        script.projects = [["projectId": "broken"]]
        library.refreshProjects()
        await until { library.state.projectFailure != nil && !library.state.projectsRefreshing }
        precondition(library.state.projects == lastProjects && library.state.nextProjectCursor == nil)
        script.failure = ("project.list", "SERVICE_UNAVAILABLE")
        library.refreshProjects()
        await until { library.state.projectFailure?.contains("SERVICE_UNAVAILABLE") == true }
        precondition(library.state.projects == lastProjects)
        script.projects = [["projectId": "later", "title": "Later caller project", "createdAt": "2026-10-01T02:00:00Z", "currentRevisionId": "r-later"]]
        library.refreshProjects()
        await until { library.state.projectFailure == nil && !library.state.projectsRefreshing }
        library.delete(.recording("same"))
        await until { forgotten == [.recording("same")] }
        precondition(closed == [.recording("same")] && library.state.projects.first?.projectId == "later")
        await until { library.state.recent.isEmpty && !library.state.projectsRefreshing }
        library.delete(.project("later"))
        await until { forgotten == [.recording("same"), .project("later")] }
        precondition(closed == forgotten)

        // Recording facts remain readable without any composition or artifact polling.
        script.deletedTargets.remove(.recording("same"))
        library.refreshRecordings()
        await until { library.state.recent.count == 1 }
        let lastTake = library.state.recent
        script.failure = ("media.list", "SERVICE_UNAVAILABLE")
        library.refreshRecordings()
        await until { library.state.recordingFailure?.contains("SERVICE_UNAVAILABLE") == true }
        precondition(library.state.recent == lastTake, "Failed source reads retain the last good facts")
        library.refreshRecordings()
        await until { library.state.recordingFailure == nil }
        precondition(!script.calls.contains { ["processing.status", "index.get"].contains($0.0) })

        // Pending source admission is discovered without restarting work; terminal jobs stop reads.
        let source = Script()
        source.recording["sourceAdmissions"] = [["kind": "primary", "sourceId": "source-one", "acquisitionId": NSNull(), "job": NSNull(), "admissionError": NSNull()]]
        let progress = LibraryController(call: { op, params throws(ServiceFailure) in try await source.call(op, params) }, confirm: { _ in true }, changed: {}, closePreview: { _ in }, forgetExports: { _ in }, deleted: {}, preview: { _ in }, export: { _, _ in })
        progress.serviceChanged(ready: true)
        await until { progress.state.recent.count == 1 }
        // The page read asks each listed recording for its own facts once; ticks are counted after it.
        let pageReads = source.count("recording.get")
        precondition(pageReads == 1, "The page reads its one recording once")
        source.recording["sourceAdmissions"] = [["kind": "primary", "sourceId": "source-one", "acquisitionId": "acq-one", "job": source.job, "admissionError": NSNull()]]
        progress.tick()
        await until { progress.state.recent.first?.sourceAdmissions?.first?.job?.state == "running" }
        precondition(source.count("recording.get") == pageReads + 1 && source.count("job.get") == 0)
        source.job["state"] = "ready"
        progress.tick()
        await until { progress.state.recent.first?.sourceAdmissions?.first?.job?.state == "ready" }
        for _ in 0..<10 { progress.tick(); await Task.yield() }
        precondition(source.count("job.get") == 1 && !source.calls.contains { ["job.retry", "acquisition.import", "processing.status", "index.get"].contains($0.0) })

        // A camera that was never turned on publishes nothing to admit. The take is complete and
        // settled: no admission is awaited and the recording reads Ready, not as a failure.
        let neverOn = Script()
        neverOn.job["state"] = "ready"
        neverOn.recording["sourceAdmissions"] = [
            ["kind": "primary", "sourceId": "source-one", "acquisitionId": "acq-one", "job": neverOn.job, "admissionError": NSNull(), "publication": ["state": "published", "error": NSNull()]],
            ["kind": "camera", "sourceId": "camera-one", "acquisitionId": NSNull(), "job": NSNull(), "admissionError": NSNull(), "publication": ["state": "unavailable", "error": ["code": "CAMERA_NOT_TURNED_ON", "message": "The camera was never turned on"]]],
        ]
        let settled = LibraryController(call: { op, params throws(ServiceFailure) in try await neverOn.call(op, params) }, confirm: { _ in true }, changed: {}, closePreview: { _ in }, forgetExports: { _ in }, deleted: {}, preview: { _ in }, export: { _, _ in })
        settled.serviceChanged(ready: true)
        await until { settled.state.recent.count == 1 && !settled.state.projectsRefreshing }
        let settledReads = neverOn.count("recording.get")
        for _ in 0..<10 { settled.tick(); await Task.yield() }
        precondition(neverOn.count("recording.get") == settledReads && neverOn.count("job.get") == 0,
                     "A never-turned-on camera leaves nothing to poll: \(neverOn.calls.map(\.0))")
        var neverOnState = ControlsState(); neverOnState.service = .ready; neverOnState.library = settled.state
        let neverOnRow = LibraryPresentation.recordings(for: neverOnState).items[0]
        precondition(neverOnRow.status == "Ready" && neverOnRow.details == ["0:09", "Microphone audio"],
                     "A never-turned-on camera is not an error row: \(neverOnRow.status) \(neverOnRow.details)")
        settled.serviceChanged(ready: false)

        // A delayed job answer for the old row cannot clear the next row's source job failure.
        let overlapping = Script()
        overlapping.recording["sourceAdmissions"] = [["kind": "primary", "sourceId": "source-one", "acquisitionId": "acq-one", "job": overlapping.job, "admissionError": NSNull()]]
        let progressOwner = LibraryController(call: { op, params throws(ServiceFailure) in try await overlapping.call(op, params) }, confirm: { _ in true }, changed: {}, closePreview: { _ in }, forgetExports: { _ in }, deleted: {}, preview: { _ in }, export: { _, _ in })
        progressOwner.serviceChanged(ready: true)
        await until { progressOwner.state.recent.count == 1 && !progressOwner.state.projectsRefreshing }
        overlapping.hold = "job.get"; progressOwner.tick()
        await until { overlapping.held != nil }
        overlapping.recording["recordingId"] = "new-progress-owner"
        progressOwner.refreshRecordings()
        await until { progressOwner.state.recent.first?.recordingId == "new-progress-owner" }
        overlapping.failure = ("media.list", "NOT_READY"); progressOwner.refreshRecordings()
        await until { progressOwner.state.recordingFailure?.contains("NOT_READY") == true }
        overlapping.release()
        for _ in 0..<20 { await Task.yield() }
        precondition(progressOwner.state.recent.first?.recordingId == "new-progress-owner" && progressOwner.state.recordingFailure?.contains("NOT_READY") == true, "An obsolete job reply must not clear another owner's read failure")
        progressOwner.serviceChanged(ready: false)

        // Lost/malformed deletion keeps the typed identity even after discovery hides its owner.
        let lost = Script()
        var lostClosed: [MediaTarget] = [], lostForgotten: [MediaTarget] = []
        let deletion = LibraryController(call: { op, params throws(ServiceFailure) in try await lost.call(op, params) }, confirm: { _ in true }, changed: {}, closePreview: { lostClosed.append($0) }, forgetExports: { lostForgotten.append($0) }, deleted: {}, preview: { _ in }, export: { _, _ in })
        deletion.serviceChanged(ready: true)
        await until { deletion.state.projects.count == 1 && deletion.state.recent.count == 1 }
        lost.lostDelete = "TIMEOUT"
        deletion.delete(.project("same"))
        await until { deletion.state.deletions[.project("same")]?.failure?.contains("TIMEOUT") == true }
        deletion.refreshProjects()
        await until { deletion.state.projects.isEmpty && !deletion.state.projectsRefreshing }
        precondition(deletion.state.recent.first?.recordingId == "same" && lostForgotten.isEmpty)
        deletion.serviceChanged(ready: false)
        let before = lost.count("project.delete")
        deletion.delete(.project("same")); await Task.yield()
        precondition(lost.count("project.delete") == before, "Unavailable service refuses deletion outside menu clicks")
        deletion.serviceChanged(ready: true)
        lost.wrongDelete = true
        deletion.delete(.project("same"))
        await until { deletion.state.deletions[.project("same")]?.failure != nil || !lostForgotten.isEmpty }
        precondition(lostForgotten.isEmpty && deletion.state.deletions[.project("same")]?.failure?.contains("INVALID_RESPONSE") == true, "A different typed deletion receipt must not forget the selected owner")
        lost.wrongDelete = false
        deletion.delete(.project("same"))
        await until { lostForgotten == [.project("same")] }
        precondition(lost.calls.filter { $0.0 == "project.delete" }.allSatisfy { ($0.1["projectId"] as? String) == "same" && $0.1["recordingId"] == nil })
        precondition(Set(lost.calls.filter { $0.0 == "project.delete" }.compactMap { $0.1["requestId"] as? String }).count == 1,
            "Every retry of one deletion replays the same requestId")
        precondition(deletion.state.recent.first?.recordingId == "same")

        // A page read held over deletion cannot restore the deleted project on release.
        let late = Script()
        let fenced = LibraryController(call: { op, params throws(ServiceFailure) in try await late.call(op, params) }, confirm: { _ in true }, changed: {}, closePreview: { _ in }, forgetExports: { _ in }, deleted: {}, preview: { _ in }, export: { _, _ in })
        fenced.serviceChanged(ready: true)
        await until { fenced.state.projects.count == 1 && !fenced.state.projectsRefreshing }
        late.hold = "project.list"; fenced.refreshProjects()
        await until { late.held != nil }
        fenced.delete(.project("same"))
        await until { fenced.state.deletions.isEmpty && fenced.state.projects.isEmpty }
        late.release()
        for _ in 0..<20 { await Task.yield() }
        precondition(fenced.state.projects.isEmpty, "Late discovery cannot restore a deleted owner")
        // A changed page or service generation rejects old answers, including old action receipts.
        let changed = Script()
        let generation = LibraryController(call: { op, params throws(ServiceFailure) in try await changed.call(op, params) }, confirm: { _ in true }, changed: {}, closePreview: { _ in }, forgetExports: { _ in }, deleted: {}, preview: { _ in }, export: { _, _ in })
        generation.serviceChanged(ready: true)
        await until { generation.state.projects.count == 1 && !generation.state.projectsRefreshing }
        changed.projects = [["projectId": "page-two", "title": "Second page", "createdAt": "2026-10-01T02:00:00Z", "currentRevisionId": "r-two"]]; changed.next = NSNull()
        generation.nextProjects()
        await until { generation.state.projects.first?.projectId == "page-two" && !generation.state.projectsRefreshing }
        changed.hold = "project.list"; generation.refreshProjects()
        await until { changed.held != nil }
        changed.projects = [["projectId": "page-one", "title": "First page", "createdAt": "2026-10-01T01:00:00Z", "currentRevisionId": "r-one"]]; changed.next = "project-cursor"
        generation.previousProjects()
        await until { generation.state.projects.first?.projectId == "page-one" && !generation.state.projectsRefreshing }
        changed.release()
        for _ in 0..<20 { await Task.yield() }
        precondition(generation.state.projects.first?.projectId == "page-one" && !generation.state.hasPreviousProjectPage)
        changed.hold = "media.list"; generation.refreshRecordings()
        await until { changed.held != nil }
        changed.recording["recordingId"] = "replacement"
        generation.serviceChanged(ready: false); generation.serviceChanged(ready: true)
        await until { generation.state.recent.first?.recordingId == "replacement" }
        changed.release()
        for _ in 0..<20 { await Task.yield() }
        precondition(generation.state.recent.first?.recordingId == "replacement", "Old service catalog must not replace a current observation")
        let lastRecording = generation.state.recent
        changed.recording["projectId"] = "also-project"
        generation.refreshRecordings()
        await until { generation.state.recordingFailure != nil }
        precondition(generation.state.recent == lastRecording, "Dual namespace recording response remains visibly malformed")
        changed.recording.removeValue(forKey: "projectId")
        generation.refreshRecordings()
        await until { generation.state.recordingFailure == nil }
        // Every ambiguity classification retains one exact target for explicit replay.
        for code in ["INVALID_RESPONSE", "SERVICE_STOPPED", "SERVICE_UNAVAILABLE"] {
            let ambiguous = Script()
            var retired: [MediaTarget] = []
            let recovery = LibraryController(call: { op, params throws(ServiceFailure) in try await ambiguous.call(op, params) }, confirm: { _ in true }, changed: {}, closePreview: { _ in }, forgetExports: { retired.append($0) }, deleted: {}, preview: { _ in }, export: { _, _ in })
            recovery.serviceChanged(ready: true)
            await until { recovery.state.projects.count == 1 && !recovery.state.projectsRefreshing }
            ambiguous.lostDelete = code
            recovery.delete(.project("same"))
            await until { recovery.state.deletions[.project("same")]?.failure?.contains(code) == true }
            precondition(retired.isEmpty && ambiguous.count("project.delete") == 1)
            recovery.delete(.project("same"))
            await until { retired == [.project("same")] }
            precondition(ambiguous.count("project.delete") == 2)
            precondition(Set(ambiguous.calls.filter { $0.0 == "project.delete" }.compactMap { $0.1["requestId"] as? String }).count == 1,
                "Replaying an ambiguous deletion resends its original requestId")
            recovery.serviceChanged(ready: false)
        }
        // A bounded recording continuation remains older even when a new take arrives.
        let paged = Script()
        func row(_ sequence: Int) -> [String: Any] {
            paged.recording.merging(["recordingId": "take-\(sequence)", "creationSequence": sequence]) { _, value in value }
        }
        paged.recordingCatalog = (1...7).reversed().map(row)
        let browsing = LibraryController(call: { op, params throws(ServiceFailure) in try await paged.call(op, params) }, confirm: { _ in true }, changed: {}, closePreview: { _ in }, forgetExports: { _ in }, deleted: {}, preview: { _ in }, export: { _, _ in })
        browsing.serviceChanged(ready: true)
        await until { browsing.state.recent.map(\.recordingId) == ["take-7", "take-6", "take-5", "take-4", "take-3"] }
        paged.recordingCatalog!.insert(row(8), at: 0)
        browsing.nextRecordings()
        await until { browsing.state.recent.map(\.recordingId) == ["take-2", "take-1"] }
        precondition(browsing.state.hasPreviousRecordingPage && browsing.state.nextRecordingCursor == nil)
        browsing.previousRecordings()
        await until { browsing.state.recent.map(\.recordingId) == ["take-8", "take-7", "take-6", "take-5", "take-4"] }
        precondition(!browsing.state.hasPreviousRecordingPage && browsing.state.nextRecordingCursor != nil)
        precondition(paged.calls.filter { $0.0 == "media.list" }.allSatisfy { ($0.1["limit"] as? Int) == 5 }, "Browsing never widens the catalog read")
        // An old page's held preparation read cannot starve the current page.
        paged.recordingCatalog = (1...7).reversed().map { sequence in
            row(sequence).merging(["sourceAdmissions": [["kind": "primary", "sourceId": "source-one", "acquisitionId": "acq-one", "job": paged.job, "admissionError": NSNull()]]]) { _, value in value }
        }
        browsing.refreshRecordings()
        await until { browsing.state.recent.first?.sourceAdmissions?.first?.job?.state == "running" && !browsing.state.recordingsRefreshing }
        paged.hold = "job.get"; browsing.tick()
        await until { paged.held != nil }
        browsing.nextRecordings()
        await until { browsing.state.recent.map(\.recordingId) == ["take-2", "take-1"] }
        paged.job["state"] = "ready"
        browsing.tick()
        await until { browsing.state.recent.allSatisfy { $0.sourceAdmissions?.first?.job?.state == "ready" } }
        paged.release()
        for _ in 0..<20 { await Task.yield() }
        precondition(browsing.state.recent.allSatisfy { $0.sourceAdmissions?.first?.job?.state == "ready" }, "Delayed previous-page jobs cannot overwrite current source facts")
        for invalid in [["beforeSequence": 3], ["beforeSequence": 9], ["afterSequence": 1]] {
            let olderPage = browsing.state.recent
            paged.recordingCursorOverride = invalid
            browsing.refreshRecordings()
            await until { browsing.state.recordingFailure != nil && !browsing.state.recordingsRefreshing }
            precondition(browsing.state.recent == olderPage && browsing.state.nextRecordingCursor == nil, "Bad continuation must retain the complete last-good page")
            paged.recordingCursorOverride = nil
            browsing.refreshRecordings()
            await until { browsing.state.recordingFailure == nil && !browsing.state.recordingsRefreshing }
        }
        // Backward navigation supersedes an older read of the page being left.
        paged.hold = "media.list"; browsing.refreshRecordings()
        await until { paged.held != nil }
        browsing.previousRecordings()
        await until { browsing.state.recent.first?.recordingId == "take-7" && !browsing.state.recordingsRefreshing }
        paged.release()
        for _ in 0..<20 { await Task.yield() }
        precondition(browsing.state.recent.map(\.recordingId) == ["take-7", "take-6", "take-5", "take-4", "take-3"] && !browsing.state.hasPreviousRecordingPage)
        // A deletion pinned on one page stays the same typed request after navigation.
        paged.lostDelete = "TIMEOUT"
        browsing.delete(.recording("take-7"))
        await until { browsing.state.deletions[.recording("take-7")]?.failure?.contains("TIMEOUT") == true && !browsing.state.recordingsRefreshing }
        let deleteTitle = browsing.state.deletions[.recording("take-7")]!.title
        browsing.nextRecordings()
        await until { browsing.state.hasPreviousRecordingPage && !browsing.state.recordingsRefreshing }
        browsing.delete(.recording("take-7"))
        precondition(browsing.state.deletions[.recording("take-7")]?.title == deleteTitle, "Retry keeps the original visible title")
        await until { browsing.state.deletions[.recording("take-7")] == nil && !browsing.state.recordingsRefreshing }
        precondition(paged.deletes == [.recording("take-7"), .recording("take-7")], "Retry targets its captured recording, not a row occupying its old position")
        browsing.serviceChanged(ready: false)
        for consumer in [library, progress, deletion, fenced, generation] { consumer.serviceChanged(ready: false) }

        // One dialog: asked before the first call, and again from an IN_USE refusal's own details.
        let asking = Script()
        asking.recording["sourceAdmissions"] = []
        var asked: [DeleteConfirmation] = []
        var answer = false
        let confirmed = LibraryController(call: { op, params throws(ServiceFailure) in try await asking.call(op, params) }, confirm: { asked.append($0); return answer }, changed: {}, closePreview: { _ in }, forgetExports: { _ in }, deleted: {}, preview: { _ in }, export: { _, _ in })
        confirmed.serviceChanged(ready: true)
        await until { confirmed.state.recent.count == 1 && !confirmed.state.projectsRefreshing }
        confirmed.perform(.deleteRecording("same"))
        await until { asked.count == 1 }
        for _ in 0..<20 { await Task.yield() }
        precondition(asked[0].confirm == "Delete" && !asked[0].cascade && asking.count("recording.delete") == 0
                     && confirmed.state.deletions.isEmpty, "Cancel sends nothing and leaves no deletion behind")
        asking.inUse = ["recordingId": "same", "usedBy": [["kind": "project", "projectId": "p", "title": "Q4 demo", "revisions": 14]],
            "acquisitions": [], "derivedAssets": [], "freesBytes": 10, "cascadeFreesBytes": 2000]
        answer = true
        confirmed.perform(.deleteRecording("same"))
        await until { asked.count == 3 }
        await until { confirmed.state.deletions.isEmpty && asking.deletes == [.recording("same")] }
        let sent = Script.exchanges.filter { $0["operation"] as? String == "recording.delete" }.suffix(2).map { $0["params"] as! [String: Any] }
        precondition(asked[2].cascade && asked[2].confirm == "Delete all" && asked[2].users == ["Project “Q4 demo” — 14 revisions"],
                     "The refusal becomes the cascade dialog, listing its users: \(asked[2])")
        precondition(sent.count == 2 && sent[0]["cascade"] == nil && sent[1]["cascade"] as? Bool == true
                     && sent[0]["requestId"] as? String != sent[1]["requestId"] as? String,
                     "The plain delete goes first; confirming the cascade sends cascade:true as its own request: \(sent)")
        asking.inUse = nil
        confirmed.serviceChanged(ready: false)
        print("PASS native library pages, typed deletion and source-only recording facts")
        print(String(data: try! JSONSerialization.data(withJSONObject: Script.exchanges), encoding: .utf8)!)
    }
}
`,
      );
      const output = execFileSync(executable, { encoding: "utf8", timeout: 30_000 });
      assert.match(output, /PASS native library pages/);
      process.stdout.write(output);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);
