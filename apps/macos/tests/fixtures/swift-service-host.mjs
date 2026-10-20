import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mediaLinkArguments } from "./swift-media.mjs";

const sources = fileURLToPath(new URL("../../Sources/Yap/", import.meta.url));
export function checkServiceHost(
  t,
  peer,
  body,
  extraSources = [],
  nativeHandler = 'answer(.failure(ServiceFailure(code: "UNEXPECTED", message: "No native call expected")))',
) {
  const scratch = mkdtempSync(join(tmpdir(), "yap-update-host-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const script = join(scratch, "peer.mjs");
  writeFileSync(script, peer);
  const main = join(scratch, "Main.swift");
  writeFileSync(
    main,
    `
import Foundation
import Darwin
func diagnostic(_ message: String) {}
@main struct Probe {
@MainActor static func main() async {
    let bundle = ServiceBundle(script: URL(fileURLWithPath: ${JSON.stringify(script)}),
        node: ${JSON.stringify(process.execPath)}, native: URL(fileURLWithPath: "/unused"),
        controlFrameBytes: 65536, maxPendingCalls: 32, callTimeout: 1,
        startupDeadline: Date().addingTimeInterval(2))
    var observed: ServiceHost.State = .starting
    var progress: @MainActor @Sendable () -> Void = {}
    let host = ServiceHost(bundle: bundle, onNativeCall: { _, _, answer in
        ${nativeHandler}
    }, onState: { state in MainActor.assumeIsolated { observed = state } },
       onUpdateProgress: { MainActor.assumeIsolated { progress() } })
    host.start()
    for _ in 0..<200 {
        if case .ready = observed { break }
        try? await Task.sleep(for: .milliseconds(10))
    }
    ${body}
    host.shutdown()
}
}
`,
  );
  const executable = join(scratch, "check");
  const compile = spawnSync(
    "swiftc",
    [
      "-swift-version",
      "6",
      "-parse-as-library",
      ...mediaLinkArguments(),
      ...["ServiceHost", "ServiceBundle", "NodeRuntime", ...extraSources].map((name) =>
        join(sources, `${name}.swift`),
      ),
      main,
      "-o",
      executable,
    ],
    { encoding: "utf8", timeout: 60000 },
  );
  assert.equal(compile.status, 0, compile.stderr);
  return spawnSync(executable, [], { encoding: "utf8", timeout: 12000 });
}
