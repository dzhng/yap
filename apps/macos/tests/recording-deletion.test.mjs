import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const execute = promisify(execFile);
const cli = new URL("../../cli/dist/main.js", import.meta.url).pathname;
import { callLocal } from "@yap/client";
import {
  launchReady,
  socketPath,
  temporary,
  waitFor,
  requireScreenPermission,
} from "./harness.mjs";

function sizeTree(path) {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (stat.isFile()) return stat.size;
  return readdirSync(path).reduce((sum, entry) => sum + sizeTree(join(path, entry)), 0);
}
function snapshotFiles(path, out = new Map()) {
  if (!existsSync(path)) return out;
  const stat = statSync(path);
  if (stat.isFile()) {
    out.set(path, stat.size);
    return out;
  }
  for (const entry of readdirSync(path)) snapshotFiles(join(path, entry), out);
  return out;
}

// This gate records only the app-owned fixture window, with both audio roles disabled.
test(
  "public deletion ends the actual native take before removing its directory",
  { timeout: 60_000 },
  async () => {
    requireScreenPermission();
    const home = temporary("/tmp/yap-public-delete-");
    const { instance } = await launchReady(home, { YAP_FIXTURE_WINDOW: "1" });
    const [, windowId] = await instance.waitFor(/capture fixture window=(\d+)/);
    const call = (operation, params = {}) =>
      callLocal(socketPath(home), { id: randomUUID(), operation, params }, { timeoutMs: 30_000 });
    const succeeds = async (operation, params) => {
      const answer = await call(operation, params);
      assert.equal(answer.ok, true, `${operation}: ${JSON.stringify(answer)}`);
      return answer.data;
    };
    const start = () =>
      succeeds("capture.start", {
        requestId: randomUUID(),
        source: { kind: "window", windowId: Number(windowId) },
        microphone: false,
        systemAudio: false,
      });
    const take = await start();
    const directory = join(home, "library", "recordings", take.id);
    await waitFor(() => existsSync(join(directory, "source", "capture.journal.jsonl")), 5_000);
    const cliCall = async (operation, params) => {
      try {
        const command = await execute(
          process.execPath,
          [cli, operation, "--socket", socketPath(home), "--params", JSON.stringify(params)],
          { timeout: 30_000 },
        );
        return JSON.parse(command.stdout);
      } catch (error) {
        if (!error.stdout) throw error;
        return JSON.parse(error.stdout);
      }
    };
    const reference = { recordingId: take.id };
    const before = await cliCall("storage.usage", {});
    assert.equal(before.ok, true, JSON.stringify(before));
    assert.equal(before.data.recordingId, null);
    const identityBefore = await cliCall("recording.get", reference);
    assert.equal(identityBefore.ok, true, JSON.stringify(identityBefore));
    assert.equal(identityBefore.data.recordingId, take.id);
    assert.ok(before.data.totalBytes > 0);
    const directoryBytes = sizeTree(directory);
    const filesBeforeDelete = snapshotFiles(join(home, "library"));
    const cliResult = await cliCall("recording.delete", { ...reference, requestId: randomUUID() });
    assert.equal(cliResult.ok, true);
    const filesAfterDelete = snapshotFiles(join(home, "library"));
    const freedMeasured = [...filesBeforeDelete].reduce(
      (sum, [path, bytes]) => sum + (filesAfterDelete.has(path) ? 0 : bytes),
      0,
    );
    assert.equal(cliResult.data.recordingId, take.id);
    assert.equal(cliResult.data.deleted, true);
    assert.ok(cliResult.data.freedBytes >= directoryBytes);
    assert.ok(freedMeasured <= cliResult.data.freedBytes);
    assert.equal(existsSync(directory), false);
    assert.equal((await cliCall("recording.get", reference)).error.code, "NOT_FOUND");
    assert.equal((await call("recording.get", { recordingId: take.id })).error.code, "NOT_FOUND");
    assert.equal(
      (
        await succeeds("recording.delete", {
          recordingId: take.id,
          requestId: randomUUID(),
        })
      ).deleted,
      true,
    );
    // Native capture capacity and the service's durable capture priority must both be released.
    const replacement = await start();
    assert.notEqual(replacement.recordingId, take.id);
    assert.equal(replacement.state, "recording");
    const client = new Client({ name: "recording-deletion-test", version: "1" });
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [cli, "mcp", "--socket", socketPath(home)],
        }),
      );
      assert.ok((await client.listTools()).tools.some((tool) => tool.name === "recording.delete"));
      const usage = await client.callTool({
        name: "storage.usage",
        arguments: {},
      });
      assert.equal(usage.structuredContent.ok, true, JSON.stringify(usage.structuredContent));
      assert.equal(usage.structuredContent.data.recordingId, null);
      const replacementBefore = await client.callTool({
        name: "recording.get",
        arguments: { recordingId: replacement.recordingId },
      });
      assert.equal(replacementBefore.structuredContent.ok, true);
      assert.equal(replacementBefore.structuredContent.data.recordingId, replacement.recordingId);
      assert.ok(usage.structuredContent.data.totalBytes > 0);
      const replacementDirectory = join(home, "library", "recordings", replacement.recordingId);
      const replacementFreedBytes = sizeTree(replacementDirectory);
      const result = await client.callTool({
        name: "recording.delete",
        arguments: { recordingId: replacement.recordingId, requestId: randomUUID() },
      });
      assert.equal(result.structuredContent.ok, true);
      assert.deepEqual(result.structuredContent.data, {
        id: replacement.recordingId,
        deleted: true,
        freedBytes: replacementFreedBytes,
      });
      const absent = await client.callTool({
        name: "recording.get",
        arguments: { recordingId: replacement.recordingId },
      });
      assert.equal(absent.structuredContent.error.code, "NOT_FOUND");
    } finally {
      await client.close();
    }
    assert.equal(existsSync(join(home, "library", "recordings", replacement.recordingId)), false);
  },
);
