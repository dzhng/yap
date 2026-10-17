import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// The checkout's built framework, as the build and the Sparkle boundary test select it.
const framework =
  process.env.YAP_SPARKLE_FRAMEWORK ||
  fileURLToPath(new URL("../dist/sparkle/Sparkle.framework", import.meta.url));

test("changed bundles share a scratch certificate requirement while other keys and tampering fail", () => {
  const work = mkdtempSync(join(tmpdir(), "yap-signing-test-"));
  let passed = false;
  try {
    const output = join(work, "receipt.json");
    execFileSync(
      process.execPath,
      ["scripts/signing-lab.mjs", "--framework", framework, "--output", output],
      { timeout: 120_000 },
    );
    const receipt = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(receipt.b.requirement, receipt.c.requirement);
    assert.notEqual(receipt.b.executableSha256, receipt.c.executableSha256);
    assert.match(receipt.b.requirement, /certificate leaf = H"[a-f0-9]{40}"/);
    assert.equal(receipt.c.matchesBRequirement.status, 0);
    assert.notEqual(receipt.other.matchesBRequirement.status, 0);
    assert.match(
      receipt.other.matchesBRequirement.stderr,
      /failed to satisfy specified code requirement/,
    );
    assert.notEqual(receipt.b.matchesARequirement.status, 0);
    assert.match(
      receipt.b.matchesARequirement.stderr,
      /failed to satisfy specified code requirement/,
    );
    assert.equal(receipt.c.restoredFromEncryptedPKCS12, true);
    assert.ok(
      receipt.c.nestedSignatures.find((code) => code.path === "Contents/Resources/node/bin/node"),
    );
    assert.ok(receipt.c.nestedSignatures.find((code) => code.path.endsWith("/Autoupdate")));
    for (const code of receipt.c.nestedSignatures)
      assert.ok(
        code.requirement.includes(`certificate leaf = H"${receipt.certificate.sha1}"`),
        code.path,
      );
    assert.notEqual(receipt.tampered.verify.status, 0);
    assert.equal(receipt.c.verify.status, 0);
    assert.equal(receipt.relocated.verify.status, 0);
    assert.equal(receipt.relocated.nodeVersion, receipt.inputs.nodeVersion);
    assert.equal(receipt.relocated.runtime.frameworkVersion, receipt.inputs.frameworkVersion);
    assert.equal(receipt.cleanup.searchListRestored, true);
    assert.equal(receipt.cleanup.keychainDeleted, true);
    assert.equal(receipt.cleanup.privateMaterialDeleted, true);
    const retained = join(tmpdir(), `yap-signing-public-${process.pid}.json`);
    copyFileSync(output, retained);
    console.log(`Public signing receipt retained at ${retained}`);
    passed = true;
  } finally {
    if (passed) rmSync(work, { recursive: true, force: true });
    else console.error(`Unverified public signing diagnostics retained at ${work}`);
  }
});

test("interruption removes scratch keys and reaps the owned signing child", async () => {
  const { spawn } = await import("node:child_process");
  const { existsSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { setTimeout: delay } = await import("node:timers/promises");
  const work = mkdtempSync(join(tmpdir(), "yap-signing-interrupt-"));
  const marker = join(work, "child.pid");
  const output = join(work, "receipt.json");
  mkdirSync(join(work, "bin"));
  writeFileSync(
    join(work, "bin/codesign"),
    `#!/bin/sh\nprintf '%s' "$$" > "$YAP_SIGNING_CHILD_MARKER"\nexec /bin/sleep 60\n`,
    { mode: 0o755 },
  );
  const child = spawn(
    process.execPath,
    ["scripts/signing-lab.mjs", "--framework", framework, "--output", output],
    {
      stdio: "ignore",
      env: {
        ...process.env,
        PATH: `${join(work, "bin")}:${process.env.PATH}`,
        YAP_SIGNING_CHILD_MARKER: marker,
      },
    },
  );
  const closed = new Promise((resolve) =>
    child.on("close", (code, signal) => resolve({ code, signal })),
  );
  let signingPid;
  let cleanupTimer;
  try {
    const deadline = Date.now() + 10_000;
    while (!existsSync(marker) && Date.now() < deadline) await delay(20);
    assert.ok(existsSync(marker), "signing reached the held external command");
    signingPid = Number(readFileSync(marker, "utf8"));
    child.kill("SIGTERM");
    const result = await Promise.race([
      closed,
      new Promise((_, reject) => {
        cleanupTimer = setTimeout(
          () => reject(new Error("interrupted lab did not finish cleanup")),
          5000,
        );
      }),
    ]);
    clearTimeout(cleanupTimer);
    assert.notEqual(result.code, 0);
    const receipt = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(receipt.cleanup.privateMaterialDeleted, true);
    assert.equal(receipt.cleanup.keychainDeleted, true);
    assert.equal(receipt.cleanup.searchListRestored, true);
    assert.throws(() => process.kill(signingPid, 0), { code: "ESRCH" });
  } finally {
    clearTimeout(cleanupTimer);
    child.kill("SIGTERM");
    const emergency = setTimeout(() => child.kill("SIGKILL"), 5000);
    await closed;
    clearTimeout(emergency);
    if (signingPid) {
      try {
        process.kill(signingPid, "SIGKILL");
      } catch {}
    }
    rmSync(work, { recursive: true, force: true });
  }
});
