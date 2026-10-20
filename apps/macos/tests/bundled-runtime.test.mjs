import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { mediaLinkArguments } from "./fixtures/swift-media.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
let scratch, probe;
before(() => {
  scratch = mkdtempSync("/tmp/yap-runtime-");
  const source = join(scratch, "main.swift");
  writeFileSync(
    source,
    `import Foundation
ServiceBundle.resolve(in: Bundle(path: CommandLine.arguments[1])!, environment: [:]) { result in
    switch result {
    case .success(let value): print(value.node); print(value.ffmpegDirectory?.path ?? "missing"); exit(0)
    case .failure(let error): print(error.localizedDescription); exit(2)
    }
}
RunLoop.main.run(until: Date().addingTimeInterval(15))
exit(3)
`,
  );
  probe = join(scratch, "resolve-runtime");
  execFileSync(
    "swiftc",
    [
      ...mediaLinkArguments(),
      join(root, "apps/macos/Sources/Yap/ServiceBundle.swift"),
      join(root, "apps/macos/Sources/Yap/NodeRuntime.swift"),
      source,
      "-o",
      probe,
    ],
    { timeout: 60_000, stdio: "pipe" },
  );
});
after(() => rmSync(scratch, { recursive: true, force: true }));

test("a relocated app resolves its bundled Node without the builder's path or shell environment", () => {
  const app = join(scratch, "Built.app");
  const service = join(app, "Contents/Resources/service");
  const node = join(app, "Contents/Resources/node/bin/node");
  mkdirSync(service, { recursive: true });
  mkdirSync(join(app, "Contents/Resources/node/bin"), { recursive: true });
  mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
  writeFileSync(
    join(app, "Contents/Info.plist"),
    `<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>test.yap.runtime</string>
<key>CFBundleExecutable</key><string>Yap</string>
<key>CFBundlePackageType</key><string>APPL</string></dict></plist>`,
  );
  copyFileSync("/usr/bin/true", join(app, "Contents/MacOS/Yap"));
  writeFileSync(join(service, "main.mjs"), "");
  writeFileSync(
    join(service, "runtime.json"),
    JSON.stringify({
      nodePath: "../node/bin/node",
      ffmpegDirectory: "../ffmpeg",
      ffmpegReceiptSha256: "a".repeat(64),
      controlFrameBytes: 65536,
      maxPendingCalls: 32,
      callTimeoutMs: 10000,
    }),
  );
  symlinkSync(process.execPath, node);
  const moved = join(scratch, "Moved App.app");
  renameSync(app, moved);
  const answer = spawnSync(probe, [moved], {
    cwd: "/",
    env: { PATH: "/usr/bin:/bin" },
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(answer.status, 0, answer.stderr + answer.stdout);
  assert.deepEqual(answer.stdout.trim().split("\n"), [
    join(moved, "Contents/Resources/node/bin/node"),
    join(moved, "Contents/Resources/ffmpeg"),
  ]);
});
