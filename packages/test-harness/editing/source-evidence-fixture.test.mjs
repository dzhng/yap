import assert from "node:assert/strict";
import { test } from "node:test";
import { RESPONSE_FRAME_BYTES } from "@yap/protocol";
import { JourneyService, hash } from "./source-evidence-fixture.mjs";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

test("shared journey joins busy startup attempts before retry and refuses terminal startup errors", async (t) => {
  for (const retryable of [true, false]) {
    const home = await mkdtemp("/tmp/sr-journey-start-");
    const module = join(home, "service.mjs");
    const serviceEntry = new URL("../../../apps/service/dist/index.js", import.meta.url).href;
    await writeFile(
      module,
      `
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listenLocal, DerivativeDelivery } from ${JSON.stringify(serviceEntry)};
const home = process.argv[2], attempt = join(home, "attempt"), joined = join(home, "joined");
if (!existsSync(attempt)) {
  writeFileSync(attempt, "first");
  process.send({error: {code: "RENDER_WORKSPACE_BUSY", retryable: ${retryable}}});
  process.once("exit", () => writeFileSync(joined, "closed"));
  setTimeout(() => { process.exitCode = 1; process.disconnect(); }, 50);
} else {
  if (!existsSync(joined)) throw Error("previous startup child was not joined");
  writeFileSync(attempt, "second");
  const delivery = new DerivativeDelivery();
  const server = await listenLocal({delivery, runtimeDirectory: join(home, "run"), handler: () => ({ok: true, data: {ready: true}})});
  let closing;
  const close = () => closing ??= server.close().then(() => { delivery.dispose(); if (process.connected) process.disconnect(); });
  process.on("message", value => { if (value === "close") void close(); });
  process.on("disconnect", () => { void close(); });
  process.send({socketPath: server.socketPath});
}
`,
    );
    const report = { trace: [] };
    const service = new JourneyService(home, report, undefined, module);
    let client;
    t.after(async () => {
      service.mcp = client ?? service.mcp;
      try {
        await service.stop();
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    });
    if (retryable) {
      await service.start();
      client = service.mcp;
      assert.deepEqual(await service.call("service.health", {}, { transport: "mcp" }), {
        ready: true,
      });
      assert.equal(await readFile(join(home, "attempt"), "utf8"), "second");
      assert.equal(report.trace.filter((row) => row.operation === "service.start").length, 1);
      const closeFailure = Error("client close failed");
      service.mcp = {
        close: async () => {
          await client.close();
          throw closeFailure;
        },
      };
      await assert.rejects(service.stop(), (error) => error === closeFailure);
      assert.equal(service.child.exitCode, 0);
    } else {
      await assert.rejects(service.start(), /RENDER_WORKSPACE_BUSY/);
      assert.equal(await readFile(join(home, "attempt"), "utf8"), "first");
      assert.equal(service.child.exitCode, 1);
    }
  }
});

test("MCP complete results preserve values, reject corrupt delivery and close without replay", async () => {
  const failure = { code: "NOT_READY", message: "Retained failure", retryable: false, details: {} };
  for (const mode of [
    "success",
    "failure",
    "length",
    "hash",
    "progress",
    "offset",
    "eof",
    "id",
    "ok",
    "limit",
    "read",
    "read-and-close",
    "close",
  ]) {
    const complete =
      mode === "failure"
        ? { id: "original", ok: false, error: failure }
        : {
            id: mode === "id" ? "different" : "original",
            ok: true,
            data: {
              rows: [{ clipId: "left", atUs: 123, label: "café 🦊" }],
              delivery: { token: "nested-media" },
            },
          };
    const bytes = Buffer.from(JSON.stringify(complete));
    const descriptor = {
      id: "original",
      ok: mode === "ok" ? false : complete.ok,
      resultDelivery: {
        token: "lease",
        sizeBytes:
          mode === "limit" ? RESPONSE_FRAME_BYTES : bytes.length + (mode === "length" ? 1 : 0),
        sha256: mode === "hash" ? "0".repeat(64) : hash(bytes),
        expiresAtMs: Date.now() + 30000,
        mediaType: "application/json",
      },
    };
    const report = { trace: [], exchanges: [] };
    const service = new JourneyService("/unused", report);
    const calls = [];
    const readFailure = new Error("Read failed"),
      closeFailure = new Error("Close failed");
    service.mcp = {
      async callTool(request) {
        calls.push(structuredClone(request));
        assert.ok(calls.length <= bytes.length + 2, `${mode}: no-progress loop`);
        if (request.name === "timeline.events") return { structuredContent: descriptor };
        assert.equal(request.arguments.token, "lease");
        if (request.name === "artifact.close") {
          if (["close", "read-and-close"].includes(mode)) throw closeFailure;
          return { structuredContent: { id: "close", ok: true, data: { closed: true } } };
        }
        assert.equal(request.name, "artifact.read");
        if (["read", "read-and-close"].includes(mode)) throw readFailure;
        const offsetBytes = request.arguments.offsetBytes;
        const part = bytes.subarray(offsetBytes, offsetBytes + 17);
        return {
          structuredContent: {
            id: "chunk",
            ok: true,
            data: {
              data: part.toString("base64"),
              offsetBytes: mode === "offset" ? offsetBytes + 1 : offsetBytes,
              nextOffsetBytes: mode === "progress" ? offsetBytes : offsetBytes + part.length,
              eof: mode === "eof" ? true : offsetBytes + part.length === bytes.length,
            },
          },
        };
      },
    };
    const result = service.call(
      "timeline.events",
      { projectId: "project", limit: 250 },
      { transport: "mcp", error: mode === "failure" },
    );
    if (["success", "failure"].includes(mode)) {
      assert.deepEqual(await result, mode === "failure" ? failure : complete.data, mode);
      assert.deepEqual(report.exchanges[0].completeResponse, complete);
      assert.equal(report.exchanges[0].completeText, bytes.toString());
    } else {
      await assert.rejects(
        result,
        (error) => {
          if (mode === "read") assert.equal(error, readFailure);
          if (mode === "read-and-close")
            assert.deepEqual(error.errors, [readFailure, closeFailure]);
          if (mode === "close") assert.equal(error, closeFailure);
          if (["length", "progress", "offset", "eof"].includes(mode))
            assert.match(error.message, /chunk must advance/);
          if (mode === "hash") assert.match(error.message, /digest mismatch/);
          if (["id", "ok"].includes(mode)) assert.match(error.message, /must match its descriptor/);
          if (mode === "limit") assert.equal(error.name, "ZodError");
          return true;
        },
        mode,
      );
    }
    assert.deepEqual(report.exchanges[0].response, { structuredContent: descriptor });
    if (["hash", "id", "ok"].includes(mode))
      assert.equal(report.exchanges[0].completeText, bytes.toString());
    if (["id", "ok"].includes(mode))
      assert.deepEqual(report.exchanges[0].completeResponse, complete);
    assert.deepEqual(calls[0], {
      name: "timeline.events",
      arguments: { projectId: "project", limit: 250 },
    });
    assert.equal(calls.filter((call) => call.name === "timeline.events").length, 1, mode);
    assert.equal(calls.filter((call) => call.name === "artifact.close").length, 1, mode);
    assert.equal(calls.at(-1).name, "artifact.close", mode);
  }
  for (const complete of [
    { id: "inline", ok: true, data: { revision: "r1" } },
    { id: "inline", ok: false, error: failure },
  ]) {
    const service = new JourneyService("/unused", { trace: [] });
    service.mcp = { callTool: async () => ({ structuredContent: complete }) };
    assert.deepEqual(
      await service.call("edit.apply", {}, { transport: "mcp", error: !complete.ok }),
      complete.ok ? complete.data : failure,
    );
  }
});
