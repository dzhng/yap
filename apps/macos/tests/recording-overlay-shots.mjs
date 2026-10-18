import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileControlsCheck } from "./fixtures/swift-controls.mjs";

// Draw and drive the production take controls with a synthetic camera picture.
// No device or service is touched. Liquid Glass is drawn only by the window server, so the
// controls are captured from the screen: the terminal running this needs screen recording access.
const output = resolve(process.env.SHOTS ?? "/tmp/yap-recording-overlay-shots");
mkdirSync(output, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "yap-recording-overlay-"));
try {
  const executable = compileControlsCheck(
    scratch,
    ["RecordingOverlayPanel", "OverlayPanel", "CaptureDisplays"],
    readFileSync(new URL("./fixtures/recording-overlay.swift", import.meta.url), "utf8"),
  );
  execFileSync(executable, [output], { timeout: 20_000, stdio: "inherit" });
  console.log(output);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
