import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The checkout's built framework, as the build and the Sparkle boundary test select it.
const framework =
  process.env.YAP_SPARKLE_FRAMEWORK ||
  fileURLToPath(new URL("../dist/sparkle/Sparkle.framework", import.meta.url));

function runScenario(scenario) {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/update-lab.mjs",
      scenario,
      "--framework",
      framework,
      "--host-controlled-installation",
      "--retain-public-fixtures",
    ],
    { encoding: "utf8", timeout: 115_000 },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  process.stderr.write(`update-guard: ${scenario}: ${report.evidence}/report.json\n`);
  return report;
}

test("a staged update preserves the busy app on ordinary quit", { timeout: 120_000 }, () => {
  const report = runScenario("busy-quit");
  assert.equal(report.installedVersion, "0.1.0", JSON.stringify(report));
  assert.equal(report.events.find((event) => event.event === "terminate").busy, true);
  assert.ok(!report.events.some((event) => event.event === "installing"));
});

test("a delayed callback keeps exclusion after the installer crashes", { timeout: 120_000 }, () => {
  const report = runScenario("stalled-helper-crash");
  assert.equal(report.installedVersion, "0.1.0", JSON.stringify(report));
  assert.ok(report.events.some((event) => event.event === "stalled"));
  assert.ok(report.events.some((event) => event.event === "cycle"));
  assert.equal(
    report.events.find((event) => event.event === "installProgress").replacementExcluded,
    true,
    JSON.stringify(report),
  );
});

test(
  "channel loss after final authorization cannot strand exclusion after timeout",
  { timeout: 120_000 },
  () => {
    const report = runScenario("authorized-channel-loss");
    assert.equal(report.installedVersion, "0.1.0", JSON.stringify(report));
    assert.ok(report.events.some((event) => event.event === "channelInvalidated"));
    assert.ok(report.events.some((event) => event.event === "cycle" && event.error));
    assert.equal(
      report.events.find((event) => event.event === "lockProbe").replacementExcluded,
      false,
      JSON.stringify(report),
    );
  },
);

test(
  "a crash after exclusion but before final permission preserves the installed app",
  { timeout: 120_000 },
  () => {
    const report = runScenario("unconfirmed-crash");
    assert.equal(report.installedVersion, "0.1.0", JSON.stringify(report));
    assert.ok(report.events.some((event) => event.event === "installProgress"));
    assert.ok(!report.events.some((event) => event.event === "authorizeFinal"));
  },
);

test("an idle host authorizes replacement before its quiet relaunch", { timeout: 120_000 }, () => {
  const report = runScenario("install");
  assert.equal(report.installedVersion, "0.1.1", JSON.stringify(report));
  const terminated = report.events.find((event) => event.event === "terminate");
  assert.equal(terminated.busy, false);
  const launch = report.events.find(
    (event) => event.event === "launch" && event.version === "0.1.1",
  );
  assert.ok(launch.arguments.includes("--yap-update-relaunch"));
  assert.deepEqual(launch.executionContext, report.inputs.executionContext, JSON.stringify(report));
});

test(
  "cancelling after acquisition releases exclusion before completing the cycle",
  { timeout: 120_000 },
  () => {
    const report = runScenario("cancel-install");
    assert.equal(report.installedVersion, "0.1.0", JSON.stringify(report));
    assert.equal(
      report.events.find((event) => event.event === "installProgress").replacementExcluded,
      true,
    );
    const cycle = report.events.find((event) => event.event === "cycle");
    assert.equal(cycle.error, "");
    assert.equal(cycle.replacementExcluded, false, JSON.stringify(report));
    assert.ok(!report.events.some((event) => event.event === "authorizeFinal"));
  },
);

test(
  "a live MCP client blocks replacement while the host stays usable",
  { timeout: 120_000 },
  () => {
    const report = runScenario("mcp-lock");
    assert.equal(report.installedVersion, "0.1.0", JSON.stringify(report));
    assert.ok(report.inputs.client.tools.includes("service.health"));
    assert.ok(report.events.some((event) => event.event === "cycle" && event.error));
    assert.ok(report.events.some((event) => event.event === "lockProbe"));
    assert.ok(!report.events.some((event) => event.event === "terminate"));
    assert.ok(!report.events.some((event) => event.event === "installProgress"));
  },
);

test(
  "a paused callback keeps exclusion through timeout until revocation drains",
  { timeout: 120_000 },
  () => {
    const report = runScenario("stalled-timeout");
    assert.equal(report.installedVersion, "0.1.0", JSON.stringify(report));
    assert.equal(report.inputs.pausedLockStatus, 75, JSON.stringify(report));
    assert.equal(
      report.events.find((event) => event.event === "installProgress").replacementExcluded,
      true,
    );
    assert.equal(report.events.find((event) => event.event === "cycle").replacementExcluded, false);
    assert.ok(!report.events.some((event) => event.event === "relaunch"));
  },
);

test(
  "public proof inputs can be retained without disposable signing secrets",
  { timeout: 120_000 },
  () => {
    const report = runScenario("stopped-launch");
    const hash = (path) =>
      createHash("sha256")
        .update(readFileSync(join(report.evidence, path)))
        .digest("hex");
    assert.equal(hash("update.zip"), report.inputs.archiveSha256);
    assert.equal(hash("old.zip"), report.inputs.oldArchiveSha256);
    assert.equal(hash("appcast.xml"), report.inputs.appcastSha256);
    assert.equal(existsSync(join(report.evidence, "key")), false);
    assert.equal(existsSync(join(report.evidence, "installed")), false);
  },
);

test("queued Install then Skip cancels without replacing the app", { timeout: 120_000 }, () => {
  const report = runScenario("install-skip");
  assert.equal(report.installedVersion, "0.1.0", JSON.stringify(report));
  assert.equal(report.events.find((event) => event.event === "cycle").replacementExcluded, false);
  assert.ok(!report.events.some((event) => event.event === "relaunch"));
});
