import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileControlsCheck } from "./fixtures/swift-controls.mjs";

// The delete question in its plain, imported and cascade states: synthetic facts, no service.
const output = resolve(process.env.SHOTS ?? "/tmp/yap-delete-dialog-shots");
mkdirSync(output, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "yap-delete-dialog-"));
try {
  const executable = compileControlsCheck(
    scratch,
    ["DeleteAlert"],
    readFileSync(new URL("./fixtures/delete-dialog.swift", import.meta.url), "utf8"),
  );
  execFileSync(executable, [output], { timeout: 20_000, stdio: "inherit" });
  console.log(output);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
