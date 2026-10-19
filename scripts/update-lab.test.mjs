import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, linkSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";

const engineArgs = process.env.YAP_SPARKLE_FRAMEWORK
  ? [
      "--framework",
      process.env.YAP_SPARKLE_FRAMEWORK,
      "--host-controlled-installation",
      "--retain-public-fixtures",
    ]
  : [];

test(
  "an explicit framework input runs its actual bytes and records separate provenance",
  { timeout: 120_000 },
  () => {
    const scratch = mkdtempSync(join(tmpdir(), "yap-framework-input-"));
    try {
      const distribution = join(tmpdir(), "yap-sparkle-2.10.0.tar.xz");
      if (!existsSync(distribution)) {
        const prepared = spawnSync(process.execPath, ["scripts/update-lab.mjs", "stopped-launch"], {
          encoding: "utf8",
          timeout: 115_000,
        });
        assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
      }
      const extracted = spawnSync("tar", ["-xf", distribution, "-C", scratch]);
      assert.equal(extracted.status, 0, String(extracted.stderr));
      const framework = join(scratch, "Sparkle.framework");
      const changed = spawnSync("/usr/libexec/PlistBuddy", [
        "-c",
        "Set :CFBundleShortVersionString fixture-input",
        join(framework, "Resources", "Info.plist"),
      ]);
      assert.equal(changed.status, 0, String(changed.stderr));
      const result = spawnSync(
        process.execPath,
        ["scripts/update-lab.mjs", "stopped-launch", "--framework", framework],
        { encoding: "utf8", timeout: 115_000 },
      );
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.sparkle.engine, "provided-framework");
      assert.match(report.sparkle.frameworkSha256, /^[a-f0-9]{64}$/);
      assert.equal(
        report.events.find((event) => event.event === "launch").frameworkVersion,
        "fixture-input",
      );
      assert.equal(report.archiveRequests, 0);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  },
);

