import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { retryable } from "./refusal.mjs";

// Compile production diagnostics and binding admission without devices or rendering.
test("native diagnostics and implementation bindings use ledger verdicts without wire retry bits", () => {
  const directory = mkdtempSync(join(tmpdir(), "yap-refusal-"));
  const source = (name) => fileURLToPath(new URL(`../Sources/${name}`, import.meta.url));
  try {
    execFileSync("swiftc", [
      "-swift-version",
      "6",
      "-emit-library",
      "-emit-module",
      "-module-name",
      "YapProtocol",
      source("YapProtocol/RefusalLedger.swift"),
      source("YapProtocol/Requirements.swift"),
      "-emit-module-path",
      join(directory, "YapProtocol.swiftmodule"),
      "-o",
      join(directory, "libYapProtocol.dylib"),
    ]);
    execFileSync("swiftc", [
      "-swift-version",
      "6",
      "-emit-library",
      "-emit-module",
      "-module-name",
      "YapMedia",
      source("YapMedia/NativeFailure.swift"),
      source("YapMedia/CubeLUT.swift"),
      "-emit-module-path",
      join(directory, "YapMedia.swiftmodule"),
      "-o",
      join(directory, "libYapMedia.dylib"),
    ]);
    writeFileSync(
      join(directory, "main.swift"),
      String.raw`
import Foundation
import YapMedia
let codes = ["INVALID_EVIDENCE", "INVALID_JOURNAL", "JOURNAL_CHANGED", "INVALID_INPUT_EVIDENCE", "NOT_REQUESTED", "CAMERA_NOT_RESERVED"]
for code in codes {
  let failure = CaptureFinalizationError(CaptureFailure(code, "fixture"))
  let data = try JSONEncoder().encode(failure)
  print("\(data.base64EncodedString()) \(failure.retryable)")
}
for check in [LUTColor.requireImplementation, SDRCorrection.requireImplementation] {
  for binding: String? in [nil, "missing-pin"] {
    do { try check(binding); throw NativeFailure("TEST_FAILED", "Missing implementation admitted") }
    catch {
      let failure = CaptureFinalizationError(error)
      print("\(try JSONEncoder().encode(failure).base64EncodedString()) \(failure.retryable)")
    }
  }
}
`,
    );
    const executable = join(directory, "refusal");
    execFileSync("swiftc", [
      "-swift-version",
      "6",
      "-package-name",
      "YapNative",
      "-I",
      directory,
      "-L",
      directory,
      "-lYapMedia",
      "-lYapProtocol",
      source("YapCapture/CaptureFailure.swift"),
      source("YapFrames/LUTColor.swift"),
      source("YapFrames/SDRCorrection.swift"),
      join(directory, "main.swift"),
      "-o",
      executable,
    ]);
    const output = execFileSync(executable, {
      encoding: "utf8",
      env: { ...process.env, DYLD_LIBRARY_PATH: directory },
    });
    const rows = output.trim().split("\n");
    const codes = [];
    for (const line of rows) {
      const [encoded, value] = line.split(" ");
      const wire = JSON.parse(Buffer.from(encoded, "base64").toString());
      assert.equal(value === "true", retryable(wire), wire.code);
      codes.push(wire.code);
    }
    assert.deepEqual(codes.slice(6), [
      "INTERNAL_ERROR",
      "PINNED_IMPLEMENTATION_UNAVAILABLE",
      "INTERNAL_ERROR",
      "PINNED_IMPLEMENTATION_UNAVAILABLE",
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
