import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compileControlsCheck } from "./fixtures/swift-controls.mjs";

test("settings delegates opt-out to the updater and reflects only its effective state", () => {
  const scratch = mkdtempSync(join(tmpdir(), "yap-update-settings-"));
  try {
    const executable = compileControlsCheck(
      scratch,
      ["SettingsWindow", "WindowMenu", "CurrentKeyboardLayout"],
      String.raw`
import AppKit
import YapControls

enum ControlsProbe { static let observed = true }
@main struct Check {
    @MainActor static func main() {
        let suite = CommandLine.arguments[1]
        let defaults = UserDefaults(suiteName: suite)!
        let preferences = Preferences(defaults: defaults)
        var enabled = true
        var checks = 0
        @MainActor final class FakeSetup: AgentSetup {
            var values: [Bool] = []
            func setEnabled(_ enabled: Bool) { values.append(enabled) }
            func summary() -> String { "yap command + skill, kept current. All good ✓" }
        }
        let setup = FakeSetup()
        let model = SettingsModel(preferences: preferences, perform: { _ in
            preconditionFailure("Update controls must not require the media service")
        }, update: { operation, params in
            switch operation {
            case "update.setEnabled": enabled = params["enabled"] as! Bool
            case "update.check": checks += 1
            default: preconditionFailure("Unknown updater command")
            }
        }, agentSetup: setup)
        precondition(model.setUpAgents, "Agent setup is enabled by default")
        precondition(model.agentSummary.hasSuffix("All good ✓"), "The row shows the setup summary")
        model.setUpAgents = false
        model.setUpAgents = true
        precondition(setup.values == [false, true], "One toggle turns the command and skill off and on together")
        let before = defaults.persistentDomain(forName: suite)
        model.state.updates = UpdateControls(available: true, enabled: true, status: "An update is waiting for recording and background work to finish.")
        model.state.service = .unavailable("Service stopped during update shutdown")
        model.setAutomaticUpdates(false)
        precondition(!enabled, "Opt-out reaches the native updater without a ready service")
        precondition(model.state.updates.enabled, "The checkbox waits for its owner's effective state")
        precondition(NSDictionary(dictionary: defaults.persistentDomain(forName: suite) ?? [:]).isEqual(to: before ?? [:]), "Settings does not write another preference")
        model.state.updates = UpdateControls(available: true, enabled: false)
        model.setAutomaticUpdates(true)
        precondition(enabled)
        enabled = false
        model.state.updates = UpdateControls(available: true, enabled: false, canCheck: true)
        model.checkForUpdates()
        precondition(checks == 1, "An explicit check reaches the same native boundary")
        precondition(!enabled && !model.state.updates.enabled)
        model.state.updates = UpdateControls(available: true, enabled: false, canCheck: false)
        model.checkForUpdates()
        precondition(checks == 1, "An active SDK cycle cannot be checked again")
        model.state.updates = UpdateControls()
        model.setAutomaticUpdates(true)
        model.checkForUpdates()
        precondition(!enabled && checks == 1, "Personal/source builds cannot request an updater action")
        print("PASS settings delegates update changes and displays effective owner state")
    }
}
`,
    );
    const output = execFileSync(executable, [join(scratch, "defaults")], { encoding: "utf8" });
    assert.match(output, /PASS settings delegates update changes/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
