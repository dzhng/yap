import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  ARTIFACT_CHUNK_BYTES,
  RESPONSE_FRAME_BYTES,
  deliveredResponseSchema,
  idempotentOperations,
  readOnlyOperations,
  responseSchema,
} from "@yap/protocol";
import { z } from "zod";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cliReply } from "./first-preview-transport.mjs";

export const run = promisify(execFile);
export const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
// Standard receipts carry the bounded service JSON once structurally and once as escaped text.
// This covers sequential JSON receipts, not additional inline media or concurrent responses.
export const mcpReceiveBytes = 3 * RESPONSE_FRAME_BYTES + 64 * 1024;
export const root = new URL("../../../", import.meta.url).pathname;
export async function poll(read, done, label) {
  const deadline = performance.now() + 180000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    assert.ok(!["failed", "canceled"].includes(value.state), `${label}: ${JSON.stringify(value)}`);
    assert.ok(performance.now() < deadline, `${label}: deadline`);
    await delay(100);
  }
}

const deliveryChunk = z.object({
  data: z.string(),
  offset: z.int().nonnegative(),
  nextOffset: z.int().nonnegative(),
  eof: z.boolean(),
});

/** Consume the public complete-result lease without reissuing the original operation. */
async function completeMcpResult(client, descriptor, exchange) {
  const token = descriptor.resultDelivery?.token;
  assert.ok(typeof token === "string" && token.length > 0, "Result delivery needs a lease token");
  let failure, response;
  try {
    const { resultDelivery: delivery } = deliveredResponseSchema.parse(descriptor);
    const chunks = [];
    for (let offset = 0; offset < delivery.bytes;) {
      const reply = await client.callTool({
        name: "artifact.read",
        arguments: {
          token,
          offset,
          maxBytes: Math.min(ARTIFACT_CHUNK_BYTES, delivery.bytes - offset),
        },
      });
      if (exchange) (exchange.reads ??= []).push(structuredClone(reply));
      const read = responseSchema.parse(reply.structuredContent);
      assert.ok(read.ok, `Result delivery read failed: ${JSON.stringify(read)}`);
      const part = deliveryChunk.parse(read.data);
      assert.ok(
        part.data.length <= 4 * Math.ceil(ARTIFACT_CHUNK_BYTES / 3),
        "Oversized result chunk",
      );
      const decoded = Buffer.from(part.data, "base64");
      assert.ok(
        part.offset === offset &&
          decoded.length > 0 &&
          decoded.length <= ARTIFACT_CHUNK_BYTES &&
          part.nextOffset === offset + decoded.length &&
          part.nextOffset <= delivery.bytes &&
          part.eof === (part.nextOffset === delivery.bytes) &&
          decoded.toString("base64") === part.data,
        "Result delivery chunk must advance within its declared bytes",
      );
      chunks.push(decoded);
      offset = part.nextOffset;
    }
    const bytes = Buffer.concat(chunks);
    const text = bytes.toString("utf8");
    if (exchange) exchange.completeText = text;
    assert.equal(bytes.length, delivery.bytes);
    assert.equal(hash(bytes), delivery.sha256, "Result delivery digest mismatch");
    const complete = JSON.parse(text);
    if (exchange) exchange.completeResponse = structuredClone(complete);
    response = responseSchema.parse(complete);
    assert.deepEqual(
      { id: response.id, ok: response.ok },
      { id: descriptor.id, ok: descriptor.ok },
      "Complete result must match its descriptor",
    );
  } catch (error) {
    failure = error;
  } finally {
    try {
      const closed = await client.callTool({ name: "artifact.close", arguments: { token } });
      if (exchange) exchange.closeResponse = structuredClone(closed);
      const response = responseSchema.parse(closed.structuredContent);
      assert.ok(
        response.ok && response.data?.closed === true,
        "Result delivery lease did not close",
      );
    } catch (closeFailure) {
      failure = failure
        ? new AggregateError([failure, closeFailure], "Result read and lease close failed")
        : closeFailure;
    }
  }
  if (failure) throw failure;
  return response;
}

