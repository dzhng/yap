import { createHash, generateKeyPairSync } from "node:crypto";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
const script = fileURLToPath(new URL("release.mjs", import.meta.url));

function fixture() {
  const scratch = mkdtempSync(join(tmpdir(), "yap-release-inputs-"));
  for (const folder of [
    "scripts",
    "apps/macos",
    "helpers/denoise",
    "dist/release-inputs",
    "scripts/sparkle",
    "scripts/launcher",
    "packages/protocol/src",
    "packages/core/dist",
  ])
    mkdirSync(join(scratch, folder), { recursive: true });
  copyFileSync(script, join(scratch, "scripts/release.mjs"));
  for (const file of [
    "release-signing.mjs",
    "release-info.mjs",
    "ledger-verdicts.mjs",
    "sparkle/framework.mjs",
    "launcher/verdicts.mjs",
    "launcher/main.c",
  ])
    copyFileSync(new URL(file, import.meta.url), join(scratch, "scripts", file));
  copyFileSync(
    new URL("../packages/protocol/src/refusal-ledger.json", import.meta.url),
    join(scratch, "packages/protocol/src/refusal-ledger.json"),
  );
  writeFileSync(join(scratch, ".node-version"), "24.0.0\n");
  writeFileSync(join(scratch, "apps/macos/package.json"), JSON.stringify({ version: "0.0.0" }));
  writeFileSync(
    join(scratch, "scripts/release-inputs.json"),
    JSON.stringify({ node: { sha256: "0".repeat(64) } }),
  );
  writeFileSync(
    join(scratch, "helpers/denoise/provenance.json"),
    JSON.stringify({ modelArchiveSha256: "1".repeat(64) }),
  );
  return scratch;
}

test("a release tag cannot label a different app version", () => {
  const scratch = fixture();
  try {
    const answer = spawnSync(
      process.execPath,
      [join(scratch, "scripts/release.mjs"), "validate", "v999.0.0"],
      { encoding: "utf8" },
    );
    assert.equal(answer.status, 1);
    assert.match(answer.stderr, /does not match app version v0\.0\.0/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("preparation refuses a corrupt cached runtime before downloading or staging models", () => {
  const scratch = fixture();
  try {
    writeFileSync(
      join(scratch, "dist/release-inputs/node-v24.0.0-darwin-arm64.tar.gz"),
      "corrupt node",
    );
    writeFileSync(
      join(scratch, `dist/release-inputs/rnnoise_data-${"1".repeat(64)}.tar.gz`),
      "corrupt model",
    );
    const answer = spawnSync(process.execPath, [join(scratch, "scripts/release.mjs"), "prepare"], {
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(answer.status, 1, answer.stdout + answer.stderr);
    assert.match(answer.stderr, /Checksum mismatch:.*node-v24\.0\.0-darwin-arm64\.tar\.gz/);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("release packaging refuses missing durable signing inputs before touching artifacts", () => {
  const scratch = fixture();
  try {
    const env = { ...process.env };
    for (const name of Object.keys(env))
      if (name.startsWith("YAP_RELEASE_") || name.startsWith("YAP_SPARKLE_")) delete env[name];
    const answer = spawnSync(
      process.execPath,
      [join(scratch, "scripts/release.mjs"), "package", "v0.0.0"],
      {
        env,
        encoding: "utf8",
        timeout: 5000,
      },
    );
    assert.equal(answer.status, 1, answer.stdout + answer.stderr);
    assert.match(answer.stderr, /Missing release signing inputs/);
    assert.equal(answer.stdout, "");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("packaging rejects omitted or stale built catalog metadata before signing an archive", () => {
  const scratch = fixture();
  try {
    const invoke = (command, args) => {
      const r = spawnSync(command, args, { cwd: scratch, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    const bytes = Buffer.from("verified runtime fixture");
    writeFileSync(join(scratch, "dist/release-inputs/node-v24.0.0-darwin-arm64.tar.gz"), bytes);
    writeFileSync(
      join(scratch, "scripts/release-inputs.json"),
      JSON.stringify({ node: { sha256: createHash("sha256").update(bytes).digest("hex") } }),
    );
    writeFileSync(
      join(scratch, "packages/core/dist/catalog.js"),
      "export const catalogFormat=23;\nexport const minimumSupportedCatalogFormat=23;\n",
    );
    writeFileSync(join(scratch, "package.json"), '{"type":"module"}');
    const service = join(scratch, "dist/Yap.app/Contents/Resources/service");
    mkdirSync(service, { recursive: true });
    const plist = join(scratch, "dist/Yap.app/Contents/Info.plist");
    writeFileSync(
      plist,
      '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>0.0.0</string><key>LSMinimumSystemVersion</key><string>26.0</string></dict></plist>',
    );
    writeFileSync(join(scratch, ".gitignore"), "dist/\n");
    invoke("git", ["init", "-q"]);
    invoke("git", ["add", "."]);
    invoke("git", [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ]);
    const revision = invoke("git", ["rev-parse", "HEAD"]);
    const keys = generateKeyPairSync("ed25519");
    const env = {
      ...process.env,
      YAP_RELEASE_IDENTITY_P12: Buffer.from("fixture-p12-not-imported").toString("base64"),
      YAP_RELEASE_IDENTITY_PASSWORD: "fixture-not-imported",
      YAP_RELEASE_IDENTITY_SHA1: "a".repeat(40),
      YAP_RELEASE_CERTIFICATE_SHA256: "b".repeat(64),
      YAP_SPARKLE_PRIVATE_KEY: keys.privateKey
        .export({ format: "der", type: "pkcs8" })
        .subarray(-32)
        .toString("base64"),
      YAP_SPARKLE_PUBLIC_KEY: keys.publicKey
        .export({ format: "der", type: "spki" })
        .subarray(-32)
        .toString("base64"),
    };
    for (const catalogFormat of [undefined, 24]) {
      writeFileSync(
        join(service, "runtime.json"),
        JSON.stringify({ version: "0.0.0", revision, catalogFormat }),
      );
      const answer = spawnSync(
        process.execPath,
        [join(scratch, "scripts/release.mjs"), "package", "v0.0.0"],
        { env, encoding: "utf8" },
      );
      assert.equal(answer.status, 1, answer.stdout + answer.stderr);
      assert.match(answer.stderr, /Built runtime catalogFormat does not match committed source/);
      assert.equal(answer.stdout, "");
      assert.ok(!answer.stderr.includes(env.YAP_SPARKLE_PRIVATE_KEY));
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