test("a queued relaunch exits on persistent fixture shutdown intent", { timeout: 120_000 }, () => {
  const result = spawnSync(process.execPath, ["scripts/update-lab.mjs", "stopped-launch"], {
    encoding: "utf8",
    timeout: 115_000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.archiveRequests, 0);
  assert.ok(report.events.some((e) => e.event === "stoppedLaunch"));
  assert.ok(!report.events.some((e) => e.event === "candidate"));
});

for (const tool of ["curl", "clang"])
  test(
    `${tool} interruption reaps the setup process and removes partial acquisition`,
    { timeout: 120_000 },
    async () => {
      const scratch = mkdtempSync(join(tmpdir(), "yap-update-download-"));
      const bin = join(scratch, "bin");
      mkdirSync(bin);
      const pidFile = join(scratch, "download-pid");
      if (tool === "clang")
        linkSync(
          join(tmpdir(), "yap-sparkle-2.10.0.tar.xz"),
          join(scratch, "yap-sparkle-2.10.0.tar.xz"),
        );
      writeFileSync(
        join(bin, tool),
        `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(process.argv[process.argv.indexOf('-o')+1],'partial');fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`,
        { mode: 0o755 },
      );
      const child = spawn(process.execPath, ["scripts/update-lab.mjs", "hold"], {
        env: { ...process.env, TMPDIR: scratch, PATH: `${bin}:${process.env.PATH}` },
      });
      let stdout = "";
      child.stdout.on("data", (bytes) => (stdout += bytes));
      let exited = false,
        downloader;
      const completion = new Promise((r) =>
        child.once("close", (code, signal) => {
          exited = true;
          r({ code, signal });
        }),
      );
      try {
        const until = Date.now() + 5000;
        while (!existsSync(pidFile) && !exited && Date.now() < until) await delay(20);
        assert.equal(existsSync(pidFile), true);
        downloader = Number(readFileSync(pidFile, "utf8"));
        const requested = Date.now();
        child.kill("SIGTERM");
        assert.equal((await completion).code, 1);
        assert.ok(
          Date.now() - requested < 5000,
          "interrupt must clean up without waiting for the 20-second command timeout",
        );
        const failure = JSON.parse(stdout);
        assert.equal(
          failure.source.runnerSha256,
          createHash("sha256").update(readFileSync("scripts/update-lab.mjs")).digest("hex"),
        );
        assert.ok(failure.inputs.publicKey);
        assert.throws(() => process.kill(downloader, 0), { code: "ESRCH" });
        assert.deepEqual(
          readdirSync(scratch).filter(
            (p) =>
              p.startsWith("yap-sparkle") && (tool === "curl" || p.endsWith(".tar.xz") === false),
          ),
          [],
        );
      } finally {
        if (!exited) {
          child.kill("SIGTERM");
          await completion;
        }
        if (downloader)
          try {
            process.kill(downloader, "SIGKILL");
          } catch {}
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  );

test(
  "interrupting a staged probe cleans its child and signing inputs",
  { timeout: 120_000 },
  async () => {
    const child = spawn(process.execPath, ["scripts/update-lab.mjs", "hold"]);
    let stdout = "",
      stderr = "",
      exited = false;
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    const completion = new Promise((r) =>
      child.once("exit", (code) => {
        exited = true;
        r(code);
      }),
    );
    try {
      const until = Date.now() + 30_000;
      let ready = false;
      while (Date.now() < until && !exited) {
        const root = /update-lab: (.+)/.exec(stderr)?.[1];
        if (
          root &&
          existsSync(join(root, "events.jsonl")) &&
          readFileSync(join(root, "events.jsonl"), "utf8").includes('"event":"ready"')
        ) {
          ready = true;
          break;
        }
        await delay(50);
      }
      assert.equal(ready, true, stderr);
      child.kill("SIGTERM");
      assert.equal(await completion, 1);
      const report = JSON.parse(stdout);
      assert.match(report.error, /interrupted/);
      assert.equal(
        report.inputs.appcastSha256,
        createHash("sha256")
          .update(readFileSync(join(report.evidence, "appcast.xml")))
          .digest("hex"),
      );
      assert.ok(report.inputs.archiveSha256);
      assert.ok(report.inputs.publicKey);
      for (const path of ["key", "installed", "sparkle"])
        assert.equal(existsSync(join(report.evidence, path)), false);
    } finally {
      if (!exited) {
        child.kill("SIGTERM");
        await completion;
      }
    }
  },
);

test(
  "a failed listener cleans up disposable signing and executable inputs",
  { timeout: 120_000 },
  async () => {
    const occupied = createServer();
    await new Promise((r) => occupied.listen(0, "127.0.0.1", r));
    try {
      const child = spawn(process.execPath, [
        "scripts/update-lab.mjs",
        "install",
        String(occupied.address().port),
      ]);
      let stdout = "";
      child.stdout.on("data", (b) => (stdout += b));
      assert.equal(await new Promise((r) => child.on("exit", r)), 1);
      const report = JSON.parse(stdout);
      assert.match(report.error, /EADDRINUSE/);
      for (const path of ["key", "sparkle", "installed"])
        assert.equal(existsSync(join(report.evidence, path)), false);
    } finally {
      await new Promise((r) => occupied.close(r));
    }
  },
);

test("a crashed native fixture is reaped and its inputs are cleaned", { timeout: 120_000 }, () => {
  const result = spawnSync(process.execPath, ["scripts/update-lab.mjs", "crash"], {
    encoding: "utf8",
    timeout: 115_000,
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.match(report.error, /SIGABRT/);
  for (const path of ["key", "sparkle", "installed"])
    assert.equal(existsSync(join(report.evidence, path)), false);
});

test(
  "a signed incompatible candidate is refused before downloading or replacing the app",
  { timeout: 120_000 },
  () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/update-lab.mjs", "incompatible", ...engineArgs],
      {
        encoding: "utf8",
        timeout: 115_000,
      },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.installedVersion, "0.1.0");
    assert.equal(report.archiveRequests, 0);
    assert.equal(report.events.find((event) => event.event === "candidate").accepted, false);
  },
);

for (const scenario of ["install", "disable-quit", "disable-extract-quit"]) {
  test(`Sparkle ${scenario} obeys installation eligibility`, { timeout: 120_000 }, () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/update-lab.mjs", scenario, ...engineArgs],
      {
        encoding: "utf8",
        timeout: 115_000,
      },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.installedVersion, scenario === "install" ? "0.1.1" : "0.1.0");
    if (scenario === "install") {
      assert.ok(report.events.some((e) => e.event === "ready"));
      assert.ok(report.events.some((e) => e.event === "launch" && e.version === "0.1.1"));
      assert.equal(report.events.find((e) => e.event === "terminate").busy, false);
    }
  });
}

test(
  "the release feed offers each installed app the item for the catalog format it wrote",
  { timeout: 120_000 },
  () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/update-lab.mjs", "format-route", ...engineArgs],
      { encoding: "utf8", timeout: 115_000 },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(
      report.events
        .filter((e) => e.event === "candidate")
        .map(({ candidateVersion, format, accepted }) => ({ candidateVersion, format, accepted })),
      [{ candidateVersion: "0.1.1", format: "23", accepted: true }],
    );
    assert.equal(report.installedVersion, "0.1.1");
  },
);

test(
  "the pinned upstream engine is rejected because busy quit installs without permission",
  { timeout: 120_000 },
  () => {
    const result = spawnSync(process.execPath, ["scripts/update-lab.mjs", "busy-quit"], {
      encoding: "utf8",
      timeout: 115_000,
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.verdict, "rejected");
    assert.equal(report.installedVersion, "0.1.1");
    assert.equal(report.events.find((e) => e.event === "terminate").busy, true);
    assert.ok(!report.events.some((e) => e.event === "installing"));
  },
);

for (const scenario of [
  "unsigned-feed",
  "tampered-feed",
  "missing-format",
  "malformed-format",
  "bad-archive-signature",
  "missing-signature",
  "corrupt-archive",
  "equal",
  "older",
]) {
  test(`Sparkle refuses ${scenario}`, { timeout: 120_000 }, () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/update-lab.mjs", scenario, ...engineArgs],
      {
        encoding: "utf8",
        timeout: 115_000,
      },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.installedVersion, "0.1.0");
    assert.ok(!report.events.some((e) => e.event === "ready"));
    if (["missing-format", "malformed-format"].includes(scenario)) {
      assert.equal(report.events.find((e) => e.event === "candidate").accepted, false);
    }
    if (
      [
        "unsigned-feed",
        "tampered-feed",
        "missing-format",
        "malformed-format",
        "equal",
        "older",
      ].includes(scenario)
    )
      assert.equal(report.archiveRequests, 0);
    else assert.equal(report.archiveRequests, 1);
  });
}
