import Darwin
import Foundation
import YapControls

struct CheckFailure: Error, LocalizedError {
    let message: String
    var errorDescription: String? { message }
}
@MainActor func require(_ condition: Bool, _ message: String) throws {
    if !condition { throw CheckFailure(message: message) }
}
@MainActor func until(_ condition: () -> Bool) async throws {
    for _ in 0..<400 where !condition() { try await Task.sleep(for: .milliseconds(5)) }
    try require(condition(), "Consumer did not settle within the existing observation budget")
}
@MainActor final class Evidence {
    let output: FileHandle
    init(_ path: String) throws {
        FileManager.default.createFile(atPath: path, contents: nil)
        output = try FileHandle(forWritingTo: URL(fileURLWithPath: path))
    }
    func record(_ value: [String: Any]) {
        let bytes = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        try! output.write(contentsOf: bytes + Data([10]))
    }
}
@MainActor final class Presentation: PreviewPresenting {
    let evidence: Evidence
    var movies: [[String: String]] = []
    var messages: [String] = []
    var active = false
    init(_ evidence: Evidence) { self.evidence = evidence }
    func open(title: String, retry: @escaping @MainActor () -> Void, closed: @escaping @MainActor () -> Void) {
        active = true; evidence.record(["presenter": "open", "title": title])
    }
    func show(title: String, message: String, canRetry: Bool) {
        messages.append(message)
        evidence.record(["presenter": "show", "title": title, "message": message, "canRetry": canRetry])
    }
    func play(title: String, file: String, mediaType: String, startAtUs: Int64?, failed: @escaping @MainActor (String) -> Void, ended: @escaping @MainActor () -> Void) {
        movies.append(["title": title, "file": file, "mediaType": mediaType])
        evidence.record(["presenter": "play-arguments-only", "title": title, "file": file, "mediaType": mediaType])
    }
    func close() { active = false; evidence.record(["presenter": "close"]) }
}
@MainActor final class Source {
    let evidence: Evidence
    var state: ServiceHost.State = .starting
    var host: ServiceHost!
    var exited = false
    var watcher: (any DispatchSourceProcess)?
    var calls: [[String: Any]] = []
    var refused: [[String: Any]] = []
    var preparing = true
    init(_ evidence: Evidence) { self.evidence = evidence }
    func call(_ operation: String, _ params: [String: Any]) async throws(ServiceFailure) -> Data {
        guard ["project.list", "project.get", "recording.list"].contains(operation) || operation == "project.create" && preparing else {
            refused.append(["operation": operation, "params": params])
            evidence.record(["scope": "actual-metadata", "refusedBeforeForward": operation, "params": params])
            throw ServiceFailure(code: "FIXTURE_METADATA_ONLY", message: "Preview dispatch observed before service submission")
        }
        let bytes = try await host.call(operation, params)
        let value = try! JSONSerialization.jsonObject(with: bytes)
        let exchange: [String: Any] = ["scope": "actual-metadata", "operation": operation, "params": params, "data": value]
        calls.append(exchange); evidence.record(exchange)
        return bytes
    }
    func watch(_ pid: Int32) {
        evidence.record(["event": "source-ready", "pid": pid])
        let watcher = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: .main)
        watcher.setEventHandler { [weak self] in
            Task { @MainActor in
                self?.exited = true
                self?.evidence.record(["event": "source-os-exit", "pid": pid])
            }
        }
        self.watcher = watcher; watcher.resume()
    }
}
@MainActor final class Historical {
    let evidence: Evidence
    let project: [String: Any], waiting: [String: Any], ready: [String: Any], empty: [String: Any]
    var showProject = false
    var previewCalls = 0
    var calls: [[String: Any]] = []
    var omitPin = false
    var holdReady = false
    var held: CheckedContinuation<Data, Never>?
    init(_ fixture: [String: Any], _ evidence: Evidence) {
        self.evidence = evidence
        project = fixture["project"] as! [String: Any]; waiting = fixture["waiting"] as! [String: Any]
        ready = fixture["ready"] as! [String: Any]; empty = fixture["empty"] as! [String: Any]
    }
    func call(_ operation: String, _ original: [String: Any]) async throws(ServiceFailure) -> Data {
        var params = original
        let value: [String: Any]
        switch operation {
        case "recording.list": value = ["recordings": [], "nextCursor": NSNull()]
        case "project.list": value = showProject ? ["projects": [project], "nextCursor": NSNull()] : empty
        case "project.get": value = project
        case "preview.get":
            previewCalls += 1
            if omitPin && previewCalls == 2 { params.removeValue(forKey: "revisionId") }
            value = previewCalls == 1 ? waiting : ready
        case "artifact.close": value = [:]
        default: throw ServiceFailure(code: "FIXTURE_UNEXPECTED", message: operation)
        }
        let row: [String: Any] = ["scope": "historical-replay", "operation": operation, "params": params, "data": value,
            "scriptedPageContainer": operation == "project.list" && showProject]
        calls.append(row); evidence.record(row)
        let bytes = try! JSONSerialization.data(withJSONObject: value)
        if holdReady && operation == "preview.get" && previewCalls == 2 {
            return await withCheckedContinuation { held = $0 }
        }
        return bytes
    }
    var closed: [String] { calls.filter { $0["operation"] as? String == "artifact.close" }.map { ($0["params"] as! [String: Any])["token"] as! String } }
}
@MainActor func library(_ call: @escaping LibraryController.Call, _ preview: PreviewController) -> LibraryController {
    LibraryController(call: call, changed: {}, closePreview: { preview.close(target: $0) }, forgetExports: { _ in },
        deleted: {}, preview: { preview.open($0) }, export: { _, _ in })
}
@MainActor func page(_ owner: LibraryController) -> [[String: String]] {
    owner.state.projects.map { ["projectId": $0.projectId, "title": $0.title, "createdAt": $0.createdAt, "currentRevisionId": $0.currentRevisionId] }
}
@main struct Check {
    @MainActor static func main() async {
        var source: Source?
        do {
            let config = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String: Any]
            let evidence = try Evidence(CommandLine.arguments[2])
            let fixture = config["historical"] as! [String: Any]
            if !CommandLine.arguments.contains("--historical-only") {
                let live = Source(evidence); source = live
                let bundle = config["bundle"] as! [String: Any]
                live.host = ServiceHost(bundle: ServiceBundle(script: URL(fileURLWithPath: bundle["script"] as! String),
                    node: bundle["nodePath"] as! String, native: URL(fileURLWithPath: bundle["native"] as! String),
                    controlFrameBytes: bundle["controlFrameBytes"] as! Int, maxPendingCalls: bundle["maxPendingCalls"] as! Int,
                    callTimeout: Double(bundle["callTimeoutMs"] as! Int) / 1000,
                    startupDeadline: Date().addingTimeInterval(Double(bundle["callTimeoutMs"] as! Int) / 1000)),
                    onNativeCall: { operation, _, answer in answer(.failure(ServiceFailure(code: "FIXTURE_NO_CAPTURE", message: operation))) },
                    onState: { state in Task { @MainActor in live.state = state } })
                live.host.start()
                try await until { if case .ready = live.state { return true }; if case .unavailable = live.state { return true }; return false }
                guard case .ready(let pid, _) = live.state else { throw CheckFailure(message: "Actual source service was unavailable") }
                live.watch(pid)
                var expected: [[String: String]] = []
                for ordinal in 1...6 {
                    let params: [String: Any] = ["requestId": "metadata-project-\(ordinal)", "title": "Explicit project \(ordinal)",
                        "canvas": ["width": 160, "height": 120, "fps": ["numerator": 10, "denominator": 1], "background": "#000000ff"]]
                    let value = try JSONSerialization.jsonObject(with: await live.call("project.create", params)) as! [String: Any]
                    expected.append(value["project"] as! [String: String])
                }
                live.preparing = false
                let presentation = Presentation(evidence)
                var failures: [String] = []
                let preview = PreviewController(call: live.call, presentation: presentation, failure: { failures.append($0) })
                let owner = library(live.call, preview)
                owner.serviceChanged(ready: true)
                try await until { !owner.state.projectsRefreshing && !owner.state.recent.isEmpty || !owner.state.projectsRefreshing && !owner.state.projects.isEmpty }
                try require(page(owner) == Array(expected.prefix(5)), "Actual first page must preserve complete public creation values")
                try require((live.calls.first { $0["operation"] as? String == "project.list" }!["params"] as! NSDictionary).isEqual(to: ["limit": 5]), "Actual first-page request must preserve the native page limit")
                evidence.record(["state": "actual-first-page", "projects": page(owner), "nextCursor": owner.state.nextProjectCursor.map { ["afterSequence": $0.afterSequence] } ?? [:]])
                let cursor = owner.state.nextProjectCursor!
                owner.nextProjects(); try await until { !owner.state.projectsRefreshing }
                try require(page(owner) == Array(expected.suffix(1)) && owner.state.hasPreviousProjectPage && owner.state.nextProjectCursor == nil,
                    "Actual continuation must preserve the final project and exhausted cursor")
                let continuation = live.calls.last { $0["operation"] as? String == "project.list" }!["params"] as! NSDictionary
                try require(continuation.isEqual(to: ["limit": 5, "cursor": ["afterSequence": cursor.afterSequence]]), "Continuation must send the returned cursor unchanged")
                evidence.record(["state": "actual-continuation-page", "projects": page(owner)])
                owner.previousProjects(); try await until { !owner.state.projectsRefreshing }
                try require(page(owner) == Array(expected.prefix(5)) && !owner.state.hasPreviousProjectPage, "Actual previous page must restore complete values")
                try require((live.calls.last { $0["operation"] as? String == "project.list" }!["params"] as! NSDictionary).isEqual(to: ["limit": 5]), "Previous navigation must request the original page")
                let selected = expected[2]
                let fetched = try JSONSerialization.jsonObject(with: await live.call("project.get", ["projectId": selected["projectId"]!])) as! NSDictionary
                try require(fetched.isEqual(to: selected), "Actual selected project.get must preserve all page metadata")
                owner.perform(.previewProject(selected["projectId"]!))
                try await until { !failures.isEmpty }
                try require(live.refused.count == 1 && live.refused[0]["operation"] as? String == "preview.get" && (live.refused[0]["params"] as! NSDictionary).isEqual(to: ["projectId": selected["projectId"]!]), "Actual library action must dispatch exactly the selected project owner")
                try require(presentation.movies.isEmpty && failures.last!.contains("FIXTURE_METADATA_ONLY"), "Metadata action must stop before live preview submission")
                preview.close(); live.host.shutdown(); try await until { live.exited }
                live.watcher?.cancel(); evidence.record(["check": "actual-metadata-pages-get-and-composed-dispatch", "passed": true])
                source = nil
            }
            let historical = Historical(fixture, evidence)
            historical.omitPin = CommandLine.arguments.contains("--omit-second-pin")
            let presentation = Presentation(evidence)
            let ready = historical.ready
            let token = (ready["delivery"] as! [String: Any])["token"] as! String
            let expiry = (ready["delivery"] as! [String: Any])["expiresAt"] as! Double
            let clock = Date(timeIntervalSince1970: expiry / 1000 - 20)
            evidence.record(["scope": "historical-replay", "clockUnixMs": clock.timeIntervalSince1970 * 1000])
            var failures: [String] = []
            let preview = PreviewController(call: historical.call, presentation: presentation, now: { clock }, failure: { failures.append($0) })
            let owner = library(historical.call, preview)
            // As the app does: the preview is titled by the name the Library holds for the project.
            preview.projectTitle = { id in owner.state.projects.first { $0.projectId == id }?.title }
            owner.serviceChanged(ready: true); try await until { !owner.state.projectsRefreshing }
            try require(page(owner).isEmpty && owner.state.nextProjectCursor == nil, "Retained actual empty page must remain empty")
            historical.showProject = true; owner.refreshProjects(); try await until { !owner.state.projectsRefreshing }
            try require(page(owner) == [historical.project as! [String: String]], "Scripted navigation must preserve the unchanged actual metadata row")
            let id = historical.project["projectId"] as! String, revision = historical.waiting["revisionId"] as! String
            owner.perform(.previewProject(id)); try await until { !presentation.messages.isEmpty }
            preview.tick(); try await until { !presentation.movies.isEmpty || !failures.isEmpty }
            let requests = historical.calls.filter { $0["operation"] as? String == "preview.get" }.map { $0["params"] as! NSDictionary }
            try require(requests.count == 2 && requests[0].isEqual(to: ["projectId": id]) && requests[1].isEqual(to: ["projectId": id, "revisionId": revision]),
                "Historical preview request must retain the first returned revision")
            let movie = (ready["published"] as! [String: Any])["output"] as! [String: Any]
            try require(presentation.movies == [["title": owner.state.projects.first { $0.projectId == id }!.title, "file": movie["file"] as! String, "mediaType": movie["mediaType"] as! String]],
                "Historical ready receipt must dispatch its exact movie path and revision")
            preview.tick(); try await until { historical.calls.contains { $0["operation"] as? String == "project.get" } }
            try require(presentation.movies.count == 1 && failures.isEmpty, "Different actual historical head must not replace preview pin")
            preview.close(target: .recording(id)); try require(presentation.active && historical.closed.isEmpty, "Same-ID recording must not close the historical project")
            preview.close(target: .project(id)); try await until { historical.closed == [token] }
            historical.previewCalls = 0; historical.holdReady = true
            owner.perform(.previewProject(id)); try await until { presentation.messages.count == 2 }
            preview.tick(); try await until { historical.held != nil }
            preview.close(); historical.held!.resume(returning: try JSONSerialization.data(withJSONObject: ready)); historical.held = nil
            try await until { historical.closed == [token, token] }
            try require(!presentation.active && presentation.movies.count == 1, "Late historical ready answer must release without presentation")
            evidence.record(["check": "historical-composed-readiness-pin-close-and-late-answer", "passed": true])
            print("PASS source metadata and composed historical preview consumption")
        } catch {
            if let source { source.host?.shutdown(); try? await until { source.exited }; source.watcher?.cancel() }
            FileHandle.standardError.write(Data(("FAIL \(error.localizedDescription)\n").utf8)); exit(1)
        }
    }
}
