import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { generatedVideoProject } from "./fixtures/generated-project.mjs";
import { compileControlsCheck } from "./fixtures/swift-controls.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));

test(
  "native exports pin the revision, keep one identity through lost replies and rediscover pages",
  { timeout: 120_000 },
  () => {
    const scratch = mkdtempSync(join(tmpdir(), "yap-export-controls-"));
    try {
      const firstDirectory = join(scratch, "exports");
      const secondDirectory = join(scratch, "packages");
      mkdirSync(firstDirectory);
      mkdirSync(secondDirectory);
      const executable = compileControlsCheck(
        scratch,
        ["ExportController", "ServiceBundle", "NodeRuntime"],
        String.raw`
import AppKit
import YapControls

@MainActor final class Script {
    var calls: [(String, [String: Any])] = []
    var createFailures: [(ServiceFailure, admitted: Bool)] = []
    var admitted: [String: [String: Any]] = [:]
    var revision = "r3"
    var pages: [[String: Any]] = []

    func json(_ value: Any) -> Data { try! JSONSerialization.data(withJSONObject: value) }
    func status(_ params: [String: Any]) -> [String: Any] {
        ["id": params["requestId"] ?? params["exportId"]!, "projectId": params["projectId"]!, "kind": params["kind"]!,
         "snapshot": ["revisionId": params["revisionId"]!], "state": "queued", "abandoning": false,
         "destination": ["directory": params["directory"]!, "leaf": params["leaf"]!],
         "cleanupPending": false, "output": NSNull(), "reason": NSNull(), "retryable": false]
    }
    func call(_ operation: String, _ params: [String: Any]) async throws(ServiceFailure) -> Data {
        calls.append((operation, params))
        let id = params["requestId"] as? String ?? params["exportId"] as? String ?? ""
        switch operation {
        case "project.get":
            return json(["id": "take", "createdAt": "2026-09-17T10:11:12.345Z", "currentRevisionId": revision])
        case "export.create":
            if !createFailures.isEmpty {
                let (failure, admit) = createFailures.removeFirst()
                if admit { admitted[id] = params }
                throw failure
            }
            admitted[id] = params
            return json(status(params))
        case "export.status":
            guard let params = admitted[id] else { throw ServiceFailure(code: "NOT_FOUND", message: "Export does not exist") }
            return json(status(params))
        case "export.list":
            return json(pages.removeFirst())
        case "export.abandon":
            try? await Task.sleep(for: .milliseconds(50))
            admitted[id] = nil
            return json(["id": id, "abandoned": true])
        default:
            throw ServiceFailure(code: "UNKNOWN_OPERATION", message: operation)
        }
    }
    func count(_ operation: String) -> Int { calls.filter { $0.0 == operation }.count }
}

@main struct Check {
    @MainActor static func until(line: Int = #line, _ condition: () -> Bool) async {
        for _ in 0..<200 where !condition() { try? await Task.sleep(for: .milliseconds(10)) }
        precondition(condition(), "Timed out waiting for the controller at line \(line)")
    }
    @MainActor static func main() async {
        let script = Script()
        var failures: [String] = []
        var feedback = ControlsState()
        var chosen: [(ExportsState.Kind, String)] = []
        var destination: URL? = nil
        let exports = ExportController(
            call: { operation, params throws(ServiceFailure) in try await script.call(operation, params) },
            choose: { kind, name in
                chosen.append((kind, name))
                // An edit lands while the person is still choosing a folder.
                script.revision = "r4"
                return destination
            },
            reveal: { _ in }, changed: {}, failure: { action, message in
                feedback.observeAction(action, failure: message, on: .library)
                if let message { failures.append(message) }
            })

        exports.export("take", kind: .video)
        await until { exports.state.choosing == nil && chosen.count == 1 }
        precondition(script.count("export.create") == 0 && exports.state.requests.isEmpty,
            "Choosing no destination exports nothing")
        precondition(chosen[0].1.hasSuffix(" r3.mp4"), "The suggested name states the pinned revision: \(chosen[0].1)")

        // A reply lost after admission: status adopts the admitted export under the same identity.
        script.revision = "r3"
        destination = URL(fileURLWithPath: CommandLine.arguments[1]).appendingPathComponent("demo.mp4")
        script.createFailures = [(ServiceFailure(code: "TIMEOUT", message: "export.create did not answer in time"), true)]
        exports.export("take", kind: .video)
        await until { exports.state.requests.first?.unconfirmed != nil }
        let sent = script.calls.last { $0.0 == "export.create" }!.1
        let first = sent["requestId"] as! String
        precondition(sent["revisionId"] as? String == "r3", "The revision is pinned before the panel opens")
        precondition(sent["directory"] as? String == CommandLine.arguments[1] && sent["leaf"] as? String == "demo.mp4")
        precondition(sent["kind"] as? String == "video")
        precondition(first == first.lowercased() && UUID(uuidString: first) != nil, "Export IDs are lowercase UUIDs")
        exports.tick()
        await until { exports.state.requests.isEmpty }
        precondition(exports.state.records.map(\.exportId) == [first] && script.count("export.create") == 1,
            "An admitted request is found by status without being sent again")

        // A reply lost before admission: sending again reuses the identity and destination.
        destination = URL(fileURLWithPath: CommandLine.arguments[2]).appendingPathComponent("take.zip")
        script.createFailures = [(ServiceFailure(code: "SERVICE_STOPPED", message: "Service is shutting down"), false)]
        exports.export("take", kind: .package)
        await until { exports.state.requests.first?.unconfirmed != nil }
        let second = exports.state.requests[0].exportId
        exports.tick()
        await until { script.calls.contains { $0.0 == "export.status" && $0.1["exportId"] as? String == second } }
        try? await Task.sleep(for: .milliseconds(50))
        precondition(exports.state.requests.first?.exportId == second, "An unadmitted request stays unconfirmed")
        exports.resend(second)
        await until { exports.state.requests.isEmpty }
        let resent = script.calls.filter { $0.0 == "export.create" }.suffix(2).map { $0.1 }
        precondition(resent.allSatisfy { $0["requestId"] as? String == second && $0["leaf"] as? String == "take.zip"
            && $0["kind"] as? String == "processed-package" }, "Sending again names the same export")
        precondition(exports.state.records.map(\.exportId) == [second, first])

        // A definite refusal ends the request and says why.
        script.createFailures = [(ServiceFailure(code: "INVALID_PARAMS", message: "Parameters do not match"), false)]
        exports.export("take", kind: .video)
        await until { !failures.isEmpty }
        precondition(exports.state.requests.isEmpty && failures == ["Some request settings are missing or incorrect."])

        precondition(feedback.failure?.request == ControlsAction.exportProject("take", .video).id)
        exports.export("take", kind: .video)
        await until { feedback.failure == nil && exports.state.choosing == nil }

        // A restarted app rediscovers every unfinished page, then acts on what it found.
        let restarted = ExportController(
            call: { operation, params throws(ServiceFailure) in try await script.call(operation, params) },
            choose: { _, _ in nil }, reveal: { _ in }, changed: {}, failure: { _, message in if let message { failures.append(message) } })
        let cursor = "opaque-export-cursor"
        script.pages = [
            ["exports": [["id": first]], "nextCursor": cursor],
            ["exports": [["id": second]], "nextCursor": NSNull()],
        ]
        restarted.discover()
        await until { restarted.state.records.count == 2 }
        let lists = script.calls.filter { $0.0 == "export.list" }.map { $0.1 }
        precondition(lists.count == 2 && lists.allSatisfy { $0["unfinishedOnly"] as? Bool == true },
            "Discovery asks only for unfinished exports")
        precondition(lists[1]["cursor"] as? String == cursor,
            "Discovery replays the complete project cursor without adding another owner")
        precondition(restarted.state.records.map(\.exportId) == [first, second], "Discovered exports keep page order")
        restarted.abandon(second)
        restarted.abandon(second)
        await until { restarted.state.records.count == 1 }
        precondition(script.count("export.abandon") == 1, "Abandonment is sent once")
        print("PASS native exports pin revisions, replay lost requests and rediscover every page")
    }
}
`,
      );
      assert.match(
        execFileSync(executable, [realpathSync(firstDirectory), realpathSync(secondDirectory)], {
          encoding: "utf8",
          timeout: 30_000,
        }),
        /PASS native exports pin revisions/,
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);

test(
  "native exports consume retained recording and project statuses",
  { timeout: 120_000 },
  async () => {
    const scratch = mkdtempSync(join(tmpdir(), "yap-export-owners-"));
    try {
      const retained = JSON.parse(
        await readFile(
          join(
            root,
            "specs/done/agent-editing/assets/23b-export-recovery-preservation/report.json",
          ),
          "utf8",
        ),
      );
      const receipts = retained.attempts
        .filter((attempt) => attempt.operation === "export.status" && attempt.response.ok)
        // The receipts predate the WorkState vocabulary: translate them once into today's public
        // status (a committed export reads `ready`, and every async status names its job).
        // They also predate record identity: an export names itself `id`.
        .map(({ response: { data } }) => {
          const { exportId, ...status } = data;
          return {
            ...status,
            id: exportId,
            state:
              { committed: "ready", not_requested: "idle", waiting: "queued" }[data.state] ??
              data.state,
            jobId: exportId,
          };
        });
      const fixture = join(scratch, "receipts.json");
      await writeFile(fixture, JSON.stringify(receipts));
      const executable = compileControlsCheck(
        scratch,
        ["ExportController", "ServiceBundle", "NodeRuntime"],
        String.raw`
import AppKit
import YapControls

@MainActor final class Script {
    var calls: [(String, [String: Any])] = []
    var statuses: [String: Data] = [:]
    var acceptedRetries: [String: Data] = [:]
    var refusedRetries: [String: ServiceFailure] = [:]
    var lostRetryReplies: [String: ServiceFailure] = [:]
    var pages: [[String: Any]] = []
    func json(_ value: Any) -> Data { try! JSONSerialization.data(withJSONObject: value) }
    func call(_ operation: String, _ params: [String: Any]) async throws(ServiceFailure) -> Data {
        calls.append((operation, params))
        switch operation {
        case "export.list": return json(pages.removeFirst())
        case "job.retry":
            let id = params["jobId"] as! String
            if let refusal = refusedRetries[id] { throw refusal }
            if let accepted = acceptedRetries[id] { statuses[id] = accepted }
            if let lost = lostRetryReplies[id] { throw lost }
            // job.retry answers with the job itself.
            return json(["id": id, "state": "queued"])
        case "export.status":
            guard let value = statuses[params["exportId"] as! String] else {
                throw ServiceFailure(code: "NOT_FOUND", message: "Export retired")
            }
            return value
        default: throw ServiceFailure(code: "UNKNOWN_OPERATION", message: operation)
        }
    }
}

@main struct Check {
    @MainActor static func until(_ condition: () -> Bool) async {
        for _ in 0..<200 where !condition() { try? await Task.sleep(for: .milliseconds(10)) }
        precondition(condition(), "Controller did not publish its result")
    }
    @MainActor static func exportItems(_ exports: ExportController) -> [SavedItem] {
        var controls = ControlsState()
        controls.service = .ready
        return ExportPresentation.items(for: controls, exports: exports.state).items
    }
    @MainActor static func exportLines(_ exports: ExportController) -> [String] {
        exportItems(exports).flatMap { [$0.title] + $0.details }
    }
    @MainActor static func main() async throws {
        let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
        let receipts = try JSONSerialization.jsonObject(with: data) as! [[String: Any]]
        let script = Script()
        for receipt in receipts {
            let raw = script.json(receipt)
            let record = try JSONDecoder().decode(ExportsState.Record.self, from: raw)
            let target: MediaTarget = if let id = receipt["projectId"] as? String {
                .project(id)
            } else { .recording(receipt["recordingId"] as! String) }
            let snapshot = receipt["snapshot"] as! [String: Any]
            let destination = receipt["destination"] as! [String: Any]
            precondition(record.target == target && record.exportId == receipt["id"] as! String)
            precondition(record.revisionId == snapshot["revisionId"] as! String && record.kind == .video)
            precondition(record.directory == destination["directory"] as! String && record.leaf == destination["leaf"] as! String)
            precondition(record.state == receipt["state"] as! String && record.output == receipt["output"] as? String)
            precondition(record.reason == receipt["reason"] as? String && record.retryable == receipt["retryable"] as! Bool)
            precondition(record.abandoning == receipt["abandoning"] as! Bool && record.cleanupPending == receipt["cleanupPending"] as! Bool)
            if record.state == "running" { script.statuses[record.exportId] = raw }
        }
        let recording = receipts.first { $0["recordingId"] != nil }!
        let project = receipts.first { $0["projectId"] != nil }!
        let recordingId = recording["id"] as! String, projectId = project["id"] as! String
        let cursor = "opaque-export-cursor"
        script.statuses["malformed"] = Data("{}".utf8)
        script.pages = [
            ["exports": [["id": "malformed"], ["id": recordingId]], "nextCursor": cursor],
            ["exports": [["id": projectId]], "nextCursor": NSNull()],
        ]
        var changes = 0
        var revealed: [URL] = []
        let exports = ExportController(
            call: { operation, params throws(ServiceFailure) in try await script.call(operation, params) },
            choose: { _, _ in preconditionFailure("Discovery must not choose a destination") },
            reveal: { revealed.append($0) }, changed: { changes += 1 },
            failure: { _, message in if let message { preconditionFailure("No create failure expected: \(message)") } })
        exports.discover()
        await until { changes > 0 }
        precondition(exports.state.records.map(\.exportId) == [recordingId, projectId], "A malformed item must not hide later items/pages")
        precondition(exports.state.discoveryFailure?.contains("Yap returned an unreadable or inconsistent response.") == true,
            "Malformed status must remain visible after the last successful page")
        let lists = script.calls.filter { $0.0 == "export.list" }.map { $0.1 }
        precondition(lists.count == 2 && lists[1]["cursor"] as? String == cursor)
        let originalRecording = try JSONDecoder().decode(ExportsState.Record.self, from: script.json(recording))
        let originalProject = try JSONDecoder().decode(ExportsState.Record.self, from: script.json(project))
        precondition(exports.state.records == [originalRecording, originalProject], "Controller retains all public receipt fields")
        let projectOwner = project["projectId"] as! String
        // The record keeps its owner (checked above); what people read names the file, never identifiers.
        precondition(originalProject.target == .project(projectOwner), "The export stays attributed to its project")
        precondition(!exportLines(exports).contains { $0.contains(projectOwner) || $0.contains(originalProject.revisionId) },
                     "Presentation shows no identifiers")
        precondition(exportLines(exports).contains { $0.contains("Yap returned an unreadable or inconsistent response.") },
            "Discovery failure is visible in shared export facts")

        // Neither/both owners are malformed, not implicit recording/project defaults.
        for fields in [[String: Any](), ["recordingId": "other", "projectId": projectOwner]] {
            var malformed = project
            malformed.removeValue(forKey: "projectId")
            malformed.merge(fields) { _, replacement in replacement }
            precondition((try? JSONDecoder().decode(ExportsState.Record.self, from: script.json(malformed))) == nil)
        }

        // A successful new traversal clears only the previous discovery failure.
        script.pages = [["exports": [["id": projectId]], "nextCursor": NSNull()]]
        let discovered = changes
        exports.discover()
        await until { changes > discovered }
        precondition(exports.state.discoveryFailure == nil && exports.state.records == [originalRecording, originalProject])

        // Status decoding failures keep the last good receipt visible, and recover on a good read.
        script.statuses[projectId] = Data("{}".utf8)
        exports.tick()
        await until { exports.state.readFailures[projectId] != nil }
        let unreadable = exports.state.readFailures[projectId]!
        precondition(unreadable.contains("Yap returned an unreadable or inconsistent response.") && exports.state.records.last == originalProject)
        precondition(exportLines(exports).contains { $0 == unreadable }, "Polling failure is visible")
        script.refusedRetries[projectId] = ServiceFailure(code: "INVALID_PARAMS", message: "Retry was refused")
        exports.retry(projectId)
        await until { exports.state.acting[projectId] == nil }
        precondition(exports.state.failures[projectId]?.contains("Some request settings are missing or incorrect.") == true)
        script.refusedRetries[projectId] = nil
        let refusedRetry = exports.state.failures[projectId]
        script.statuses[projectId] = script.json(project)
        exports.tick()
        await until { exports.state.readFailures[projectId] == nil }
        precondition(exports.state.failures[projectId] == refusedRetry, "A good poll does not erase a refused action")

        // A status returned for another export never overwrites either known identity.
        script.statuses[projectId] = script.json(recording)
        exports.tick()
        await until { exports.state.readFailures[projectId] != nil }
        precondition(exports.state.readFailures[projectId]!.contains("Yap returned an unreadable or inconsistent response."))
        precondition(exports.state.records == [originalRecording, originalProject])
        script.statuses[projectId] = script.json(project)
        exports.tick()
        await until { exports.state.readFailures[projectId] == nil }

        // A stopped export with an accepted-but-unreadable retry is recovered by status alone.
        let committed = receipts.first { $0["projectId"] != nil && $0["state"] as? String == "ready" }!
        var stopped = project
        stopped["state"] = "failed"
        stopped["retryable"] = true
        script.statuses[projectId] = script.json(stopped)
        script.pages = [["exports": [["id": projectId]], "nextCursor": NSNull()]]
        let stoppedRead = changes
        exports.discover()
        await until { changes > stoppedRead }
        precondition(exports.state.records.last?.settled == true && !exports.state.observed.contains(projectId))
        script.refusedRetries[projectId] = ServiceFailure(code: "INVALID_PARAMS", message: "Retry was refused")
        exports.retry(projectId)
        await until { exports.state.acting[projectId] == nil }
        precondition(exports.state.failures[projectId]?.contains("Some request settings are missing or incorrect.") == true)
        precondition(!exports.state.observed.contains(projectId), "A definite refusal does not make a settled export poll forever")
        script.refusedRetries[projectId] = nil
        script.acceptedRetries[projectId] = script.json(committed)
        for code in ["TIMEOUT", "SERVICE_STOPPED", "SERVICE_UNAVAILABLE"] {
            script.statuses[projectId] = script.json(stopped)
            script.pages = [["exports": [["id": projectId]], "nextCursor": NSNull()]]
            let beforeRead = changes
            exports.discover()
            await until { changes > beforeRead }
            script.lostRetryReplies[projectId] = ServiceFailure(code: code, message: "Accepted retry reply unavailable")
            let mutationsBeforeRecovery = script.calls.filter { $0.0 == "job.retry" }.count
            exports.retry(projectId)
            await until { exports.state.acting[projectId] == nil }
            precondition(exports.state.observed.contains(projectId), "Accepted retry uncertainty \(code) needs status recovery even when the old receipt was settled")
            precondition(exportLines(exports).contains { $0.contains(ServiceFailure(code: code, message: "").localizedDescription) })
            exports.tick()
            await until { exports.state.records.last?.committed == true }
            precondition(exports.state.readFailures[projectId] == nil && !exports.state.observed.contains(projectId))
            precondition(script.calls.filter { $0.0 == "job.retry" }.count == mutationsBeforeRecovery + 1,
                "Status recovery does not resend the accepted retry for \(code)")
        }
        script.lostRetryReplies[projectId] = nil
        script.acceptedRetries[projectId] = nil
        script.statuses[projectId] = script.json(project)

        // The same opaque owner ID in different namespaces remains two different owners.
        var sameIdRecording = recording
        sameIdRecording["recordingId"] = projectOwner
        let sameIdExport = "00000000-0000-4000-8000-000000000001"
        sameIdRecording["id"] = sameIdExport
        script.statuses[sameIdExport] = script.json(sameIdRecording)
        script.pages = [["exports": [["id": sameIdExport], ["id": projectId]], "nextCursor": NSNull()]]
        let collisionRead = changes
        exports.discover()
        await until { changes > collisionRead }
        exports.forget(target: originalRecording.target)
        exports.forget(target: .recording(projectOwner))
        precondition(exports.state.records == [originalProject], "Recording deletion must not retire the same-ID project")

        // A scripted cleanup-pending variation of the retained commit exercises native actions;
        // the completed retry response is the untouched retained public project receipt.
        var cleanup = committed
        cleanup["cleanupPending"] = true
        script.statuses[projectId] = script.json(cleanup)
        script.pages = [["exports": [["id": projectId]], "nextCursor": NSNull()]]
        let cleanupRead = changes
        exports.discover()
        await until { changes > cleanupRead }
        let pending = exports.state.records[0]
        precondition(pending.target == originalProject.target && pending.revisionId == originalProject.revisionId
            && pending.directory == originalProject.directory && pending.leaf == originalProject.leaf)
        precondition(pending.committed && pending.cleanupPending && !pending.settled)
        precondition(exportItems(exports).flatMap(\.actions).contains { $0.action.id == "export.jobRetry.\(projectId)" && $0.title == "Retry Cleanup" && $0.enabled })
        precondition(!exportItems(exports).flatMap(\.actions).contains { $0.action.id == "export.dismiss.\(projectId)" })
        script.statuses[projectId] = script.json(committed)
        exports.retry(projectId)
        await until { exports.state.acting[projectId] == nil }
        let settled = try JSONDecoder().decode(ExportsState.Record.self, from: script.json(committed))
        precondition(exports.state.records == [settled] && exports.state.failures[projectId] == nil)
        precondition(settled.settled && exports.state.observed.isEmpty)
        let retries = script.calls.filter { $0.0 == "job.retry" }.map { $0.1 }
        precondition(retries.allSatisfy { NSDictionary(dictionary: $0).isEqual(to: ["jobId": project["jobId"] as! String]) },
            "Retries retain the original export identity and do not choose a new owner or destination")
        exports.reveal(projectId)
        precondition(revealed == [URL(fileURLWithPath: committed["output"] as! String)])
        precondition(exportItems(exports).flatMap(\.actions).contains { $0.action.id == "export.dismiss.\(projectId)" && $0.enabled })
        exports.dismiss(projectId)
        precondition(exports.state.records.isEmpty)
        precondition(!script.calls.contains { ["export.create", "recording.get", "project.get"].contains($0.0) },
            "Received project exports do not create a new project-selection or authoring flow")
        print("PASS native exports consume retained recording and project statuses")
    }
}
`,
      );
      assert.match(
        execFileSync(executable, [fixture], { encoding: "utf8", timeout: 30_000 }),
        /PASS native exports consume retained recording and project statuses/,
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);

test(
  "native exports commit through the bundled service and rediscover an unfinished export after restart",
  { timeout: 180_000 },
  async () => {
    const home = mkdtempSync("/tmp/yap-export-controls-home-");
    const output = await realpath(mkdtempSync("/tmp/yap-export-controls-output-"));
    const scratch = mkdtempSync(join(tmpdir(), "yap-export-controls-build-"));
    let safeToRemove = true;
    try {
      const source = join(home, "fixture");
      await mkdir(source);
      execFileSync(
        "ffmpeg",
        [
          "-nostdin",
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "color=c=gray:s=160x90:r=1:d=2",
          "-an",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          join(source, "video.mov"),
        ],
        { timeout: 20_000 },
      );
      const {
        projectId,
        revisionId: pinnedRevision,
        clipId,
      } = await generatedVideoProject(home, join(source, "video.mov"), {
        width: 160,
        height: 90,
        durationUs: 2000000,
      });
      const executable = compileControlsCheck(
        scratch,
        ["ExportController", "ServiceHost", "ServiceBundle", "NodeRuntime"],
        String.raw`
import AppKit
import YapControls

@MainActor final class Service {
    var state: ServiceHost.State = .starting
    var host: ServiceHost!
    static func start(_ resolved: ServiceBundle) async -> Service {
        let service = Service()
        service.host = ServiceHost(bundle: resolved, onNativeCall: { _, _, answer in
            answer(.failure(ServiceFailure(code: "UNKNOWN_OPERATION", message: "This check owns no capture session")))
        }) { state in Task { @MainActor in service.state = state } }
        service.host.start()
        for _ in 0..<150 {
            if case .ready = service.state { return service }
            if case .unavailable(let code, let message) = service.state { fatalError("\(code): \(message)") }
            try? await Task.sleep(for: .milliseconds(100))
        }
        fatalError("Bundled service did not become ready")
    }
    func call(_ operation: String, _ params: [String: Any]) async throws(ServiceFailure) -> Data {
        try await host.call(operation, params)
    }
}

@main struct Check {
    @MainActor static func main() {
        let app = NSApplication.shared
        Task { @MainActor in
            await run()
            app.terminate(nil)
        }
        app.run()
    }
    @MainActor static func until(_ seconds: Int, _ poll: () -> Void, _ condition: () -> Bool) async {
        for _ in 0..<(seconds * 10) where !condition() {
            poll()
            try? await Task.sleep(for: .milliseconds(100))
        }
        precondition(condition(), "Timed out waiting for the bundled service")
    }
    @MainActor static func run() async {
        NSApp.setActivationPolicy(.accessory)
        let arguments = CommandLine.arguments
        let (bundlePath, projectId, directory, pinnedRevision, clipId) = (arguments[1], arguments[2], arguments[3], arguments[4], arguments[5])
        let resolved: ServiceBundle = try! await withCheckedThrowingContinuation { continuation in
            ServiceBundle.resolve(in: Bundle(path: bundlePath)!) { continuation.resume(with: $0) }
        }
        var service = await Service.start(resolved)
        var failures: [String] = []
        var revealed: [URL] = []
        let first = ExportController(
            call: { operation, params throws(ServiceFailure) in try await service.call(operation, params) },
            choose: { kind, _ in
                precondition(kind == .video)
                // An edit made while the panel is open does not change the pinned export.
                _ = try? await service.call("edit.apply", ["projectId": projectId, "requestId": UUID().uuidString,
                    "expectedRevisionId": pinnedRevision, "operations": [["operation": "trim", "clipId": clipId, "range": ["startUs": 0, "endUs": 1_000_000], "ripple": "none"]]])
                return URL(fileURLWithPath: directory).appendingPathComponent("demo.mp4")
            },
            reveal: { revealed.append($0) }, changed: {}, failure: { _, message in if let message { failures.append(message) } })

        first.export(projectId, kind: .video)
        await until(60, first.tick) { first.state.records.first?.settled == true || !failures.isEmpty }
        precondition(failures.isEmpty, "Export failed: \(failures)")
        let committed = first.state.records[0]
        precondition(committed.committed, "Export stopped before committing: \(committed)")
        precondition(committed.revisionId == pinnedRevision && committed.leaf == "demo.mp4" && committed.directory == directory,
            "The committed export is the revision pinned before the edit: \(committed)")
        first.reveal(committed.exportId)
        precondition(revealed == [URL(fileURLWithPath: directory).appendingPathComponent("demo.mp4")])
        let current = try! JSONSerialization.jsonObject(with: await service.call("project.get", ["projectId": projectId])) as! [String: Any]
        precondition(current["currentRevisionId"] as? String != pinnedRevision, "The library edit did advance")

        // A file Yap never published occupies this destination. Only an unchanged file matching
        // Yap's own publication receipt may be replaced without overwrite, so the service refuses.
        let occupied = ExportController(
            call: { operation, params throws(ServiceFailure) in try await service.call(operation, params) },
            choose: { _, _ in URL(fileURLWithPath: directory).appendingPathComponent("occupied.mp4") },
            reveal: { _ in }, changed: {}, failure: { _, message in if let message { failures.append(message) } })
        occupied.export(projectId, kind: .video)
        await until(60, occupied.tick) { occupied.state.records.first?.state == "failed" || !failures.isEmpty }
        precondition(failures.isEmpty, "Occupied export was refused before admission: \(failures)")
        let failed = occupied.state.records[0].exportId
        print("EXPORTS committed=\(committed.exportId) failed=\(failed)")

        service.host.shutdown()
        service = await Service.start(resolved)
        let restarted = ExportController(
            call: { operation, params throws(ServiceFailure) in try await service.call(operation, params) },
            choose: { _, _ in nil }, reveal: { _ in }, changed: {}, failure: { _, message in if let message { failures.append(message) } })
        restarted.discover()
        await until(20, {}) { !restarted.state.records.isEmpty || restarted.state.discoveryFailure != nil }
        precondition(restarted.state.discoveryFailure == nil, "\(restarted.state.discoveryFailure!)")
        precondition(restarted.state.records.map(\.exportId) == [failed],
            "Only the unfinished export is rediscovered: \(restarted.state.records.map(\.exportId))")
        let found = restarted.state.records[0]
        precondition(found.state == "failed" && found.directory == directory && found.leaf == "occupied.mp4",
            "The rediscovered export states its admitted destination without app storage")
        restarted.abandon(failed)
        await until(30, {}) { restarted.state.records.isEmpty || !restarted.state.failures.isEmpty }
        precondition(restarted.state.failures.isEmpty, "\(restarted.state.failures)")
        do throws(ServiceFailure) {
            _ = try await service.call("export.status", ["exportId": failed])
            preconditionFailure("An abandoned export has no status")
        } catch {
            precondition(error.code == "NOT_FOUND", error.localizedDescription)
        }
        service.host.shutdown()
        print("PASS native exports commit, rediscover an unfinished export after restart and abandon it")
    }
}
`,
      );
      const foreign = "bytes no Yap export published";
      await writeFile(join(output, "occupied.mp4"), foreign);
      safeToRemove = false;
      const result = await new Promise((resolve, reject) => {
        const child = spawn(
          executable,
          [join(root, "dist/Yap.app"), projectId, output, pinnedRevision, clipId],
          { env: { ...process.env, YAP_HOME: home }, stdio: ["ignore", "pipe", "pipe"] },
        );
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.once("error", reject);
        const timeout = setTimeout(() => child.kill("SIGKILL"), 150_000);
        child.once("close", (code, signal) => {
          clearTimeout(timeout);
          resolve({ code, signal, stdout, stderr });
        });
      });
      await writeFile(join(home, "export-controls-process.json"), JSON.stringify(result, null, 2));
      assert.equal(
        result.code,
        0,
        `Retained scratch home: ${home}\n${result.stderr}${result.stdout}`,
      );
      assert.match(result.stdout, /PASS native exports commit/);
      const [, committed] = result.stdout.match(/EXPORTS committed=(\S+) failed=(\S+)/);
      assert.deepEqual(
        readdirSync(output).sort(),
        ["demo.mp4", "occupied.mp4"],
        "abandonment leaves no private staging behind",
      );
      assert.equal(
        await readFile(join(output, "occupied.mp4"), "utf8"),
        foreign,
        "a refused export leaves the file it would have replaced untouched",
      );
      const exported = await readFile(join(output, "demo.mp4"));
      assert.ok(exported.length > 0, `committed export ${committed} has bytes`);
      const info = JSON.parse(
        execFileSync(
          "ffprobe",
          ["-v", "error", "-show_format", "-of", "json", join(output, "demo.mp4")],
          {
            encoding: "utf8",
          },
        ),
      );
      assert.equal(
        Number(info.format.duration),
        2,
        "the export stays pinned before the concurrent cut",
      );
      safeToRemove = true;
      console.log(result.stdout.trim());
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      if (safeToRemove) {
        rmSync(home, { recursive: true, force: true });
        rmSync(output, { recursive: true, force: true });
      }
    }
  },
);