/** Copies already prepared, hash-pinned files. No network fetch or preparation operation. */
export async function copyModels(home, request) {
  const { parakeetModel: manifest, Models } = await import("../../../packages/core/dist/models.js");
  assert.deepEqual(request.files, manifest.files);
  const models = new Models(join(home, "library")).transcription("parakeet");
  const target = join(home, "library/models", manifest.name, manifest.revision);
  const receipt = { modelDigest: models.modelDigest, files: {} };
  for (const file of manifest.files) {
    const source = join(request.directory, file.path);
    const destination = join(target, manifest.folderName, file.path);
    assert.ok((await lstat(source)).isFile());
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination, constants.COPYFILE_FICLONE);
    const bytes = await readFile(destination);
    assert.equal(bytes.length, file.bytes);
    assert.equal(hash(bytes), file.sha256);
    const stat = await lstat(destination, { bigint: true });
    receipt.files[file.path] = { modifiedNs: String(stat.mtimeNs), inode: String(stat.ino) };
  }
  await writeFile(join(target, "receipt.json"), JSON.stringify(receipt));
  assert.deepEqual(models.status(), { state: "ready" });
  return { modelDigest: models.modelDigest, files: manifest.files };
}

/** Public transports around a scratch project service; barriers hold only real native replies. */
export class JourneyService {
  constructor(
    home,
    report,
    evidence,
    serviceModule = new URL("./source-acquisition-service.mjs", import.meta.url),
  ) {
    this.home = home;
    this.serviceModule = serviceModule;
    this.evidence = evidence;
    this.report = report;
    this.logs = [];
    this.barriers = new Map();
    this.requestSequence = 0;
  }
  async start() {
    const deadline = performance.now() + 30000;
    this.started = false;
    for (;;) {
      this.child = fork(
        this.serviceModule,
        [this.home, ...(this.evidence ? [this.evidence] : [])],
        {
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      );
      this.child.stdout.on("data", (bytes) => this.logs.push(bytes.toString()));
      this.child.stderr.on("data", (bytes) => this.logs.push(bytes.toString()));
      this.child.on("message", (message) => {
        if (message.type) this.barriers.set(`${message.id}/${message.type}`, message);
      });
      const timeout = new AbortController();
      let ready;
      try {
        [ready] = await Promise.race([
          once(this.child, "message"),
          once(this.child, "exit").then(([code]) => {
            throw new Error(`Service exited ${code}: ${this.logs.join("")}`);
          }),
          delay(Math.max(1, deadline - performance.now()), undefined, {
            signal: timeout.signal,
            ref: false,
          }).then(() => {
            throw new Error("Service startup deadline");
          }),
        ]);
      } finally {
        timeout.abort();
      }
      if (!ready.error) {
        await this.connect(ready.socketPath);
        return;
      }
      await this.stop();
      if (
        ready.error.code !== "RENDER_WORKSPACE_BUSY" ||
        !ready.error.retryable ||
        performance.now() >= deadline
      )
        throw new Error(`Service startup: ${JSON.stringify(ready.error)}`);
      this.report.trace.push({ operation: "service.start", error: ready.error });
      await delay(50);
    }
  }
  async connect(socketPath) {
    this.socketPath = socketPath;
    this.mcp = new Client({ name: "source-transcript-journey", version: "1" });
    await this.mcp.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(root, "apps/cli/dist/main.js"), "mcp", "--socket", this.socketPath],
        stderr: "pipe",
        maxBufferSize: mcpReceiveBytes,
      }),
    );
    this.started = true;
  }
  async call(operation, params, { transport = "cli", error = false, output } = {}) {
    const wireParams =
      !readOnlyOperations.has(operation) &&
      !idempotentOperations.has(operation) &&
      params.requestId === undefined
        ? { ...params, requestId: `harness-${operation}-${++this.requestSequence}` }
        : params;
    const request = this.report.exchanges
      ? structuredClone({ operation, params: wireParams, transport, error, output })
      : undefined;
    const reply =
      transport === "mcp"
        ? await this.mcp.callTool({ name: operation, arguments: wireParams })
        : await cliReply([
            join(root, "apps/cli/dist/main.js"),
            operation,
            "--socket",
            this.socketPath,
            "--params",
            JSON.stringify(wireParams),
            ...(output ? ["--output", output] : []),
          ]);
    const exchange = this.report.exchanges
      ? { request, response: structuredClone(reply) }
      : undefined;
    if (exchange) this.report.exchanges.push(exchange);
    let response = transport === "mcp" ? reply.structuredContent : reply;
    if (transport === "mcp" && response?.resultDelivery)
      response = await completeMcpResult(this.mcp, response, exchange);
    assert.equal(response?.ok, !error, `${operation}: ${JSON.stringify(response)}`);
    this.report.trace.push({
      operation,
      transport,
      ok: response.ok,
      state: response.data?.state,
      revisionId: response.data?.revisionId,
      error: response.error,
    });
    return response.ok ? response.data : response.error;
  }
  async arm(operation) {
    const id = randomUUID();
    this.child.send({ type: "barrier.arm", id, operation, remaining: 1 });
    await poll(
      () => this.barriers.get(`${id}/barrier.armed`) ?? {},
      (v) => v.type === "barrier.armed",
      "arm",
    );
    return () =>
      poll(
        () => this.barriers.get(`${id}/barrier.hit`) ?? {},
        (v) => v.nativeSucceeded,
        "native reply",
      );
  }
  async stop(crash = false) {
    let clientFailure;
    try {
      await this.mcp?.close();
    } catch (error) {
      clientFailure = error;
    }
    this.mcp = undefined;
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      if (clientFailure) throw clientFailure;
      return;
    }
    const exited = once(child, "exit");
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Service shutdown deadline"));
      }, 15000);
      timer.unref();
    });
    if (crash) child.kill("SIGKILL");
    // Startup failures may close IPC before cleanup. The bounded terminal-exit
    // check owns shutdown success; a failed send must not hide the startup error.
    else child.send("close", () => {});
    try {
      const [code, signal] = await Promise.race([exited, timeout]);
      if (crash) assert.equal(signal, "SIGKILL");
      else if (this.started) assert.equal(code, 0, this.logs.join(""));
    } catch (error) {
      await exited;
      if (clientFailure)
        throw new AggregateError([clientFailure, error], "Client and service shutdown failed");
      throw error;
    } finally {
      clearTimeout(timer);
      this.started = false;
    }
    if (clientFailure) throw clientFailure;
  }
}

/** Synthetic acquisition journals around real speech bytes; not a physical capture claim. */
export async function acquisitionDonor(directory, narration, available) {
  await mkdir(directory, { recursive: true });
  await copyFile(
    join(root, "fixtures/narrated-workbench/video.mov"),
    join(directory, "video.mov"),
    constants.COPYFILE_FICLONE,
  );
  await copyFile(narration, join(directory, "narration.mov"), constants.COPYFILE_FICLONE);
  const records = [
    {
      event: "header",
      data: {
        schemaVersion: 1,
        sessionID: `synthetic-source-journey-${randomUUID()}`,
        source: { kind: "window", windowID: 7 },
        width: 3120,
        height: 1970,
        microphone: true,
        systemAudio: false,
      },
    },
    { event: "origin", data: { hostUs: 1000000 } },
    ...available.map((range) => ({ event: "audioSamples", data: { role: "narration", ...range } })),
    { event: "finished", data: {} },
    { event: "lifecycle", data: { state: "complete" } },
  ];
  const raw = records.map((r, i) => JSON.stringify({ ...r, sequence: i + 1 }) + "\n").join("");
  await writeFile(join(directory, "capture.journal.jsonl"), raw);
  return hash(raw);
}
