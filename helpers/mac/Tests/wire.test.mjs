import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { retryable } from "./refusal.mjs";

const executable =
  process.env.YAP_NATIVE ?? fileURLToPath(new URL("../.build/debug/yap-native", import.meta.url));
const fixtures = JSON.parse(
  readFileSync(
    new URL("../../../packages/protocol/fixtures/native-requests.json", import.meta.url),
    "utf8",
  ),
);

test("the native process answers every shared conformance line in order", () => {
  const result = spawnSync(executable, [], {
    input: fixtures.map((fixture) => fixture.line).join("\n") + "\n",
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const responses = result.stdout.trim().split("\n").map(JSON.parse);
  assert.equal(responses.length, fixtures.length);
  for (const [index, fixture] of fixtures.entries()) {
    const response = responses[index];
    assert.equal(response.id, fixture.expected.id, fixture.name);
    assert.equal(response.ok, fixture.expected.ok, fixture.name);
    if (fixture.expected.ok) {
      assert.deepEqual(response.data, fixture.expected.data, fixture.name);
      continue;
    }
    assert.equal(response.error.code, fixture.expected.code, fixture.name);
    assert.equal(
      retryable(response.error),
      fixture.expected.code === "MODEL_UNAVAILABLE",
      fixture.name,
    );
    assert.equal(typeof response.error.message, "string", fixture.name);
    assert.deepEqual(response.error.details, {}, fixture.name);
  }
});

test("capability queries reject parameters they do not read", () => {
  const operations = ["media.audioCapabilities", "media.outputCapabilities"];
  const result = spawnSync(executable, [], {
    input:
      operations
        .map((operation) =>
          JSON.stringify({ id: operation, operation, params: { unexpected: true } }),
        )
        .join("\n") + "\n",
    encoding: "utf8",
    timeout: 5000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const responses = result.stdout.trim().split("\n").map(JSON.parse);
  assert.equal(responses.length, operations.length);
  for (const [index, response] of responses.entries()) {
    assert.equal(response.id, operations[index]);
    assert.equal(response.ok, false, JSON.stringify(response));
    assert.equal(response.error.code, "INVALID_REQUEST");
    assert.equal(retryable(response.error), false);
  }
});

test("a changed directory identity reports the same final failure through every operation family", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "wire-identity-")));
  const directory = openSync(home, "r");
  try {
    const stale = { dev: "1", ino: "1" };
    const run = (operation, params) => {
      const result = spawnSync(executable, [], {
        input: JSON.stringify({ id: operation, operation, params }) + "\n",
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe", directory],
        timeout: 5000,
      });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout).error;
    };
    const failures = [
      run("storage.removeRecordingDirectory", {
        home,
        expectedHome: stale,
        recordingId: "00000000-0000-4000-8000-000000000000",
      }),
      run("archive.cleanup", { identity: stale }),
      run("packageWorkspace.remove", {
        parent: stale,
        name: "00000000-0000-4000-8000-000000000000",
        identity: stale,
      }),
    ];
    for (const failure of failures) {
      assert.equal(failure.code, "INVALID_STORAGE");
      assert.equal(retryable(failure), true, JSON.stringify(failure));
    }
  } finally {
    closeSync(directory);
    rmSync(home, { recursive: true, force: true });
  }
});

test("retired recording render operations refuse without opening media", () => {
  const operations = ["media.frame", "media.visualSamples", "media.audio", "media.renderMovie"];
  const result = spawnSync(executable, [], {
    input:
      operations
        .map((operation) => JSON.stringify({ id: operation, operation, params: {} }))
        .join("\n") + "\n",
    encoding: "utf8",
    timeout: 5000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const responses = result.stdout.trim().split("\n").map(JSON.parse);
  assert.equal(responses.length, operations.length);
  for (const [index, response] of responses.entries()) {
    assert.equal(response.id, operations[index]);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, "UNKNOWN_OPERATION");
    assert.equal(retryable(response.error), false);
  }
});
