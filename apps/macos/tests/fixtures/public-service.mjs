import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CaptureStore } from "@yap/core/capture-store";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { callLocal } from "@yap/client";
import { JsonLineStream, CONTROL_FRAME_BYTES } from "../../../../packages/protocol/dist/index.js";
const main = fileURLToPath(new URL("../../../service/dist/main.js", import.meta.url));
const cli = fileURLToPath(new URL("../../../cli/dist/main.js", import.meta.url));
export async function until(read, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await read();
    if (value) return value;
    await delay(20);
  } while (Date.now() < deadline);
  throw new Error(message);
}
export async function startPublicService(
  home,
  native = process.env.YAP_NATIVE ??
    fileURLToPath(new URL("../../../../helpers/mac/.build/debug/yap-native", import.meta.url)),
) {
  const child = spawn(process.execPath, [main], {
    cwd: "/",
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    // Test runners turn off the launch preset refresh: it reaches the network, and close waits
    // for a refresh in flight, so a short check would otherwise depend on network latency.
    env: { YAP_PRESETS_REFRESH: "0", ...process.env, YAP_HOME: home, YAP_NATIVE: native },
  });
  const terminal = new Promise((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  let diagnostics = "",
    socket;
  child.stderr.on("data", (value) => {
    diagnostics = (diagnostics + value).slice(-32000);
  });
  const stream = new JsonLineStream(CONTROL_FRAME_BYTES);
  child.stdout.on("data", (value) => {
    for (const frame of stream.push(value))
      if (frame.ok) {
        if (frame.value.event === "started") socket = frame.value.socketPath;
        else if (frame.value.event === "failed") diagnostics += JSON.stringify(frame.value);
      }
  });
  const group = (signal) => {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      throw error;
    }
  };
  const close = async () => {
    child.stdin.end();
    const timer = setTimeout(() => group("SIGKILL"), 5000);
    const result = await terminal;
    clearTimeout(timer);
    const survived = group(0);
    if (survived) {
      group("SIGKILL");
      await until(() => !group(0), "Owned service group remains live");
    }
    assert.equal(survived, false, "Service left owned native workers");
    assert.equal(result.code, 0, diagnostics);
  };
  try {
    await until(
      () => socket || (child.exitCode !== null && Promise.reject(new Error(diagnostics))),
      "Service did not start",
    );
  } catch (error) {
    group("SIGKILL");
    await terminal;
    throw error;
  }
  return {
    socket,
    close,
    call: async (operation, params = {}) =>
      callLocal(socket, { id: randomUUID(), operation, params }),
  };
}

export function publicCommand(socket, operation, params, extra = []) {
  const result = spawnSync(
    process.execPath,
    [cli, operation, "--socket", socket, "--params", JSON.stringify(params), ...extra],
    { encoding: "utf8", timeout: 15000, maxBuffer: 8 * 1024 ** 2 },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return JSON.parse(result.stdout).data;
}
export async function connectPublicMcp(socket, name) {
  const client = new Client({ name, version: "1" });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [cli, "mcp", "--socket", socket],
      }),
    );
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}

/** Source facts alone; explicit import chooses whether this donor becomes managed media. */
export async function seedCapture(home, facts) {
  const library = join(home, "library");
  await mkdir(library, { recursive: true, mode: 0o700 });
  const ids = [facts.recordingId, facts.sourceId];
  const store = new CaptureStore(join(library, "catalog.sqlite"), {
    now: () => "fixture",
    newId: () => ids.shift() ?? randomUUID(),
  });
  let take;
  try {
    take = store.allocate().recording;
    assert.equal(take.recordingId, facts.recordingId);
    store.ingestLifecycle(take.recordingId, {
      sourceId: take.sourceId,
      sequence: 1,
      state: "interrupted",
      reason: "generated source fixture",
      sourceDurationUs: facts.sourceDurationUs,
    });
  } finally {
    store.close();
  }
  await mkdir(join(library, "recordings", take.recordingId, "source"), {
    recursive: true,
    mode: 0o700,
  });
  return take;
}

/** Explicit acquisition admission; no capture, project, editing or dependency policy is inferred. */
export async function importAcquisition(service, path, requestId = randomUUID()) {
  const admitted = await service.call("acquisition.import", { requestId, path });
  assert.equal(admitted.ok, true, JSON.stringify(admitted));
  const job = await until(async () => {
    const reply = await service.call("job.get", { jobId: admitted.data.jobId });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.ok(
      !["failed", "canceled", "unavailable"].includes(reply.data.state),
      JSON.stringify(reply),
    );
    return reply.data.state === "ready" && reply.data;
  }, "Acquisition admission did not become ready");
  const reply = await service.call("acquisition.get", {
    acquisitionId: job.published.output.acquisitionId,
  });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return { job, acquisition: reply.data };
}
