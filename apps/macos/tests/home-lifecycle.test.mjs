import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { compileHomeDriver, makeResources, runHome } from "./fixtures/home-lifecycle.mjs";

const launcher = Buffer.from("#!/bin/sh\n# signed launcher stand-in\nexit 0\n");
const block = '# >>> yap >>>\nexport PATH="$HOME/.local/bin:$PATH"\n# <<< yap <<<\n';
let scratch;
let driver;

before(() => {
  scratch = mkdtempSync(join(tmpdir(), "yap-home-lifecycle-"));
  driver = compileHomeDriver(scratch);
});
after(() => rmSync(scratch, { recursive: true, force: true }));

function setup(name) {
  const root = join(scratch, name);
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  return { home, resources: makeResources(root, { launcher }) };
}

test("routes skill and cli by prefix", () => {
  const paths = setup("routes");
  const [cli, skill, unknown, unknownSkill] = runHome(
    driver,
    paths,
    "cli.status",
    "skill.status",
    "update.status",
    "skill.bogus",
  );
  assert.deepEqual(cli, {
    onPath: false,
    path: join(paths.home, ".local/bin/yap"),
    state: "unavailable",
    installation: "missing",
    jobId: null,
  });
  assert.equal(skill.state, "unavailable");
  assert.equal(skill.installation, "missing");
  assert.deepEqual(skill.paths, []);
  assert.deepEqual(unknown, { failure: "UNKNOWN_OPERATION" });
  assert.deepEqual(unknownSkill, { failure: "UNKNOWN_OPERATION" });
});

test("reconcile installs both when enabled", () => {
  const paths = setup("reconcile");
  const [skill, cli] = runHome(
    driver,
    { ...paths, env: { SHELL: "/bin/bash" } },
    "reconcile",
    "cli.status",
  );
  assert.equal(skill.state, "ready", JSON.stringify(skill));
  assert.equal(skill.installation, "installed");
  assert.equal(
    readFileSync(join(paths.home, ".agents/skills/yap/SKILL.md"), "utf8"),
    "bundled skill\n",
  );
  const profile = join(paths.home, ".bash_profile");
  assert.deepEqual(cli, {
    onPath: true,
    path: join(paths.home, ".local/bin/yap"),
    profile,
    state: "ready",
    installation: "installed",
    jobId: null,
  });
  assert.deepEqual(readFileSync(join(paths.home, ".local/bin/yap")), launcher);
  assert.equal(readFileSync(profile, "utf8"), block);
});
