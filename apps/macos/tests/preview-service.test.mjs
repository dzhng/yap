import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { compileControlsCheck } from "./fixtures/swift-controls.mjs";
import { generatedVideoProject } from "./fixtures/generated-project.mjs";
import { page } from "./fixtures/generated-capture.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
test(
  "native player consumes the bundled service's pinned preview and renewable lease",
  { timeout: 100000 },
  async () => {
    const home = await mkdtemp("/tmp/yap-player-service-");
    let safeToRemove = true;
    try {
      const source = join(home, "fixture");
      await mkdir(source);
      const movie = join(source, "video.mov");
      execFileSync(
        "ffmpeg",
        [
          "-nostdin",
          "-v",
          "error",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "-s",
          "1280x800",
          "-r",
          "1",
          "-i",
          "pipe:0",
          "-vf",
          "tpad=stop_mode=clone:stop_duration=7",
          "-an",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          movie,
        ],
        { input: page(false), timeout: 20000 },
      );
      const project = await generatedVideoProject(home, movie, {
        width: 1280,
        height: 800,
        durationUs: 8000000,
      });
      const original = createHash("sha256")
        .update(await readFile(movie))
        .digest("hex");
      const swift = join(home, "Integration.swift");
      await writeFile(
        swift,
        `
import AppKit
import AVKit
import Foundation
import CryptoKit

@MainActor final class Bridge {
    var state: ServiceHost.State = .starting
}
@main struct Integration {
    @MainActor static func main() {
        let app = NSApplication.shared
        Task { @MainActor in
            do { try await runIntegration(); app.terminate(nil) }
            catch {
                FileHandle.standardError.write(Data("Integration failed: \\(error)\\n".utf8))
                exit(1)
            }
        }
        app.run()
    }
    @MainActor static func pause() async { try? await Task.sleep(for: .milliseconds(100)) }
    /// The preview's video player, wherever the window lays it out.
    @MainActor static func player(_ window: NSWindow?) -> AVPlayerView? {
        window?.contentView?.subviews.first { $0 is AVPlayerView } as? AVPlayerView
    }
    @MainActor static func visible() -> NSWindow? { NSApp.windows.first { $0.isVisible && player($0) != nil } }
    @MainActor static func descendants(_ view: NSView) -> [NSView] { view.subviews + view.subviews.flatMap(descendants) }
    /// The revision choices the window shows, newest first, as the service's history named them.
    @MainActor static func revisions(_ window: NSWindow?) -> [String] {
        window?.contentView.map(descendants)?.compactMap { $0 as? PreviewPill }
            .filter { $0.title.hasPrefix("Revision ") }.map { $0.title } ?? []
    }
    @MainActor static func runIntegration() async throws {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.accessory)
        let bundle = Bundle(path: CommandLine.arguments[1])!
        let resolved: ServiceBundle = try await withCheckedThrowingContinuation { continuation in
            ServiceBundle.resolve(in: bundle) { continuation.resume(with: $0) }
        }
        let bridge = Bridge()
        let host = ServiceHost(
            bundle: resolved,
            onNativeCall: { _, _, answer in
                answer(.failure(ServiceFailure(code: "UNKNOWN_OPERATION", message: "This check owns no capture session")))
            }
        ) { state in Task { @MainActor in bridge.state = state } }
        host.start()
        defer { host.shutdown() }
        var ready = false
        for _ in 0..<100 {
            if case .ready = bridge.state { ready = true; break }
            if case .unavailable(let code, let message) = bridge.state { fatalError("\\(code): \\(message)") }
            await pause()
        }
        precondition(ready, "Bundled service did not become ready")
        if case .ready(let pid, _) = bridge.state {
            FileHandle.standardOutput.write(Data("SERVICE_PID=\\(pid)\\n".utf8))
        }
        var failures: [String] = []
        let owner = PreviewController(call: { try await host.call($0, $1) }, timelineEnabled: true, failure: { failures.append($0) })
        defer { owner.close() }
        let id = CommandLine.arguments[2]
        owner.open(id)
        var item: AVPlayerItem?
        for _ in 0..<150 {
            owner.tick(); await pause()
            precondition(failures.isEmpty, "Preview failed: \\(failures)")
            if let candidate = player(visible())?.player?.currentItem,
                candidate.status == .readyToPlay { item = candidate; break }
        }
        guard let item, let window = visible(), let view = player(window) else {
            fatalError("Actual service preview never became playable")
        }
        // The window reads the project's history from revision.history: its create and its edit.
        for _ in 0..<50 where revisions(window).isEmpty { await pause() }
        precondition(revisions(window) == ["Revision 2", "Revision 1"], "Revision history shows: \\(revisions(window))")
        // The pinned revision is the original 8 s edit; identifiers stay out of the title.
        precondition(abs(CMTimeGetSeconds(item.duration)-8) < 0.001)
        precondition(!view.allowsVideoFrameAnalysis)
        view.player!.pause()
        _ = try await host.call("edit.apply", ["projectId": id, "requestId": UUID().uuidString, "expectedRevisionId": CommandLine.arguments[5], "operations": [["operation": "remove", "clipIds": [CommandLine.arguments[6]], "ranges": [["startUs": 2000000, "endUs": 4000000]], "ripple": ["trackIds": [CommandLine.arguments[7]]]]]])
        // The real service lease initially lasts 30s. Paused playback must retain its
        // original item past that deadline while the current library edit advances.
        let until = Date().addingTimeInterval(31)
        while Date() < until {
            owner.tick(); await pause()
            precondition(failures.isEmpty && visible() === window && view.player?.currentItem === item,
                "Pinned player changed or lost its renewed lease: failures=\\(failures), visible=\\(visible() === window), item=\\(view.player?.currentItem === item), status=\\(item.status.rawValue), error=\\(String(describing: item.error))")
        }
        precondition(abs(CMTimeGetSeconds(item.duration)-8) < 0.001)
        let current = try JSONSerialization.jsonObject(with: await host.call("revision.get", ["projectId":id])) as! [String:Any]
        let document = (current["revision"] as! [String: Any])["document"] as! [String: Any]
        let clips = document["clips"] as! [[String: Any]]
        let duration = clips.reduce(0) { total, clip in let placement = clip["placement"] as! [String: Any]; let range = placement["range"] as! [String: Int]; return total + range["endUs"]! - range["startUs"]! }
        precondition(duration == 6000000)
        let asset = item.asset as! AVURLAsset
        precondition(FileManager.default.fileExists(atPath: asset.url.path))
        let hash = SHA256.hash(data: try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[3])))
            .map { String(format: "%02x", $0) }.joined()
        precondition(hash == CommandLine.arguments[4], "Source changed during native playback")
        print("PASS pinned native player past original lease deadline; current edit is 6s")
        _ = try await host.call("project.delete", ["projectId":id, "requestId": UUID().uuidString])
        for _ in 0..<30 { owner.tick(); await pause(); if visible() == nil { break } }
        precondition(visible() == nil && view.player == nil)
        precondition(!FileManager.default.fileExists(atPath: asset.url.path))
        precondition(failures.last?.contains("NOT_FOUND") == true)
        print("PASS real deletion stops player and removes cached media")
    }
}
`,
      );
      const binary = compileControlsCheck(
        home,
        ["PreviewController", "PreviewWindow", "ServiceHost", "ServiceBundle", "NodeRuntime"],
        await readFile(swift, "utf8"),
      );
      safeToRemove = false;
      const result = await new Promise((resolve, reject) => {
        const child = spawn(
          binary,
          [
            join(root, "dist/Yap.app"),
            project.projectId,
            movie,
            original,
            project.revisionId,
            project.clipId,
            project.trackId,
          ],
          { env: { ...process.env, YAP_HOME: home }, stdio: ["ignore", "pipe", "pipe"] },
        );
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.once("error", reject);
        const timeout = setTimeout(() => child.kill("SIGKILL"), 55000);
        child.once("close", (code, signal) => {
          clearTimeout(timeout);
          resolve({ code, signal, stdout, stderr });
        });
      });
      const pid = Number(result.stdout.match(/SERVICE_PID=(\d+)/)?.[1]);
      assert.ok(Number.isInteger(pid) && pid > 0, result.stderr + result.stdout);
      const alive = () => {
        if (!pid) return false;
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          if (error.code === "ESRCH") return false;
          throw error;
        }
      };
      for (let attempts = 0; alive() && attempts < 100; attempts++)
        await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(alive(), false, "Owned service must exit before removing its home");
      safeToRemove = true;
      assert.equal(result.code, 0, result.stderr + result.stdout);
      assert.match(result.stdout, /PASS real deletion stops player/);
      console.log(result.stdout.trim());
    } finally {
      if (safeToRemove) await rm(home, { recursive: true, force: true });
    }
  },
);
