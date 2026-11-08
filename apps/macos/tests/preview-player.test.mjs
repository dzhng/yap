import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { compileControlsCheck } from "./fixtures/swift-controls.mjs";

test(
  "native preview pins revision and stops on revocation, expiry, replacement and late replies",
  { timeout: 90_000 },
  () => {
    const scratch = mkdtempSync(join(tmpdir(), "yap-preview-player-"));
    try {
      const movie = join(scratch, "86ae8cb0-148c-4c4f-8e96-641494912911");
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=5",
        "-t",
        "2",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-f",
        "mp4",
        movie,
      ]);
      const sourceHash = createHash("sha256").update(readFileSync(movie)).digest("hex");
      const source = join(scratch, "Probe.swift");
      writeFileSync(
        source,
        `
import AppKit
import AVKit

struct Refused: LocalizedError { var errorDescription: String? { "NOT_FOUND: project deleted" } }
@MainActor final class Service {
    var delayed = false
    var queued = true
    var deleted = false
    var expiresIn = 30.0
    var brokenFile = false
    var closed: [String] = []
    var serial = 0
    var lastToken = ""
    var renewals = 0
    var refuseRenewal = false
    let file: String
    init(_ file: String) { self.file = file }
    func call(_ operation: String, _ params: [String: Any]) async throws -> Data {
        if operation == "artifact.close" {
            closed.append(params["token"] as! String)
            return Data("{}".utf8)
        }
        if operation == "project.get" {
            if deleted { throw Refused() }
            return Data("{}".utf8)
        }
        let bytes = (try FileManager.default.attributesOfItem(atPath: file)[.size] as! NSNumber).int64Value
        if operation == "artifact.renew" {
            renewals += 1
            if refuseRenewal { throw Refused() }
            return try JSONSerialization.data(withJSONObject: ["token": params["token"]!, "sizeBytes": bytes,
                "expiresAtMs": (Date().timeIntervalSince1970 + 30) * 1000])
        }
        precondition(operation == "preview.get")
        if queued {
            queued = false
            return Data(#"{"projectId":"take","revisionId":"r7","state":"running"}"#.utf8)
        }
        precondition(params["revisionId"] as? String == "r7", "Follow-up must stay on pinned revision")
        serial += 1
        let token = "token-\\(serial)"
        lastToken = token
        if delayed { try await Task.sleep(for: .milliseconds(100)) }
        return try JSONSerialization.data(withJSONObject: ["projectId": "take", "revisionId": "r7", "state": "ready",
            "delivery": ["token": token, "sizeBytes": bytes, "expiresAtMs": (Date().timeIntervalSince1970 + expiresIn) * 1000],
            "published": ["generation": "1", "output": ["projectId": "take", "revisionId": "r7", "mediaType": "video/mp4", "file": brokenFile ? file + "-missing" : file, "bytes": bytes]]])
    }
}
@main struct Probe {
    @MainActor static func settle() async { try? await Task.sleep(for: .milliseconds(180)) }
    @MainActor static func visible() -> NSWindow? { NSApp.windows.first { window in window.isVisible && window.contentView.map { $0.subviews.contains { $0 is AVPlayerView } } == true } }
    @MainActor static func main() async throws {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.accessory)
        let service = Service(CommandLine.arguments[1])
        var failures: [String] = []
        let owner = PreviewController(call: service.call, failure: { _, message in if let message { failures.append(message) } })
        owner.open("take")
        await settle()
        owner.tick()
        await settle()
        guard let window = visible() else { preconditionFailure("Preview did not open: \\(failures)") }
        let view = window.contentView!.subviews.first { $0 is AVPlayerView } as! AVPlayerView
        let item = view.player!.currentItem!
        for _ in 0..<30 {
            if item.status != .unknown { break }
            await settle()
        }
        precondition(item.status == .readyToPlay, "Actual AVPlayer must decode extensionless cache MP4")
        precondition(window.title == "Project preview", "Identifiers stay out of the preview's title")
        precondition(abs(CMTimeGetSeconds(item.duration) - 2) < 0.001)
        view.player!.pause()
        // Renewal extends the same lease, without replacing the pinned player/item.
        try await Task.sleep(for: .seconds(10))
        owner.tick(); await settle()
        precondition(service.renewals == 1 && view.player!.currentItem === item)
        try await Task.sleep(for: .seconds(3))
        owner.tick(); await settle()
        precondition(visible() === window && view.player!.currentItem === item,
            "Renewed lease must keep playback usable beyond the original expiry")
        service.deleted = true
        owner.tick(); await settle()
        precondition(visible() == nil && view.player == nil && service.closed.contains("token-1"))
        precondition(failures.last!.contains("NOT_FOUND"))
        service.deleted = false
        service.queued = true
        service.expiresIn = 0.05
        owner.open("take"); await settle(); owner.tick(); await settle(); owner.tick(); await settle()
        precondition(visible() == nil && failures.last!.contains("expired"))
        service.expiresIn = 30
        service.queued = true
        service.delayed = true
        owner.open("take"); await settle(); owner.tick()
        try await Task.sleep(for: .milliseconds(20))
        owner.close()
        await settle()
        precondition(visible() == nil && service.closed.contains(service.lastToken), "Late delivery must be released without reopening")
        service.delayed = false
        service.queued = true
        owner.open("take"); await settle(); owner.tick(); await settle()
        let replaced = visible()!
        let replacedView = replaced.contentView!.subviews.first { $0 is AVPlayerView } as! AVPlayerView
        let token = service.lastToken
        service.queued = true
        owner.open("take"); await settle()
        precondition(!replaced.isVisible && replacedView.player == nil && service.closed.contains(token))
        owner.tick(); await settle()
        let closing = visible()!
        let closingView = closing.contentView!.subviews.first { $0 is AVPlayerView } as! AVPlayerView
        closing.performClose(nil)
        await settle()
        precondition(!closing.isVisible && closingView.player == nil && service.closed.contains(service.lastToken))
        service.queued = true
        service.brokenFile = true
        let beforeFailure = failures.count
        owner.open("take"); await settle(); owner.tick()
        // A playback failure arrives before the asynchronous service release can finish.
        for _ in 0..<30 {
            if failures.count > beforeFailure && service.closed.contains(service.lastToken) { break }
            await settle()
        }
        precondition(failures.count > beforeFailure && visible() == nil
            && service.closed.contains(service.lastToken), "SDK playback failure must stop and release")
        service.queued = true
        service.brokenFile = false
        service.refuseRenewal = true
        owner.open("take"); await settle(); owner.tick(); await settle()
        precondition(visible() != nil)
        try await Task.sleep(for: .seconds(10))
        owner.tick(); await settle()
        precondition(visible() == nil && service.closed.contains(service.lastToken),
            "Renewal refusal must stop playback and release the old token")
        print("PASS extensionless native playback, pinned revision, renewal, revocation, expiry, late delivery, replacement, window close")
    }
}
`,
      );
      const binary = compileControlsCheck(
        scratch,
        ["PreviewController", "PreviewWindow"],
        readFileSync(source, "utf8"),
      );
      // Ordered in behind everything, like every other launch a check drives: this probe opens
      // real windows, and none of them may take the screen from whoever is at this Mac.
      const output = execFileSync(binary, [movie], {
        encoding: "utf8",
        timeout: 45_000,
        env: { ...process.env, YAP_FIXTURE_CONTROLS: scratch },
      });
      assert.match(output, /PASS extensionless native playback/);
      assert.equal(createHash("sha256").update(readFileSync(movie)).digest("hex"), sourceHash);
      console.log(output.trim());
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);

