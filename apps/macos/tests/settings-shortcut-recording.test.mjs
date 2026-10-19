import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compileControlsCheck } from "./fixtures/swift-controls.mjs";

test(
  "a captured shortcut ends recording and gives the shortcuts back, accepted or refused",
  { timeout: 180_000 },
  (t) => {
    const scratch = mkdtempSync(join(tmpdir(), "yap-settings-recording-"));
    t.after(() => rmSync(scratch, { recursive: true, force: true }));
    const executable = compileControlsCheck(
      scratch,
      ["SettingsWindow", "WindowMenu", "CurrentKeyboardLayout"],
      String.raw`
import AppKit
import YapControls

enum ControlsProbe { static let observed = true }
@main struct Check {
    @MainActor static func main() {
        var trace: [String] = []
        var accept = true
        let model = SettingsModel(
            preferences: Preferences(defaults: UserDefaults(suiteName: CommandLine.arguments[1])!),
            perform: { _ in }, update: { _, _ in },
            suspendShortcuts: { trace.append("suspend") }, resumeShortcuts: { trace.append("resume") },
            setShortcut: { _, _ in trace.append("set"); return accept })
        let key = Shortcut(keyCode: 1, modifiers: 2_560, label: "⌥⇧S")
        model.beginShortcutRecording(.startOrStop)
        model.captureShortcut(.startOrStop, shortcut: key)
        print(trace.joined(separator: ","), model.recordingAction == nil, model.shortcutErrorAction == nil)
        trace = []
        accept = false
        model.beginShortcutRecording(.startOrStop)
        model.captureShortcut(.startOrStop, shortcut: key)
        print(trace.joined(separator: ","), model.recordingAction == nil, model.shortcutErrorAction == .startOrStop)
        // Leaving the field afterwards changes nothing more.
        trace = []
        model.endShortcutRecording(.startOrStop)
        print(trace.isEmpty)
    }
}
`,
    );
    const lines = execFileSync(executable, [join(scratch, "defaults")], { encoding: "utf8" })
      .trim()
      .split("\n");
    assert.deepEqual(lines, [
      "suspend,set,resume true true",
      "suspend,set,resume true true",
      "true",
    ]);
  },
);
