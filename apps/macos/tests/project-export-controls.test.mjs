import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compileControlsCheck } from "./fixtures/swift-controls.mjs";

test(
  "native project exports pin explicit owners and discard late forgotten replies",
  { timeout: 90_000 },
  () => {
    const scratch = mkdtempSync(join(tmpdir(), "yap-project-export-controls-"));
    try {
      const folder = join(scratch, "folder");
      const selected = join(scratch, "chosen-link");
      const otherFolder = join(scratch, "other-folder");
      mkdirSync(folder);
      mkdirSync(otherFolder);
      symlinkSync(folder, selected, "dir");
      const executable = compileControlsCheck(
        scratch,
        ["ExportController", "ServiceBundle", "NodeRuntime"],
        String.raw`
import Foundation
import YapControls

let selectedFolder = CommandLine.arguments[1]
let canonicalFolder = CommandLine.arguments[2]
let otherFolder = CommandLine.arguments[3]

@MainActor final class Script {
    static var exchanges: [[String: Any]] = []
    var calls: [(String, [String: Any])] = []
    var receipts: [String: [String: Any]] = [:]
    var revision = "r-before"
    var wrongOwner = false
    var wrongReceipt: String?
    var lostCreate = false
    var hold: String?
    var held: CheckedContinuation<Data, Never>?
    var heldAnswer: Data?
    var pages: [[String: Any]] = []
    func json(_ value: Any) -> Data { try! JSONSerialization.data(withJSONObject: value) }
    func count(_ operation: String) -> Int { calls.filter { $0.0 == operation }.count }
    func call(_ operation: String, _ params: [String: Any]) async throws(ServiceFailure) -> Data {
        calls.append((operation, params))
        let answer: [String: Any]
        switch operation {
        case "recording.get", "project.get":
            var owner: [String: Any] = params
            if wrongOwner { owner = ["projectId": "another-owner"] }
            owner["createdAt"] = "2026-09-17T10:11:12.345Z"
            owner["title"] = "Named / project: test\nsecond line"
            owner["currentRevisionId"] = revision
            answer = owner
        case "export.create":
            let id = params["requestId"] as! String
            var receipt: [String: Any] = ["exportId": id, "kind": params["kind"]!,
                "snapshot": ["revisionId": params["revisionId"]!], "state": "queued",
                "destination": ["directory": params["directory"]!, "leaf": params["leaf"]!],
                "abandoning": false, "cleanupPending": false, "retryable": false]
            for key in ["recordingId", "projectId"] { if let value = params[key] { receipt[key] = value } }
            receipts[id] = receipt
            if lostCreate {
                lostCreate = false
                Self.exchanges.append(["operation": operation, "params": params, "error": "TIMEOUT", "admittedReceipt": receipt])
                throw ServiceFailure(code: "TIMEOUT", message: "lost create reply")
            }
            if wrongReceipt == "owner" { receipt.removeValue(forKey: "projectId"); receipt["recordingId"] = "same" }
            if wrongReceipt == "revision" { receipt["snapshot"] = ["revisionId": "wrong-revision"] }
            if wrongReceipt == "kind" { receipt["kind"] = "processed-package" }
            if wrongReceipt == "directory" { receipt["destination"] = ["directory": "/another/destination", "leaf": params["leaf"]!] }
            if wrongReceipt == "leaf" { receipt["destination"] = ["directory": params["directory"]!, "leaf": "another-file.mp4"] }
            answer = receipt
        case "export.status":
            guard let receipt = receipts[params["exportId"] as! String] else {
                throw ServiceFailure(code: "NOT_FOUND", message: "not admitted")
            }
            answer = receipt
        case "export.list": answer = pages.isEmpty ? ["exports": [], "nextCursor": NSNull()] : pages.removeFirst()
        default: throw ServiceFailure(code: "UNKNOWN_OPERATION", message: operation)
        }
        Self.exchanges.append(["operation": operation, "params": params, "answer": answer])
        let bytes = json(answer)
        if hold == operation {
            hold = nil; heldAnswer = bytes
            return await withCheckedContinuation { held = $0 }
        }
        return bytes
    }
    func release() { let waiting = held; held = nil; waiting?.resume(returning: heldAnswer!); heldAnswer = nil }
}
@MainActor final class Chooser {
    var names: [String] = []
    var held: [Int: CheckedContinuation<URL?, Never>] = [:]
    var holding = false
    var cancel = false
    var missing = false
    func choose(_ kind: ExportsState.Kind, _ name: String) async -> URL? {
        names.append(name)
        if holding { return await withCheckedContinuation { held[names.count] = $0 } }
        if missing { return URL(fileURLWithPath: selectedFolder).appendingPathComponent("missing/requested.mp4") }
        return cancel ? nil : URL(fileURLWithPath: selectedFolder).appendingPathComponent("requested." + (kind == .video ? "mp4" : "zip"))
    }
    func release(_ index: Int) { held.removeValue(forKey: index)?.resume(returning: URL(fileURLWithPath: selectedFolder).appendingPathComponent("choice-\(index).mp4")) }
}
@MainActor final class Failures { var values: [String] = [] }
@MainActor func controller(_ script: Script, _ chooser: Chooser, _ failures: Failures) -> ExportController {
    ExportController(call: { operation, params throws(ServiceFailure) in try await script.call(operation, params) },
        choose: { kind, name in script.revision = "r-after"; return await chooser.choose(kind, name) },
        reveal: { _ in }, changed: {}, failure: { failures.values.append($0) })
}
@main struct Check {
    @MainActor static func until(line: Int = #line, _ ready: () -> Bool) async {
        for _ in 0..<200 where !ready() { try? await Task.sleep(for: .milliseconds(10)) }
        precondition(ready(), "Timed out at line \(line)")
    }
    @MainActor static func settle() async { for _ in 0..<20 { await Task.yield() } }
    @MainActor static func main() async {
        let script = Script(), chooser = Chooser(), failures = Failures()
        let exports = controller(script, chooser, failures)
        script.lostCreate = true
        exports.export("same", kind: .package)
        await until { exports.state.requests.first?.unconfirmed != nil }
        let request = script.calls.last { $0.0 == "export.create" }!.1
        precondition(request["projectId"] as? String == "same" && request["recordingId"] == nil, "Project selector must reach export.create")
        precondition(request["revisionId"] as? String == "r-before" && request["kind"] as? String == "processed-package")
        precondition(request["directory"] as? String == canonicalFolder && request["leaf"] as? String == "requested.zip", "Chosen directory mismatch: \(request["directory"]!) vs \(canonicalFolder)")
        precondition(chooser.names == ["Project Named - project- test second line r-before.zip"])
        let id = request["requestId"] as! String
        precondition(id == id.lowercased() && UUID(uuidString: id) != nil)
        try! FileManager.default.removeItem(atPath: selectedFolder)
        try! FileManager.default.createSymbolicLink(atPath: selectedFolder, withDestinationPath: otherFolder)
        exports.resend(id)
        await until { exports.state.requests.isEmpty }
        let resent = script.calls.last { $0.0 == "export.create" }!.1
        precondition(NSDictionary(dictionary: request).isEqual(to: resent), "Explicit resend preserves every request field")
        precondition(exports.state.records.first?.target == .project("same"))
        exports.forget(target: .recording("same"))
        precondition(exports.state.records.first?.target == .project("same"), "Recording deletion cannot forget same-ID project exports")
        exports.export("second", kind: .video)
        await until { exports.state.records.count == 2 }
        let second = exports.state.records.first!
        exports.forget(target: .project("same"))
        precondition(exports.state.records == [second] && second.target == .project("second"))
        chooser.cancel = true
        exports.export("cancel", kind: .video)
        await until { exports.state.choosing == nil }
        precondition(script.count("export.create") == 3, "Canceled chooser creates no export")

        chooser.cancel = false; chooser.missing = true
        exports.export("missing-folder", kind: .video)
        await until { !failures.values.isEmpty && exports.state.choosing == nil }
        precondition(failures.values.last?.contains("folder could not be resolved") == true && script.count("export.create") == 3, "An unavailable chosen folder is a visible refusal before export admission")

        let bad = Script(), badChooser = Chooser(), badFailures = Failures()
        let rejected = controller(bad, badChooser, badFailures)
        bad.wrongOwner = true
        rejected.export("same", kind: .video)
        await until { !badFailures.values.isEmpty }
        precondition(badChooser.names.isEmpty && bad.count("export.create") == 0, "Wrong owner cannot open a chooser")
        bad.wrongOwner = false
        for mismatch in ["owner", "revision", "kind", "directory", "leaf"] {
            bad.wrongReceipt = mismatch
            rejected.export("same", kind: .video)
            await until { rejected.state.requests.first?.unconfirmed != nil || !rejected.state.records.isEmpty }
            precondition(rejected.state.requests.first?.unconfirmed != nil && rejected.state.records.isEmpty, "Mismatched \(mismatch) receipt must remain unconfirmed")
            bad.wrongReceipt = nil
            rejected.tick()
            await until { rejected.state.requests.isEmpty }
            precondition(rejected.state.records.first?.target == .project("same"))
            rejected.forget(target: .project("same"))
        }

        for heldOperation in ["project.get", "export.create", "export.status"] {
            let late = Script(), picker = Chooser(), errors = Failures()
            let consumer = controller(late, picker, errors)
            if heldOperation == "export.status" { late.lostCreate = true }
            else { late.hold = heldOperation }
            consumer.export("old", kind: .video)
            if heldOperation == "export.status" {
                await until { consumer.state.requests.first?.unconfirmed != nil }
                late.hold = "export.status"; consumer.tick()
            }
            await until { late.held != nil }
            consumer.forget(target: .project("old"))
            consumer.export("new", kind: .video)
            await until { consumer.state.records.first?.target == .project("new") }
            late.release(); await settle()
            precondition(consumer.state.requests.isEmpty && consumer.state.records.map(\.target) == [.project("new")], "Late \(heldOperation) cannot resurrect its forgotten owner")
            precondition(errors.values.isEmpty)
        }
        let held = Script(), picker = Chooser(), errors = Failures()
        picker.holding = true
        let consumer = controller(held, picker, errors)
        consumer.export("old", kind: .video)
        await until { picker.held[1] != nil }
        consumer.forget(target: .project("old"))
        consumer.export("new", kind: .video)
        await until { picker.held[2] != nil }
        picker.release(1); await settle()
        precondition(consumer.state.choosing?.target == .project("new") && held.count("export.create") == 0, "Old chooser must not clear or replace a newer choice")
        picker.release(2)
        await until { consumer.state.records.first?.target == .project("new") }
        precondition(held.count("export.create") == 1)

        let discovered = Script(), discoveryChooser = Chooser(), discoveryErrors = Failures()
        let discovery = controller(discovered, discoveryChooser, discoveryErrors)
        discovered.receipts = script.receipts
        discovered.pages = [["exports": [["exportId": id]], "nextCursor": NSNull()]]
        discovered.hold = "export.status"
        discovery.discover()
        await until { discovered.held != nil }
        discovery.forget(target: .project("same"))
        discovered.release()
        await until { discovered.count("export.list") == 2 }
        await settle()
        precondition(discovery.state.records.isEmpty && discoveryErrors.values.isEmpty, "Late discovery cannot recreate a forgotten owner")
        print("PASS native project requests, pinned snapshots, exact resend and forgotten reply fences")
        print(String(data: script.json(Script.exchanges), encoding: .utf8)!)
    }
}
`,
      );
      const output = execFileSync(executable, [selected, realpathSync(folder), otherFolder], {
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.match(output, /PASS native project requests/);
      process.stdout.write(output);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);
