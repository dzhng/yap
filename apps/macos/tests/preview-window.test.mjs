import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compileControlsCheck } from "./fixtures/swift-controls.mjs";

test(
  "the preview window can be captured except during a take, and never covers the video",
  { timeout: 120_000 },
  () => {
    const scratch = mkdtempSync(join(tmpdir(), "yap-preview-window-"));
    try {
      const executable = compileControlsCheck(
        scratch,
        ["PreviewController", "PreviewWindow"],
        String.raw`
import AppKit
import AVKit
@main struct Check {
    @MainActor static func main() {
        NSApplication.shared.setActivationPolicy(.prohibited)
        let preview = PreviewWindow()
        preview.open(title: "Fixture preview", retry: {}, closed: {})
        guard let window = NSApp.windows.first(where: { $0.title == "Fixture preview" }),
              let content = window.contentView else { preconditionFailure("The preview opens a window") }
        precondition(window.sharingType != .none, "People can screenshot and share the preview window")
        func player() -> NSView { descendants(content).first { $0 is AVPlayerView }! }
        func bars() -> [NSView] { descendants(content).filter { $0 is NSStackView && !$0.isHidden } }
        content.layoutSubtreeIfNeeded()
        precondition(bars().isEmpty, "With no revision history there is no bar")
        precondition(player().frame.height >= content.bounds.height - 1, "The video fills the window")
        precondition((player() as! AVPlayerView).videoGravity == .resizeAspect,
                     "Preview preserves the whole video frame instead of zooming to fill")
        let video = player().frame
        precondition(abs(video.width / video.height - 16.0 / 9.0) < 0.02, "The video area is 16:9: \(video.size)")
        // The controller offers Export before the revision history arrives.
        preview.showExport {}
        var chosen: [String] = []
        preview.showTimeline([PreviewTimelineItem(id: "r2", ordinal: 1, label: "Revision 2", operation: "edit"),
                              PreviewTimelineItem(id: "r1", ordinal: 0, label: "Revision 1", operation: "edit")],
            selected: "r2", select: { chosen.append($0) })
        content.layoutSubtreeIfNeeded()
        guard let bar = bars().first else { preconditionFailure("Revision history shows a bar") }
        bar.layoutSubtreeIfNeeded()
        let export = descendants(bar).first { ($0 as? NSButton)?.title == "Export" }!
        let exportFrame = export.convert(export.bounds, to: bar)
        precondition(bar.bounds.maxX - exportFrame.maxX < 30, "Export stays at the right edge: \(exportFrame) in \(bar.bounds)")
        let pills = descendants(bar).compactMap { $0 as? NSButton }.filter { $0.identifier?.rawValue.hasPrefix("preview.revision.") == true }
        precondition(pills.map(\.title) == ["Revision 2", "Revision 1"], "A few revisions show as one row of choices")
        precondition(pills.map { $0.accessibilityRole() } == [.radioButton, .radioButton]
                     && (pills[0].accessibilityValue() as? NSNumber)?.boolValue == true
                     && (pills[1].accessibilityValue() as? NSNumber)?.boolValue == false,
                     "The shown revision is the selected one")
        pills[1].performClick(nil)
        precondition(chosen == ["r1"], "Choosing a segment shows that revision: \(chosen)")
        let barFrame = bar.convert(bar.bounds, to: content), videoFrame = player().convert(player().bounds, to: content)
        precondition(!barFrame.intersects(videoFrame), "The bar sits beside the video, never over it")
        // A display take leaves out this app's windows only if one was on screen when it began.
        PreviewWindow.takeInProgress = true
        precondition(window.sharingType == .none, "While a take records, the preview stays out of it")
        PreviewWindow.takeInProgress = false
        precondition(window.sharingType != .none, "After the take, the preview can be captured again")
        print("ok")
    }
    @MainActor static func descendants(_ view: NSView) -> [NSView] { view.subviews + view.subviews.flatMap(descendants) }
}
`,
      );
      const out = execFileSync(executable, [], {
        encoding: "utf8",
        timeout: 20_000,
        env: { ...process.env, YAP_FIXTURE_CONTROLS: "1" },
      });
      assert.equal(out.trim(), "ok");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);

test("closing a recording's window stops its playback", { timeout: 120_000 }, () => {
  const scratch = mkdtempSync(join(tmpdir(), "yap-preview-close-"));
  try {
    const clip = join(scratch, "clip.mp4");
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=30",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440",
      "-t",
      "5",
      "-pix_fmt",
      "yuv420p",
      "-shortest",
      clip,
    ]);
    const executable = compileControlsCheck(
      scratch,
      ["PreviewController", "PreviewWindow"],
      String.raw`
import AppKit
import AVKit
@main struct Check {
    @MainActor static func main() {
        NSApplication.shared.setActivationPolicy(.prohibited)
        let preview = PreviewWindow()
        preview.playLocalFile(title: "Recording", file: CommandLine.arguments[1], mediaType: "video/mp4")
        guard let window = NSApp.windows.first(where: { $0.title == "Recording" }),
              let view = window.contentView?.subviews.first(where: { $0 is AVPlayerView }) as? AVPlayerView,
              let player = view.player else { preconditionFailure("The recording plays in a window") }
        RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        precondition(player.rate > 0, "The recording is playing")
        window.performClose(nil)
        RunLoop.current.run(until: Date().addingTimeInterval(0.3))
        precondition(player.rate == 0 && player.currentItem == nil, "Closing the window stops the recording's sound")
        print("ok")
    }
}
`,
    );
    const out = execFileSync(executable, [clip], {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, YAP_FIXTURE_CONTROLS: "1" },
    });
    assert.equal(out.trim(), "ok");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
