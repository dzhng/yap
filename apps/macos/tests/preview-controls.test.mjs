import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { compileControlsCheck } from "./fixtures/swift-controls.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));

test(
  "native preview consumes retained project receipts without a window or player",
  { timeout: 90_000 },
  () => {
    const scratch = mkdtempSync(join(tmpdir(), "yap-preview-controls-"));
    try {
      const retained = ["preview-get.json", "preview-get-2.json"].map(
        (name) =>
          JSON.parse(
            readFileSync(
              join(root, "specs/done/agent-editing/assets/10b-acquisition-skill/fresh", name),
              "utf8",
            ),
          ).data,
      );
      // Preserve archived receipts; project their payload at this current decoder input boundary.
      for (const receipt of retained) {
        if (receipt.published) {
          const { preview, ...identity } = receipt.published;
          receipt.published = { ...identity, output: preview };
        }
      }
      const fixture = join(scratch, "receipts.json");
      writeFileSync(fixture, JSON.stringify(retained));
      const executable = compileControlsCheck(
        scratch,
        ["PreviewController", "PreviewWindow"],
        String.raw`
import Foundation
import YapControls

@MainActor final class Presentation: PreviewPresenting {
    var titles: [String] = []
    var messages: [(String, Bool)] = []
    var movies: [(String, String)] = []
    var starts: [Int64?] = []
    var active = false
    var retry: (@MainActor () -> Void)?
    var closed: (@MainActor () -> Void)?
    var failed: (@MainActor (String) -> Void)?
    var ended: (@MainActor () -> Void)?
    func open(title: String, retry: @escaping @MainActor () -> Void, closed: @escaping @MainActor () -> Void) {
        active = true; titles.append(title); self.retry = retry; self.closed = closed
    }
    func show(title: String, message: String, canRetry: Bool) { titles.append(title); messages.append((message, canRetry)) }
    func play(title: String, file: String, mediaType: String, startAtUs: Int64?, failed: @escaping @MainActor (String) -> Void, ended: @escaping @MainActor () -> Void) {
        titles.append(title); movies.append((file, mediaType)); starts.append(startAtUs); self.failed = failed; self.ended = ended
    }
    func close() { active = false }
}
struct Refused: LocalizedError { let message: String; var errorDescription: String? { message } }
@MainActor final class Clock { var date: Date; init(_ date: Date) { self.date = date } }
@MainActor final class Failures { var values: [String] = [] }
@MainActor final class Script {
    var replies: [String: [Result<Data, Refused>]] = [:]
    var calls: [(String, [String: Any])] = []
    var hold: String?
    var held: CheckedContinuation<Data, Error>?
    var closed: [String] { calls.filter { $0.0 == "artifact.close" }.map { $0.1["token"] as! String } }
    func json(_ value: Any) -> Data { try! JSONSerialization.data(withJSONObject: value) }
    func answer(_ operation: String, _ value: Any) { replies[operation, default: []].append(.success(json(value))) }
    func refuse(_ operation: String, _ reason: String) { replies[operation, default: []].append(.failure(Refused(message: reason))) }
    func count(_ operation: String) -> Int { calls.filter { $0.0 == operation }.count }
    func call(_ operation: String, _ params: [String: Any]) async throws -> Data {
        calls.append((operation, params))
        if hold == operation {
            hold = nil
            return try await withCheckedThrowingContinuation { held = $0 }
        }
        if operation == "artifact.close" { return json([:]) }
        if var pending = replies[operation], !pending.isEmpty {
            let answer = pending.removeFirst(); replies[operation] = pending
            return try answer.get()
        }
        if operation == "another.get" || operation == "project.get" { return json([:]) }
        preconditionFailure("Unexpected service call: \(operation) \(params)")
    }
    func resume(_ value: Any) { let continuation = held!; held = nil; continuation.resume(returning: json(value)) }
}
@MainActor func until(_ condition: () -> Bool) async {
    for _ in 0..<400 where !condition() { try? await Task.sleep(for: .milliseconds(5)) }
    precondition(condition(), "Preview controller did not publish its result")
}
@MainActor struct Rig {
    let service: Script
    let view: Presentation
    let clock: Clock
    let failures: Failures
    let owner: PreviewController
    init(_ date: Date) {
        let service = Script(), view = Presentation(), clock = Clock(date), failures = Failures()
        self.service = service; self.view = view; self.clock = clock; self.failures = failures
        owner = PreviewController(call: service.call, presentation: view, now: { clock.date }, failure: { failures.values.append($0) })
    }
    func ready(_ target: MediaTarget, _ receipt: [String: Any]) async {
        service.answer("preview.get", receipt)
        owner.open(target.id)
        await until { !view.movies.isEmpty || !failures.values.isEmpty }
        precondition(failures.values.isEmpty)
    }
}
func movie(_ receipt: [String: Any], _ change: (inout [String: Any]) -> Void) -> [String: Any] {
    var result = receipt, publication = result["published"] as! [String: Any]
    var value = publication["output"] as! [String: Any]
    change(&value); publication["output"] = value; result["published"] = publication
    return result
}
// Owner/token variations are scripted controls, not newly acquired or renewed historical media.
func selecting(_ target: MediaTarget, _ receipt: [String: Any], token: String) -> [String: Any] {
    var result = movie(receipt) { value in
        value.removeValue(forKey: "projectId"); value.removeValue(forKey: "recordingId")
        for (key, id) in target.parameters { value[key] = id }
    }
    result.removeValue(forKey: "projectId"); result.removeValue(forKey: "recordingId")
    for (key, id) in target.parameters { result[key] = id }
    var lease = result["delivery"] as! [String: Any]; lease["token"] = token; result["delivery"] = lease
    return result
}
@main struct Check {
    @MainActor static func main() async throws {
        let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
        let receipts = try JSONSerialization.jsonObject(with: data) as! [[String: Any]]
        let waiting = receipts[0], ready = receipts[1]
        let id = waiting["projectId"] as! String, revision = waiting["revisionId"] as! String
        let target = MediaTarget.project(id), delivery = ready["delivery"] as! [String: Any]
        let token = delivery["token"] as! String, bytes = delivery["bytes"] as! Int
        let expiry = delivery["expiresAt"] as! Double
        let start = Date(timeIntervalSince1970: expiry / 1000 - 20)
        let originalMovie = (ready["published"] as! [String: Any])["output"] as! [String: Any]

        let pinned = Rig(start)
        pinned.service.answer("preview.get", waiting)
        pinned.owner.open(target.id)
        await until { !pinned.view.messages.isEmpty }
        pinned.service.answer("preview.get", ready)
        pinned.owner.tick()
        await until { !pinned.view.movies.isEmpty || !pinned.failures.values.isEmpty }
        precondition(pinned.failures.values.isEmpty, "initial failure: \\(pinned.failures.values)")
        precondition(NSDictionary(dictionary: pinned.service.calls[0].1).isEqual(to: ["projectId": id, "range": ["startUs": 0, "endUs": 10_000_000], "maxLongEdge": 960]), "initial call: \\(pinned.service.calls)")
        precondition(NSDictionary(dictionary: pinned.service.calls[1].1).isEqual(to: ["projectId": id, "revisionId": revision, "range": ["startUs": 0, "endUs": 10_000_000], "maxLongEdge": 960]), "ready call: \\(pinned.service.calls)")
        precondition(pinned.view.movies[0].0 == originalMovie["file"] as! String && pinned.view.movies[0].1 == "video/mp4", "movie: \\(pinned.view.movies)")
        // With no name known for the project, its identifiers still stay out of the title.
        precondition(pinned.view.titles.last == "Project preview", "title: \\(pinned.view.titles)")
        pinned.service.answer("project.get", ["projectId": id, "currentRevisionId": "newer-current-revision"])
        pinned.owner.tick()
        await until { pinned.service.count("project.get") == 1 }
        precondition(pinned.view.movies.count == 1 && pinned.service.count("another.get") == 0)
        pinned.owner.close(target: .recording(id))
        precondition(pinned.view.active && pinned.service.closed.isEmpty, "Same-ID recording deletion must not close a project")
        pinned.clock.date = start.addingTimeInterval(11)
        pinned.service.answer("artifact.renew", ["token": token, "bytes": bytes, "expiresAt": expiry + 30_000])
        pinned.owner.tick()
        await until { pinned.service.count("artifact.renew") == 1 }
        let lookupCount = pinned.service.count("project.get")
        await until { pinned.owner.tick(); return pinned.service.count("project.get") > lookupCount }
        pinned.clock.date = start.addingTimeInterval(20.1)
        pinned.owner.tick()
        await until { pinned.service.count("project.get") > lookupCount + 1 || !pinned.failures.values.isEmpty }
        precondition(pinned.failures.values.isEmpty && pinned.view.active && pinned.view.movies.count == 1)
        precondition(pinned.service.calls.filter { $0.0 == "artifact.renew" }.allSatisfy { NSDictionary(dictionary: $0.1).isEqual(to: ["token": token]) })
        pinned.owner.close(target: target)
        await until { pinned.service.closed == [token] }

        let another = Rig(start)
        await another.ready(.project("another"), selecting(.project("another"), ready, token: "project-token"))
        another.owner.tick()
        await until { another.service.count("project.get") == 1 }
        let anotherLookup = another.service.calls.first { $0.0 == "project.get" }!
        precondition(NSDictionary(dictionary: anotherLookup.1).isEqual(to: ["projectId": "another"]) && another.service.count("another.get") == 0)
        another.view.closed?()
        await until { another.service.closed == ["project-token"] }

        // Retry is the same presenter gesture and remains bound to the first returned revision.
        for dependency in [true, false] {
            let retry = Rig(start)
            var failed = waiting; failed["state"] = "failed"; failed["retryable"] = true
            failed["reason"] = "Preparation failed"
            if dependency { failed["dependency"] = ["artifact": "source"] }
            retry.service.answer("preview.get", failed)
            retry.owner.open(target.id)
            await until { !retry.view.messages.isEmpty }
            precondition(retry.view.messages.last!.1 == !dependency)
            if !dependency {
                retry.service.answer("preview.retry", ready)
                retry.view.retry?()
                await until { !retry.view.movies.isEmpty }
                let request = retry.service.calls.first { $0.0 == "preview.retry" }!.1
                precondition(NSDictionary(dictionary: request).isEqual(to: ["projectId": id, "revisionId": revision, "range": ["startUs": 0, "endUs": 10_000_000], "maxLongEdge": 960]))
            }
            retry.owner.close()
            if !dependency { await until { retry.service.closed == [token] } }
        }

        // Presentation failures, owner deletion and renewal refusal all release the active lease.
        for failure in ["playback", "deleted", "renewal"] {
            let rig = Rig(start); await rig.ready(target, ready)
            if failure == "playback" { rig.view.failed?("Decoder refused media") }
            else {
                if failure == "deleted" { rig.service.refuse("project.get", "NOT_FOUND: project deleted") }
                else { rig.clock.date = start.addingTimeInterval(11); rig.service.refuse("artifact.renew", "ARTIFACT_EXPIRED") }
                rig.owner.tick()
            }
            await until { !rig.failures.values.isEmpty && rig.service.closed == [token] }
            precondition(!rig.view.active && rig.view.movies.count == 1)
        }
        let expired = Rig(start); await expired.ready(target, ready)
        expired.clock.date = start.addingTimeInterval(20.1); expired.owner.tick()
        await until { expired.service.closed == [token] }
        precondition(expired.failures.values.last!.contains("expired") && expired.service.count("project.get") == 0)

        for invalid in ["owner", "movie-owner", "both-owners", "no-owner", "revision", "pinned-revision", "movie-revision", "bytes", "mime", "path", "expired", "nonready-delivery"] {
            let rig = Rig(start)
            var changed = ready
            switch invalid {
            case "owner": changed["projectId"] = "other"
            case "movie-owner": changed = movie(ready) { $0["projectId"] = "other" }
            case "both-owners": changed["recordingId"] = id
            case "no-owner": changed.removeValue(forKey: "projectId")
            case "revision": changed["revisionId"] = "other"
            case "pinned-revision": changed = movie(ready) { $0["revisionId"] = "other" }; changed["revisionId"] = "other"
            case "movie-revision": changed = movie(ready) { $0["revisionId"] = "other" }
            case "bytes": changed = movie(ready) { $0["bytes"] = bytes + 1 }
            case "mime": changed = movie(ready) { $0["mediaType"] = "application/octet-stream" }
            case "path": changed = movie(ready) { $0["file"] = "relative.cache" }
            case "expired": rig.clock.date = start.addingTimeInterval(20.1)
            default: changed["state"] = "processing"
            }
            rig.service.answer("preview.get", changed)
            rig.owner.open(target.id, revisionId: revision)
            await until { !rig.failures.values.isEmpty && rig.service.closed == [token] }
            precondition(!rig.view.active && rig.view.movies.isEmpty, "Invalid \(invalid) must never reach presentation")
            precondition(rig.service.calls[0].1["revisionId"] as? String == revision)
        }

        for invalid in ["token", "bytes", "expiry"] {
            let rig = Rig(start); await rig.ready(target, ready)
            rig.clock.date = start.addingTimeInterval(11)
            var renewed: [String: Any] = ["token": token, "bytes": bytes, "expiresAt": expiry + 30_000]
            if invalid == "expiry" { renewed["expiresAt"] = 0 }
            else { renewed[invalid] = invalid == "token" ? "other-token" : bytes + 1 }
            rig.service.answer("artifact.renew", renewed); rig.owner.tick()
            await until { !rig.failures.values.isEmpty && rig.service.closed == [token] }
            precondition(!rig.view.active)
        }

        // Controlled continuations exercise races without any wall-clock lease wait.
        let late = Rig(start); late.service.hold = "preview.get"; late.owner.open(target.id)
        await until { late.service.held != nil }
        late.owner.close(); late.service.resume(ready)
        await until { late.service.closed == [token] }
        precondition(late.view.movies.isEmpty && !late.view.active && late.failures.values.isEmpty)

        let replacement = Rig(start); await replacement.ready(target, ready)
        let oldClose = replacement.view.closed!, oldRetry = replacement.view.retry!, oldFailure = replacement.view.failed!
        replacement.service.answer("preview.get", selecting(.project("replacement"), ready, token: "replacement-token"))
        replacement.owner.open("replacement")
        await until { replacement.view.movies.count == 2 && replacement.service.closed == [token] }
        oldClose(); oldRetry(); oldFailure("late decoder failure")
        precondition(replacement.view.active && replacement.failures.values.isEmpty && replacement.service.count("preview.retry") == 0)
        replacement.owner.close(); await until { replacement.service.closed == [token, "replacement-token"] }

        let replacedRenewal = Rig(start); await replacedRenewal.ready(target, ready)
        replacedRenewal.clock.date = start.addingTimeInterval(11)
        replacedRenewal.service.hold = "artifact.renew"; replacedRenewal.owner.tick()
        await until { replacedRenewal.service.held != nil }
        replacedRenewal.service.answer("preview.get", selecting(.project("replacement"), ready, token: "renewal-replacement"))
        replacedRenewal.owner.open("replacement")
        await until { replacedRenewal.view.movies.count == 2 && replacedRenewal.service.closed == [token] }
        replacedRenewal.service.resume(["token": token, "bytes": bytes, "expiresAt": expiry + 30_000])
        await Task.yield()
        await until { replacedRenewal.owner.tick(); return replacedRenewal.service.count("project.get") > 0 }
        replacedRenewal.owner.close()
        await until { replacedRenewal.service.closed.count == 2 }
        precondition(replacedRenewal.service.closed == [token, "renewal-replacement"],
            "A stale renewal must not replace the new session's lease")

        for expireWhileWaiting in [false, true] {
            let renewal = Rig(start); await renewal.ready(target, ready)
            renewal.clock.date = start.addingTimeInterval(11); renewal.service.hold = "artifact.renew"; renewal.owner.tick()
            await until { renewal.service.held != nil }
            if expireWhileWaiting { renewal.clock.date = start.addingTimeInterval(20.1); renewal.owner.tick() }
            else { renewal.owner.close() }
            renewal.service.resume(["token": token, "bytes": bytes, "expiresAt": expiry + 30_000])
            await until { renewal.service.closed == [token] }
            precondition(!renewal.view.active && renewal.view.movies.count == 1)
        }

        // A bounded receipt is playable immediately; the full pinned receipt takes over at its boundary.
        let progressive = Rig(start)
        var partial = selecting(target, ready, token: "partial-token")
        partial = movie(partial) { value in value["range"] = ["startUs": 0, "endUs": 10_000_000] }
        let full = selecting(target, ready, token: "full-token")
        progressive.service.answer("preview.get", partial)
        progressive.service.answer("preview.get", full)
        progressive.owner.open(target.id)
        await until { progressive.view.movies.count == 1 }
        await until { progressive.service.count("preview.get") == 2 }
        precondition(NSDictionary(dictionary: progressive.service.calls[1].1).isEqual(to: ["projectId": id, "revisionId": revision, "maxLongEdge": 960]))
        precondition(progressive.view.starts == [nil])
        progressive.view.ended?()
        await until { progressive.view.movies.count == 2 }
        precondition(progressive.view.starts == [nil, 10_000_000])
        await until { progressive.service.closed == ["partial-token"] }
        progressive.owner.close()
        await until { progressive.service.closed == ["partial-token", "full-token"] }

        let offsetProgressive = Rig(start)
        var offsetPartial = selecting(target, ready, token: "offset-partial-token")
        offsetPartial = movie(offsetPartial) { value in value["range"] = ["startUs": 20_000_000, "endUs": 30_000_000] }
        let offsetFull = selecting(target, ready, token: "offset-full-token")
        offsetProgressive.service.answer("preview.get", offsetPartial)
        offsetProgressive.service.answer("preview.get", offsetFull)
        offsetProgressive.owner.open(target.id, range: ["startUs": 20_000_000, "endUs": 40_000_000])
        await until { offsetProgressive.view.movies.count == 1 }
        await until { offsetProgressive.service.count("preview.get") == 2 }
        precondition(NSDictionary(dictionary: offsetProgressive.service.calls[1].1).isEqual(to: ["projectId": id, "revisionId": revision, "range": ["startUs": 20_000_000, "endUs": 40_000_000], "maxLongEdge": 960]))
        offsetProgressive.view.ended?()
        await until { offsetProgressive.view.movies.count == 2 }
        precondition(offsetProgressive.view.starts == [nil, 10_000_000])
        offsetProgressive.owner.close()
        await until { offsetProgressive.service.closed == ["offset-partial-token", "offset-full-token"] }
        print("PASS native preview interprets retained project receipts without windows, players or media reads")
        print("PASS recording/project identity, pinned retry, renewal, expiry, revocation, malformed receipts and late callbacks")
    }
}
`,
      );
      assert.match(
        execFileSync(executable, [fixture], { encoding: "utf8", timeout: 30_000 }),
        /PASS native preview interprets retained project receipts/,
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);

test("preview replacement reports continuous native intent without an intermediate idle notification", () => {
  const scratch = mkdtempSync(join(tmpdir(), "yap-preview-intent-"));
  try {
    const executable = compileControlsCheck(
      scratch,
      ["PreviewController", "PreviewWindow"],
      String.raw`
import Foundation
import YapControls
@MainActor final class Presentation: PreviewPresenting {
    func open(title: String, retry: @escaping @MainActor () -> Void, closed: @escaping @MainActor () -> Void) {}
    func show(title: String, message: String, canRetry: Bool) {}
    func play(title: String, file: String, mediaType: String, startAtUs: Int64?, failed: @escaping @MainActor (String) -> Void, ended: @escaping @MainActor () -> Void) {}
    func close() {}
}
struct Refused: Error {}
@main struct Check {
    @MainActor static func main() {
        var owner: PreviewController?
        var observations: [Bool] = []
        let preview = PreviewController(call: { _, _ in throw Refused() }, presentation: Presentation(),
            changed: { observations.append(owner?.isOpen == true) }, failure: { _ in })
        owner = preview
        preview.open("first")
        preview.open("second")
        preview.close()
        print(observations.map(String.init).joined(separator: ","))
    }
}
`,
    );
    assert.equal(
      execFileSync(executable, [], { encoding: "utf8", timeout: 5000 }).trim(),
      "true,true,false",
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
