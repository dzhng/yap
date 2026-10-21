import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileControlsCheck } from "./fixtures/swift-controls.mjs";

// Render the production paste notices offscreen, light and dark, without a service,
// a paste or anything ordered over the person's work.
const output = resolve(process.env.SHOTS ?? "specs/show-your-agent/assets/paste-notice");
mkdirSync(output, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "yap-paste-notice-"));
try {
  const executable = compileControlsCheck(
    scratch,
    ["PasteNotice", "OverlayPanel"],
    String.raw`
import AppKit
import YapControls

enum ControlsProbe { static let observed = true }
@main struct Shots {
    @MainActor static func main() {
        NSApplication.shared.setActivationPolicy(.prohibited)
        let output = CommandLine.arguments[1]
        for (theme, appearance) in [("light", NSAppearance.Name.aqua), ("dark", .darkAqua)] {
            for (name, outcome) in [("copied", Paster.Outcome.copied), ("reopen", .copiedUntilReopen)] {
                let panel = PasteNotice.makePanel(outcome.notice!)
                precondition(panel.styleMask.contains(.nonactivatingPanel), "The notice never takes focus")
                precondition(panel.ignoresMouseEvents, "A click falls through the notice to the app underneath")
                panel.appearance = NSAppearance(named: appearance)
                panel.setFrameOrigin(NSPoint(x: -10000, y: -10000))
                panel.present()
                RunLoop.current.run(until: Date().addingTimeInterval(0.4))
                let content = panel.contentView!
                content.layoutSubtreeIfNeeded()
                let bitmap = content.bitmapImageRepForCachingDisplay(in: content.bounds)!
                content.cacheDisplay(in: content.bounds, to: bitmap)
                try! bitmap.representation(using: .png, properties: [:])!.write(to:
                    URL(fileURLWithPath: "\(output)/\(theme)-\(name).png"))
                panel.orderOut(nil)
                panel.close()
            }
        }
    }
}
`,
  );
  execFileSync(executable, [output], { timeout: 60_000 });
  console.log(output);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
