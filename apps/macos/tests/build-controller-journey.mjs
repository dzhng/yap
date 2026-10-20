import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = resolve(process.argv[2]);
mkdirSync(output, { recursive: true });
const files = (directory) =>
  readdirSync(directory)
    .filter((name) => name.endsWith(".swift"))
    .sort()
    .map((name) => join(directory, name));
const pins = {};
const commands = [];
function compile(args, sources) {
  for (const path of sources)
    pins[path.slice(root.length)] = {
      sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
      bytes: readFileSync(path).length,
    };
  const command = ["-swift-version", "6", "-package-name", "YapNative", ...args, ...sources];
  commands.push(command);
  execFileSync("swiftc", command, { stdio: "inherit", timeout: 120000 });
}
// The controller also imports YapControls (its window list goes through WindowSource), which
// lives with the app rather than the native helpers.
const moduleSources = {
  YapProtocol: join(root, "helpers/mac/Sources/YapProtocol"),
  YapMedia: join(root, "helpers/mac/Sources/YapMedia"),
  YapCapture: join(root, "helpers/mac/Sources/YapCapture"),
  YapControls: join(root, "apps/macos/Sources/YapControls"),
};
for (const name of Object.keys(moduleSources)) {
  compile(
    [
      "-emit-library",
      "-emit-module",
      "-module-name",
      name,
      "-emit-module-path",
      join(output, `${name}.swiftmodule`),
      "-I",
      output,
      "-L",
      output,
      ...(name === "YapCapture"
        ? ["-lYapMedia", "-lYapProtocol"]
        : name === "YapControls"
          ? ["-lYapProtocol"]
          : []),
      "-o",
      join(output, `lib${name}.dylib`),
    ],
    files(moduleSources[name]),
  );
}
const app = join(root, "apps/macos/Sources/Yap");
const nativeTests = join(root, "helpers/mac/Tests/YapCaptureTests");
const executable = join(output, "controller-journey");
compile(
  [
    "-I",
    output,
    "-L",
    output,
    "-lYapCapture",
    "-lYapMedia",
    "-lYapProtocol",
    "-lYapControls",
    "-Xlinker",
    "-rpath",
    "-Xlinker",
    output,
    "-o",
    executable,
  ],
  [
    ...[
      "CaptureController.swift",
      "ServiceHost.swift",
      "ServiceBundle.swift",
      "NodeRuntime.swift",
      "CaptureFixture.swift",
    ].map((name) => join(app, name)),
    ...[
      "PrerecordedCaptureInput.swift",
      "RecoveryFixtures.swift",
      "FixtureCameraSession.swift",
    ].map((name) => join(nativeTests, name)),
    process.argv[3]
      ? resolve(process.argv[3])
      : join(root, "apps/macos/tests/ControllerJourney/Main.swift"),
  ],
);
const binaries = Object.fromEntries(
  [
    "controller-journey",
    "libYapProtocol.dylib",
    "libYapMedia.dylib",
    "libYapCapture.dylib",
    "libYapControls.dylib",
  ].map((name) => {
    const bytes = readFileSync(join(output, name));
    return [
      name,
      { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
    ];
  }),
);
writeFileSync(
  join(output, "identities.json"),
  JSON.stringify({ sourcePins: pins, binaries, commands }, null, 2),
);
console.log(executable);
