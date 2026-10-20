import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { protocolLinkArguments } from "./swift-protocol.mjs";

const sources = fileURLToPath(new URL("../../Sources/Yap/", import.meta.url));
const homeSources = [
  "AppResources",
  "HomeLifecycle",
  "SkillArtifact",
  "CommandArtifact",
  "ShellProfile",
  "NodeRuntime",
  "ServiceBundle",
].map((name) => join(sources, `${name}.swift`));

/**
 * Links the real home-lifecycle sources with a driver that runs each argument after the first
 * two as one public operation against `HomeLifecycle(home:resources:)` and prints its answer as
 * one JSON line. `wait` polls `skill.status` until the asynchronous skill work settles;
 * `reconcile` runs the launch reconcile with the preference on, then waits the same way.
 */
export function compileHomeDriver(scratch) {
  const driver = join(scratch, "Driver.swift");
  writeFileSync(
    driver,
    String.raw`import Foundation
@MainActor protocol AgentSetup { func setEnabled(_ enabled: Bool); func summary() -> String }
@main struct Driver {
    @MainActor static func main() {
        let arguments = CommandLine.arguments
        let lifecycle = HomeLifecycle(
            home: URL(fileURLWithPath: arguments[1]),
            resources: AppResources(root: URL(fileURLWithPath: arguments[2])),
            inApplications: true)
        func line(_ result: Result<Data, ServiceFailure>) -> String {
            switch result {
            case .success(let data): return String(decoding: data, as: UTF8.self)
            case .failure(let failure): return "{\"failure\":\"\(failure.code)\"}"
            }
        }
        func settle() -> String {
            let deadline = Date().addingTimeInterval(60)
            while true {
                let answer = line(lifecycle.handle("skill.status"))
                if (!answer.contains("\"state\":\"updating\"") && !answer.contains("\"state\":\"running\"")) || Date() > deadline { return answer }
                Thread.sleep(forTimeInterval: 0.1)
            }
        }
        for operation in arguments.dropFirst(3) {
            switch operation {
            case "wait": print(settle())
            case "reconcile":
                lifecycle.setEnabled(true)
                print(settle())
            default: print(line(lifecycle.handle(operation)))
            }
        }
    }
}
`,
  );
  const executable = join(scratch, "driver");
  execFileSync(
    "swiftc",
    [
      "-swift-version",
      "6",
      "-parse-as-library",
      ...protocolLinkArguments(),
      ...homeSources,
      driver,
      "-o",
      executable,
    ],
    { stdio: "pipe", timeout: 180_000 },
  );
  return executable;
}

/** Runs the driver and parses one JSON answer per operation. */
export function runHome(executable, { home, resources, env = {} }, ...operations) {
  const inherited = { ...process.env };
  delete inherited.YAP_NODE;
  const output = execFileSync(executable, [home, resources, ...operations], {
    encoding: "utf8",
    env: { ...inherited, PATH: "/usr/bin:/bin", SHELL: "/bin/zsh", ...env, HOME: home },
    timeout: 120_000,
  });
  return output
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

/**
 * A bundle's Resources directory. The node is a stand-in for the pinned `skills` installer's
 * observable behavior (the third-party edge): `add` places the given skill globally and links a
 * second harness; `ls --global --json` reports what is there. It records how it was invoked.
 * `launcher` is the bundled command's bytes; without it the build carries no launcher.
 */
export function makeResources(root, { launcher } = {}) {
  const resources = join(root, "Resources");
  mkdirSync(join(resources, "node/bin"), { recursive: true });
  mkdirSync(join(resources, "skills-installer"), { recursive: true });
  writeFileSync(join(resources, "skills-installer/cli.mjs"), "// stand-in\n");
  mkdirSync(join(resources, "skill"), { recursive: true });
  writeFileSync(join(resources, "skill/SKILL.md"), "bundled skill\n");
  const node = join(resources, "node/bin/node");
  writeFileSync(
    node,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo v24.0.0; exit 0; fi
printf '%s|%s|%s\\n' "$1" "$*" "$DISABLE_TELEMETRY" >> "$HOME/installer-calls"
case "$2" in
add)
  mkdir -p "$HOME/.agents/skills" "$HOME/.claude/skills"
  rm -rf "$HOME/.agents/skills/yap" "$HOME/.claude/skills/yap"
  cp -R "$3" "$HOME/.agents/skills/yap"
  ln -s ../../.agents/skills/yap "$HOME/.claude/skills/yap"
  ;;
ls)
  if [ -d "$HOME/.agents/skills/yap" ]; then
    printf '[{"name":"yap","path":"%s/.agents/skills/yap","scope":"global","agents":["Codex"]},{"name":"yap","path":"%s/.claude/skills/yap","scope":"global","agents":["Claude Code"]}]' "$HOME" "$HOME"
  else printf '[]'; fi
  ;;
esac
`,
  );
  chmodSync(node, 0o755);
  // Like a release build, the service manifest records the bundled Node.
  mkdirSync(join(resources, "service"), { recursive: true });
  writeFileSync(
    join(resources, "service/runtime.json"),
    JSON.stringify({ nodePath: "../node/bin/node" }),
  );
  if (launcher) {
    mkdirSync(join(resources, "bin"), { recursive: true });
    writeFileSync(join(resources, "bin/yap"), launcher, { mode: 0o755 });
  }
  return resources;
}
