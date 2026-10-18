import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { compileHomeDriver, makeResources, runHome } from "./fixtures/home-lifecycle.mjs";

const launcher = Buffer.from("#!/bin/sh\n# signed launcher stand-in\nexit 0\n");
let scratch;
let driver;

before(() => {
  scratch = mkdtempSync(join(tmpdir(), "yap-cli-lifecycle-"));
  driver = compileHomeDriver(scratch);
});
after(() => rmSync(scratch, { recursive: true, force: true }));

function setup(name, options) {
  const root = join(scratch, name);
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  return { home, resources: makeResources(root, options), command: join(home, ".local/bin/yap") };
}

test("install writes fresh bytes without quarantine", () => {
  const paths = setup("fresh", { launcher });
  // The bundled launcher of a downloaded app carries quarantine; the installed command must not.
  execFileSync("xattr", [
    "-w",
    "com.apple.quarantine",
    "0081;00000000;Safari;",
    join(paths.resources, "bin/yap"),
  ]);
  const [before, installed] = runHome(driver, paths, "cli.status", "cli.install");
  assert.deepEqual(before, {
    onPath: false,
    path: paths.command,
    state: "unavailable",
    installation: "missing",
    jobId: null,
  });
  assert.equal(installed.state, "ready");
  assert.equal(installed.installation, "installed");
  assert.deepEqual(readFileSync(paths.command), launcher);
  assert.equal(statSync(paths.command).mode & 0o777, 0o755);
  // macOS may attach com.apple.provenance to any file a process writes; only quarantine blocks.
  assert.doesNotMatch(
    execFileSync("xattr", [paths.command], { encoding: "utf8" }),
    /com\.apple\.quarantine/,
  );
  assert.deepEqual(readdirSync(join(paths.home, ".local/bin")), ["yap"]);
});

test("install replaces a different file", () => {
  const paths = setup("different", { launcher });
  mkdirSync(join(paths.home, ".local/bin"), { recursive: true });
  writeFileSync(paths.command, "#!/bin/sh\necho personal\n", { mode: 0o644 });
  writeFileSync(join(paths.home, ".zshenv"), 'export PATH="$HOME/.local/bin:$PATH"\n');
  const [before, installed] = runHome(driver, paths, "cli.status", "cli.install");
  assert.equal(before.installation, "different");
  assert.equal(before.state, "unavailable");
  assert.equal(installed.state, "ready");
  assert.equal(installed.installation, "installed");
  assert.deepEqual(readFileSync(paths.command), launcher);
  assert.equal(statSync(paths.command).mode & 0o777, 0o755);
  // Already covered by the person's own startup file, so no profile is edited.
  assert.equal(existsSync(join(paths.home, ".zprofile")), false);
  assert.equal(
    readFileSync(join(paths.home, ".zshenv"), "utf8"),
    'export PATH="$HOME/.local/bin:$PATH"\n',
  );
});

test("uninstall keeps a modified command", () => {
  const paths = setup("modified", { launcher });
  const profile = join(paths.home, ".zprofile");
  writeFileSync(profile, "export EDITOR=vim\n");
  const [installed, removed] = runHome(driver, paths, "cli.install", "cli.uninstall");
  assert.equal(installed.profile, profile);
  assert.equal(removed.state, "unavailable");
  assert.equal(removed.installation, "missing");
  assert.equal(existsSync(paths.command), false, "an identical command is removed");
  assert.equal(
    readFileSync(profile, "utf8"),
    "export EDITOR=vim\n",
    "only the marked block is removed",
  );

  runHome(driver, paths, "cli.install");
  writeFileSync(paths.command, "#!/bin/sh\necho edited\n");
  const [kept] = runHome(driver, paths, "cli.uninstall");
  assert.equal(kept.installation, "different");
  assert.equal(kept.state, "unavailable");
  assert.equal(readFileSync(paths.command, "utf8"), "#!/bin/sh\necho edited\n");
});

test("status is unavailable without a bundled launcher", () => {
  const paths = setup("unavailable");
  mkdirSync(join(paths.home, ".local/bin"), { recursive: true });
  writeFileSync(paths.command, "#!/bin/sh\necho personal build\n");
  const answers = runHome(driver, paths, "cli.status", "cli.install", "cli.uninstall");
  for (const answer of answers) assert.equal(answer.state, "unavailable");
  assert.equal(readFileSync(paths.command, "utf8"), "#!/bin/sh\necho personal build\n");
  assert.equal(existsSync(join(paths.home, ".zprofile")), false);
});

test("bash with only ~/.profile gets the block there, and ~/.profile keeps loading", () => {
  const paths = setup("bash-profile", { launcher });
  writeFileSync(join(paths.home, ".profile"), "export EDITOR=vim\n");
  const [installed] = runHome(driver, { ...paths, env: { SHELL: "/bin/bash" } }, "cli.install");
  assert.equal(installed.state, "ready");
  assert.equal(installed.installation, "installed");
  assert.equal(
    existsSync(join(paths.home, ".bash_profile")),
    false,
    "no .bash_profile shadows .profile",
  );
  assert.match(
    readFileSync(join(paths.home, ".profile"), "utf8"),
    /^export EDITOR=vim\n# >>> yap >>>/,
  );
});

test("an unreadable profile is never rewritten", () => {
  const paths = setup("unreadable", { launcher });
  const latin1 = Buffer.from([
    0x65, 0x78, 0x70, 0x6f, 0x72, 0x74, 0x20, 0x4e, 0x41, 0x4d, 0x45, 0x3d, 0xe9, 0x0a,
  ]);
  writeFileSync(join(paths.home, ".zprofile"), latin1);
  const [installed] = runHome(driver, paths, "cli.install");
  assert.equal(installed.state, "failed");
  assert.equal(installed.installation, "needs_attention");
  assert.deepEqual(readFileSync(join(paths.home, ".zprofile")), latin1);
});

test("a shell Yap can't configure gets no profile edit and reports not on PATH", () => {
  const paths = setup("fish", { launcher });
  const [installed] = runHome(
    driver,
    { ...paths, env: { SHELL: "/opt/homebrew/bin/fish" } },
    "cli.install",
  );
  assert.equal(installed.state, "ready");
  assert.equal(installed.installation, "installed");
  assert.equal(installed.onPath, false);
  assert.deepEqual(readdirSync(paths.home).sort(), [".local"]);
});
