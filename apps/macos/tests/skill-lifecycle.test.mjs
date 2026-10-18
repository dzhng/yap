import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, before, test } from "node:test";
import { compileHomeDriver, makeResources, runHome } from "./fixtures/home-lifecycle.mjs";

let scratch;
let driver;

before(() => {
  scratch = mkdtempSync(join(tmpdir(), "yap-skill-lifecycle-"));
  driver = compileHomeDriver(scratch);
});
after(() => rmSync(scratch, { recursive: true, force: true }));

test("skill status discovers every global harness destination", () => {
  const root = join(scratch, "status");
  const home = join(root, "home");
  mkdirSync(join(home, ".agents/skills/yap"), { recursive: true });
  writeFileSync(join(home, ".agents/skills/yap/SKILL.md"), "skill\n");
  mkdirSync(join(home, ".claude/skills"), { recursive: true });
  symlinkSync("../../.agents/skills/yap", join(home, ".claude/skills/yap"));
  const resources = makeResources(root);
  const [status] = runHome(driver, { home, resources }, "skill.status");
  assert.equal(status.state, "unavailable");
  assert.equal(status.installation, "unmanaged");
  assert.deepEqual(status.paths, [
    join(home, ".agents/skills/yap"),
    join(home, ".claude/skills/yap"),
  ]);
  assert.ok(status.destinations.every((destination) => destination.exists));
});

test("installs with no npx on PATH", () => {
  const root = join(scratch, "install");
  const home = join(root, "home");
  // An older copy is replaced by the bundled one.
  mkdirSync(join(home, ".agents/skills/yap"), { recursive: true });
  writeFileSync(join(home, ".agents/skills/yap/SKILL.md"), "old skill\n");
  const poison = join(root, "poison");
  mkdirSync(poison, { recursive: true });
  writeFileSync(join(poison, "npx"), `#!/bin/sh\ntouch "$HOME/npx-ran"\nexit 1\n`);
  chmodSync(join(poison, "npx"), 0o755);
  const resources = makeResources(root);
  const [started, settled] = runHome(
    driver,
    { home, resources, env: { PATH: `${poison}:/usr/bin:/bin` } },
    "skill.install",
    "wait",
  );
  assert.equal(started.state, "running");
  assert.equal(settled.state, "ready", JSON.stringify(settled));
  assert.equal(settled.installation, "installed");
  assert.equal(settled.managed, true);
  assert.equal(existsSync(join(home, "npx-ran")), false, "no host npx runs");
  assert.equal(readFileSync(join(home, ".agents/skills/yap/SKILL.md"), "utf8"), "bundled skill\n");
  assert.equal(readFileSync(join(home, ".claude/skills/yap/SKILL.md"), "utf8"), "bundled skill\n");
  const add = readFileSync(join(home, "installer-calls"), "utf8")
    .split("\n")
    .find((line) => line.includes(" add "));
  assert.equal(
    add,
    `${join(resources, "skills-installer/cli.mjs")}|${join(resources, "skills-installer/cli.mjs")} add ${join(resources, "skill")} --all --global --yes|1`,
  );
});
