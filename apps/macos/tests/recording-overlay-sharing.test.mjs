import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compileControlsCheck } from "./fixtures/swift-controls.mjs";

test(
  "the floating controls reach screenshots only once the take is known to leave them out",
  { timeout: 120_000 },
  () => {
    const scratch = mkdtempSync(join(tmpdir(), "yap-overlay-sharing-"));
    try {
      const executable = compileControlsCheck(
        scratch,
        ["RecordingOverlayPanel", "OverlayPanel", "CaptureDisplays"],
        String.raw`
import AppKit
import YapControls
@main struct Check {
    @MainActor static func main() {
        NSApplication.shared.setActivationPolicy(.prohibited)
        let suite = NSTemporaryDirectory() + "yap-overlay-sharing-\(UUID().uuidString)"
        let preferences = Preferences(defaults: UserDefaults(suiteName: suite)!)
        // What the running take answers when asked to leave this app's windows out.
        var excluded = false
        var asked = 0
        let overlay = RecordingOverlayPanel(preferences: preferences, perform: { _ in }, excludeFromTake: {
            asked += 1
            return excluded
        })
        let live = RecordingOverlay.Presentation(elapsed: "0:01", paused: false, symbol: "record.circle.fill")
        func settle() { RunLoop.current.run(until: Date().addingTimeInterval(0.2)) }
        func panel() -> NSWindow {
            guard let window = NSApp.windows.first(where: { $0.title == RecordingOverlayPanel.title && $0.isVisible })
            else { preconditionFailure("The controls are on screen") }
            return window
        }

        overlay.update(live)
        overlay.updateCaptureVisibility(false)
        settle()
        precondition(panel().sharingType == .none, "By default no capture sees the controls")
        precondition(asked == 0, "Hidden controls ask nothing of the take")

        overlay.updateCaptureVisibility(true)
        settle()
        precondition(asked == 1, "Showing the controls to captures first asks the take to leave them out")
        precondition(panel().sharingType == .none, "A take that cannot confirm it leaves them out keeps them hidden")

        excluded = true
        overlay.updateCaptureVisibility(true)
        settle()
        precondition(panel().sharingType == .readOnly, "Once the take leaves them out, screenshots see the controls")

        overlay.updateCaptureVisibility(false)
        precondition(panel().sharingType == .none, "Turning the setting off hides the controls at once")

        // The next take's controls start hidden again until that take confirms too.
        overlay.update(nil)
        excluded = false
        overlay.update(live)
        overlay.updateCaptureVisibility(true)
        settle()
        precondition(panel().sharingType == .none, "A new take's controls wait for that take's answer")
        print("ok")
    }
}
func diagnostic(_ message: String) {}
enum ControlsProbe { static let observed = true }
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