test(
  "native preview advances continuously to the end of retained current audio-video",
  { timeout: 90_000 },
  () => {
    const evidence = process.env.YAP_PREVIEW_CONTINUOUS_EVIDENCE;
    const scratch = evidence ?? mkdtempSync(join(tmpdir(), "yap-preview-continuous-"));
    const movie = join(scratch, "pinned-movie");
    const reportFile = join(scratch, "playback.json");
    const archive = fileURLToPath(
      new URL(
        "../../../specs/done/agent-editing/assets/23-owner-fixture-ports/default-gate-recovery-evidence.tar.gz",
        import.meta.url,
      ),
    );
    const member =
      "default-gate-recovery-e9090034/retained-generated-render-timing/6fd2ef65-89b5-470f-b553-a49dbf25e7d3.mp4";
    const sha256 = "dc63ab7c40a57996a91fbc09312c139dc2f85bde97a2ad0c58919b715a68e5df";
    const compilation = [];
    try {
      // This complete current-production movie already has independent picture/PTS/AAC proof.
      // Loading it adds player evidence without repeating native rendering or media setup.
      const bytes = execFileSync("tar", ["-xOf", archive, member], {
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      });
      assert.equal(bytes.length, 167145);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), sha256);
      writeFileSync(movie, bytes, { flag: "wx" });
      const binary = compileControlsCheck(
        scratch,
        ["PreviewController", "PreviewWindow"],
        `
import AppKit
import AVKit

struct PlaybackFailure: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}
@MainActor final class PinnedService {
    let file: String
    let project = "36c7e994-a477-4b0b-8ef1-130c29fb4f70"
    let revision = "6fd2ef65-89b5-470f-b553-a49dbf25e7d3"
    var closed: [String] = []
    init(_ file: String) { self.file = file }
    func call(_ operation: String, _ params: [String: Any]) async throws -> Data {
        if operation == "artifact.close" {
            guard params["token"] as? String == "continuous-token" else { throw PlaybackFailure("Wrong released token") }
            closed.append("continuous-token")
            return Data("{}".utf8)
        }
        guard params["projectId"] as? String == project else { throw PlaybackFailure("Changed project target") }
        if operation == "project.get" { return Data("{}".utf8) }
        guard operation == "preview.get", params["revisionId"] as? String == revision else {
            throw PlaybackFailure("Changed pinned revision")
        }
        return try JSONSerialization.data(withJSONObject: [
            "projectId": project, "revisionId": revision, "state": "ready",
            "delivery": ["token": "continuous-token", "sizeBytes": 167145,
                "expiresAtMs": (Date().timeIntervalSince1970 + 30) * 1000],
            "published": ["generation": "1", "output": ["projectId": project, "revisionId": revision,
                "mediaType": "video/mp4", "file": file, "bytes": 167145]],
        ])
    }
}
@main struct ContinuousPlayback {
    @MainActor static func main() async throws {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.accessory)
        let service = PinnedService(CommandLine.arguments[1])
        var failures: [String] = []
        var observations: [[String: Any]] = []
        var report: [String: Any] = ["passed": false, "pid": ProcessInfo.processInfo.processIdentifier,
            "scope": "Unchanged production controller/presenter; controlled ready receipt; muted retained current A/V movie, not listening or moving-pointer verification"]
        let owner = PreviewController(call: service.call, failure: { _, message in if let message { failures.append(message) } })
            .titled { $0 == service.project ? "Fixture project" : nil }
        owner.open(service.project, revisionId: service.revision)
        let window = NSApp.windows.first { $0.isVisible && $0.title == "Fixture project" }!
        let view = window.contentView!.subviews.first { $0 is AVPlayerView } as! AVPlayerView
        // The ready task cannot run on this actor until the first await below. KVO delivery
        // from this actor's player assignment mutes it before PreviewWindow calls play().
        var mutedAssignments = 0
        var mutedPlayers = Set<ObjectIdentifier>()
        let muting = view.observe(\\.player, options: [.new]) { view, _ in
            MainActor.assumeIsolated {
                if let player = view.player { player.isMuted = true; mutedAssignments += 1; mutedPlayers.insert(ObjectIdentifier(player)) }
            }
        }
        var endedIdentity: ObjectIdentifier?
        let ending = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime,
            object: nil, queue: .main) { notification in
                let identity = (notification.object as? AVPlayerItem).map(ObjectIdentifier.init)
                MainActor.assumeIsolated { endedIdentity = identity }
            }
        var failure: Error?
        do {
            let readiness = ContinuousClock.now.advanced(by: .seconds(5))
            while view.player?.currentItem?.status != .readyToPlay {
                guard failures.isEmpty, ContinuousClock.now < readiness else {
                    throw PlaybackFailure("Retained movie did not become ready: \\(failures)")
                }
                try await Task.sleep(for: .milliseconds(25))
            }
            let player = view.player!, item = player.currentItem!
            guard mutedPlayers == [ObjectIdentifier(player)], player.isMuted else { throw PlaybackFailure("Player was not muted at assignment") }
            guard abs(item.duration.seconds - 6) < 0.001 else { throw PlaybackFailure("Wrong retained duration") }
            guard window.title == "Fixture project" else { throw PlaybackFailure("The preview is titled by its project's name") }
            let advanceDeadline = ContinuousClock.now.advanced(by: .seconds(2))
            let completionDeadline = ContinuousClock.now.advanced(by: .seconds(10))
            var advanced = false
            while endedIdentity == nil {
                let seconds = player.currentTime().seconds
                observations.append(["seconds": seconds, "timeControlStatus": player.timeControlStatus.rawValue,
                    "rate": player.rate, "itemStatus": item.status.rawValue])
                guard failures.isEmpty, item.status != .failed, window.isVisible,
                    view.player === player, player.currentItem === item, window.title == "Fixture project", player.isMuted else {
                    throw PlaybackFailure("Pinned player changed or failed: \\(failures)")
                }
                if seconds > 0.5 { advanced = true }
                guard advanced || ContinuousClock.now < advanceDeadline else { throw PlaybackFailure("Player did not advance") }
                guard ContinuousClock.now < completionDeadline else { throw PlaybackFailure("Player did not reach end") }
                owner.tick()
                try await Task.sleep(for: .milliseconds(50))
            }
            guard advanced, endedIdentity == ObjectIdentifier(item) else { throw PlaybackFailure("Wrong end notification or no advance") }
            guard CMTimeCompare(player.currentTime(), item.duration) == 0 else {
                throw PlaybackFailure("Playback endpoint differs from the pinned duration")
            }
            report["passed"] = true
            report["endedSeconds"] = player.currentTime().seconds
            report["durationSeconds"] = item.duration.seconds
            report["sameItemThroughEnd"] = true
            report["revisionId"] = service.revision
        } catch { failure = error; report["error"] = error.localizedDescription }
        owner.close()
        let releaseDeadline = ContinuousClock.now.advanced(by: .seconds(2))
        while service.closed.isEmpty && ContinuousClock.now < releaseDeadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        muting.invalidate()
        NotificationCenter.default.removeObserver(ending)
        report["observations"] = observations
        report["failures"] = failures
        report["mutedAssignments"] = mutedAssignments
        report["mutedPlayerCount"] = mutedPlayers.count
        report["closedTokens"] = service.closed
        report["windowClosed"] = !window.isVisible
        report["playerReleased"] = view.player == nil
        if service.closed != ["continuous-token"] || window.isVisible || view.player != nil {
            report["passed"] = false
            if failure == nil { failure = PlaybackFailure("Player teardown did not release ownership") }
        }
        try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
            .write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
        if let failure { throw failure }
        print("PASS muted pinned current A/V playback advances to end and releases player/window/lease")
    }
}
`,
        (command) => compilation.push(command),
      );
      writeFileSync(join(scratch, "compilation.json"), JSON.stringify(compilation, null, 2));
      const result = spawnSync(binary, [movie, reportFile], {
        encoding: "utf8",
        timeout: 20_000,
        env: { ...process.env, YAP_FIXTURE_CONTROLS: scratch },
      });
      writeFileSync(
        join(scratch, "process.json"),
        JSON.stringify(
          {
            binary,
            args: [movie, reportFile],
            pid: result.pid,
            status: result.status,
            signal: result.signal,
            error: result.error?.message,
            stdout: result.stdout,
            stderr: result.stderr,
          },
          null,
          2,
        ),
      );
      const report = JSON.parse(readFileSync(reportFile, "utf8"));
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(report.passed, true, JSON.stringify(report));
      assert.deepEqual(report.closedTokens, ["continuous-token"]);
      assert.equal(createHash("sha256").update(readFileSync(movie)).digest("hex"), sha256);
      console.log(result.stdout.trim());
    } finally {
      if (!evidence) rmSync(scratch, { recursive: true, force: true });
    }
  },
);
