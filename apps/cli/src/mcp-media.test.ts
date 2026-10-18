import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { listenLocal, DerivativeDelivery } from "@yap/service";
import {
  operationSchema,
  responseSchema,
  type OperationResult,
  serviceRuntimeDirectory,
  RESPONSE_FRAME_BYTES,
  operationError,
} from "@yap/protocol";
import { mcpResult, mcpInlineBytes } from "./mcp-result.js";
import { LocalTransportError } from "@yap/client";
import { ArtifactDeliveryError } from "./artifact-delivery.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(
  make: (
    open: (
      sizeBytes: Buffer,
      declaredBytes?: number,
    ) => { token: string; sizeBytes: number; expiresAtMs: number },
  ) => OperationResult,
  options: { discovery?: boolean; loseConnection?: boolean } = {},
) {
  await mkdir(".build", { recursive: true });
  const home = await mkdtemp(join(process.cwd(), ".build/m-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const delivery = new DerivativeDelivery();
  cleanup.push(async () => delivery.dispose());
  const calls = { reads: 0, renewals: 0, closes: 0 };
  const operations: string[] = [];
  let consumed!: () => void;
  const firstRead = new Promise<"unexpected automatic read">((resolve) => {
    consumed = () => resolve("unexpected automatic read");
  });
  const result = make((bytes, declaredBytes = bytes.length) =>
    delivery.open({ kind: "asset", id: "fixture" }, () => ({
      bytes: declaredBytes,
      read: (buffer, position) =>
        declaredBytes === bytes.length
          ? bytes.copy(buffer, 0, position, position + buffer.length)
          : (Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength).fill(bytes),
            buffer.length),
      release() {},
    })),
  );
  const server = await listenLocal({
    runtimeDirectory: options.discovery ? serviceRuntimeDirectory(home) : home,
    delivery,
    handler: (request) => {
      operations.push(request.operation);
      const op = operationSchema.parse({ operation: request.operation, params: request.params });
      if (op.operation === "artifact.read") {
        calls.reads++;
        consumed();
        if (options.loseConnection) void server.close();
        return {
          ok: true,
          data: delivery.read(op.params.token, op.params.offsetBytes, op.params.maxBytes),
        };
      }
      if (op.operation === "artifact.renew") {
        calls.renewals++;
        return { ok: true, data: delivery.renew(op.params.token) };
      }
      if (op.operation === "artifact.close") {
        calls.closes++;
        delivery.close(op.params.token);
        return { ok: true, data: { closed: true } };
      }
      if (op.operation === "service.health") return { ok: true, data: {} };
      return result;
    },
  });
  cleanup.push(() => server.close());
  const client = new Client({ name: "media-admission", version: "1" });
  cleanup.push(() => client.close());
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        new URL("../dist/main.js", import.meta.url).pathname,
        "mcp",
        ...(options.discovery ? [] : ["--socket", server.socketPath]),
      ],
      stderr: "pipe",
      env: { ...process.env, YAP_HOME: home },
    }),
  );
  return { client, calls, firstRead, result, operations, socketPath: server.socketPath, delivery };
}
async function readBytes(client: Client, token: string, sizeBytes: number) {
  const chunks: Buffer[] = [];
  for (let offsetBytes = 0; offsetBytes < sizeBytes;) {
    const read = responseSchema.parse(
      (await client.callTool({ name: "artifact.read", arguments: { token, offsetBytes } }))
        .structuredContent,
    );
    if (!read.ok) throw Error(read.error.message);
    const chunk = read.data as { data: string; nextOffsetBytes: number };
    chunks.push(Buffer.from(chunk.data, "base64"));
    expect(chunk.nextOffsetBytes).toBeGreaterThan(offsetBytes);
    offsetBytes = chunk.nextOffsetBytes;
  }
  return Buffer.concat(chunks);
}
const ready = (delivery: { token: string; sizeBytes: number; expiresAtMs: number }) => ({
  state: "ready",
  published: {
    generation: "1",
    output: { mediaType: "image/png", recipe: { width: 640, height: 360 } },
    issues: [],
  },
  delivery,
  support: { startUs: 7, endUs: 10 },
  sourceClock: "fixture",
  evidence: { quote: '"\\é' },
});
test("default SDK defers a complete eight MiB PNG before any consumption and leaves all bytes readable", async () => {
  const bytes = Buffer.alloc(8 * 1024 ** 2, 137);
  const f = await fixture((open) => ({ ok: true, data: ready(open(bytes)) }));
  const pending = f.client.callTool({
    name: "frame.get",
    arguments: { assetId: "fixture", streamId: "video", atUs: 7 },
  });
  pending.catch(() => undefined);
  const reply = await Promise.race([pending, f.firstRead]);
  expect(reply).not.toBe("unexpected automatic read");
  if (typeof reply === "string") throw Error(reply);
  const response = responseSchema.parse(reply.structuredContent);
  expect(response).toEqual({ id: response.id, ...f.result });
  expect(reply.content).toEqual([{ type: "text", text: JSON.stringify(reply.structuredContent) }]);
  expect(reply.isError).toBe(false);
  expect(f.calls).toEqual({ reads: 0, renewals: 0, closes: 0 });
  if (!response.ok) throw Error(response.error.message);
  const token = (response.data as ReturnType<typeof ready>).delivery.token;
  expect((await readBytes(f.client, token, bytes.length)).equals(bytes)).toBe(true);
  const intended = {
    ...reply,
    content: [
      { type: "text", text: JSON.stringify(reply.structuredContent) },
      { type: "image", data: bytes.toString("base64"), mimeType: "image/png" },
    ],
  };
  const intendedWire = serializeMessage({ result: intended, jsonrpc: "2.0", id: 1 });
  expect(() => new ReadBuffer().append(Buffer.from(intendedWire))).toThrow(
    "ReadBuffer exceeded maximum size of 10485760 bytes",
  );
});

test("default SDK defers all eight one MiB images together, retaining complete items and live tokens", async () => {
  const buffers = Array.from({ length: 8 }, (_, index) => Buffer.alloc(1024 ** 2, 17 + index));
  const f = await fixture((open) => ({
    ok: true,
    data: {
      assetId: "fixture",
      streamId: "video",
      acquisitionId: "a",
      items: buffers.map((bytes, index) => ({
        atUs: index % 3,
        ok: true,
        data: ready(open(bytes)),
      })),
    },
  }));
  const pending = f.client.callTool({
    name: "frame.batch",
    arguments: {
      assetId: "fixture",
      streamId: "video",
      acquisitionId: "a",
      atUs: buffers.map((_, index) => index % 3),
    },
  });
  pending.catch(() => undefined);
  const reply = await Promise.race([pending, f.firstRead]);
  expect(reply).not.toBe("unexpected automatic read");
  if (typeof reply === "string") throw Error(reply);
  const result = responseSchema.parse(reply.structuredContent);
  expect(result).toEqual({ id: result.id, ...f.result });
  expect(reply.content).toEqual([{ type: "text", text: JSON.stringify(result) }]);
  expect(reply.isError).toBe(false);
  expect(f.calls).toEqual({ reads: 0, renewals: 0, closes: 0 });
  if (!result.ok) throw Error(result.error.message);
  const items = (result.data as { items: { data: ReturnType<typeof ready> }[] }).items;
  for (const [index, item] of items.entries()) {
    expect(
      (await readBytes(f.client, item.data.delivery.token, item.data.delivery.sizeBytes)).equals(
        buffers[index]!,
      ),
    ).toBe(true);
  }
  const intendedResult = {
    ...result,
    data: {
      ...(result.data as Record<string, unknown>),
      items: items.map((item, index) => ({
        ...item,
        data: { ...item.data, contentIndex: index + 1 },
      })),
    },
  };
  const intended = {
    ...reply,
    structuredContent: intendedResult,
    content: [
      { type: "text", text: JSON.stringify(intendedResult) },
      ...buffers.map((bytes) => ({
        type: "image",
        data: bytes.toString("base64"),
        mimeType: "image/png",
      })),
    ],
  };
  const intendedWire = serializeMessage({ result: intended, jsonrpc: "2.0", id: 1 });
  expect(() => new ReadBuffer().append(Buffer.from(intendedWire))).toThrow(
    "ReadBuffer exceeded maximum size of 10485760 bytes",
  );
});

test("admitted duplicate batch preserves metadata, item errors and actual content indices without rediscovery", async () => {
  const bytes = Buffer.from([137, 80, 78, 71, 0, 255, 12]);
  const originalError = {
    code: "NOT_READY",
    message: "Pending source",
    retryable: true,
    details: { support: { startUs: 2, endUs: 3 } },
  };
  const f = await fixture(
    (open) => ({
      ok: true,
      data: {
        assetId: "fixture",
        streamId: "video",
        items: [
          { atUs: 7, ok: true, data: ready(open(bytes)) },
          { atUs: 2, ok: false, error: originalError },
          { atUs: 7, ok: true, data: { state: "ready", delivery: open(bytes), published: {} } },
          { atUs: 7, ok: true, data: ready(open(bytes)) },
        ],
      },
    }),
    { discovery: true },
  );
  const reply = await f.client.callTool({
    name: "frame.batch",
    arguments: { assetId: "fixture", streamId: "video", atUs: [7, 2, 7, 7] },
  });
  const result = responseSchema.parse(reply.structuredContent);
  if (!result.ok || !f.result.ok) throw Error("Expected batch success");
  const original = f.result.data as {
    assetId: string;
    streamId: string;
    items: {
      atUs: number;
      ok: boolean;
      data?: ReturnType<typeof ready>;
      error?: typeof originalError;
    }[];
  };
  expect(result).toEqual({
    id: result.id,
    ok: true,
    data: {
      ...original,
      items: [
        { ...original.items[0], data: { ...original.items[0]!.data, contentIndex: 1 } },
        original.items[1],
        {
          atUs: 7,
          ok: false,
          error: {
            code: "INVALID_RESPONSE",
            message: "Ready artifact has no valid delivery",
            retryable: false,
            details: {},
          },
        },
        { ...original.items[3], data: { ...original.items[3]!.data, contentIndex: 2 } },
      ],
    },
  });
  expect(reply.content).toEqual([
    { type: "text", text: JSON.stringify(result) },
    ...[1, 2].map(() => ({ type: "image", data: bytes.toString("base64"), mimeType: "image/png" })),
  ]);
  expect(f.calls).toEqual({ reads: 2, renewals: 0, closes: 2 });
  expect(f.operations).toEqual([
    "service.health",
    "frame.batch",
    "artifact.read",
    "artifact.close",
    "artifact.read",
    "artifact.close",
  ]);
  // A malformed ready item was never acquired by the consumer, so its lease is still live.
  expect(
    Buffer.from(
      f.delivery.read(original.items[2]!.data!.delivery.token, 0, bytes.length).data,
      "base64",
    ).equals(bytes),
  ).toBe(true);
});

test("an admitted batch keeps owned connection failures isolated after its selected socket disappears", async () => {
  const f = await fixture(
    (open) => ({
      ok: true,
      data: {
        assetId: "fixture",
        streamId: "video",
        items: [1, 2].map((atUs) => ({
          atUs,
          ok: true,
          data: ready(open(Buffer.from([1, 2, 3]))),
        })),
      },
    }),
    { discovery: true, loseConnection: true },
  );
  const reply = await f.client.callTool({
    name: "frame.batch",
    arguments: { assetId: "fixture", streamId: "video", atUs: [1, 2] },
  });
  const result = responseSchema.parse(reply.structuredContent);
  if (!result.ok) throw Error(result.error.message);
  const data = result.data as {
    assetId: string;
    streamId: string;
    items: {
      atUs: number;
      ok: false;
      error: { code: string; message: string; retryable: boolean; details: object };
    }[];
  };
  expect(data).toEqual({
    assetId: "fixture",
    streamId: "video",
    items: [
      {
        atUs: 1,
        ok: false,
        error: {
          code: "INVALID_RESPONSE",
          message: "Connection ended before the JSON line terminator",
          retryable: false,
          details: {},
        },
      },
      {
        atUs: 2,
        ok: false,
        error: {
          code: "CONNECTION_ERROR",
          message: expect.stringContaining(f.socketPath),
          retryable: true,
          details: {},
        },
      },
    ],
  });
  expect(reply.content).toEqual([{ type: "text", text: JSON.stringify(result) }]);
  expect(reply.isError).toBe(false);
  expect(f.operations).toEqual(["service.health", "frame.batch", "artifact.read"]);
});

const audioArguments = {
  assetId: "fixture",
  streamId: "audio",
  sourceRange: { startUs: 0, endUs: 100 },
};
for (const [kind, operation, mediaType] of [
  ["audio", "audio.get", "audio/wav"],
  ["JSON", "waveform.get", "application/json"],
] as const) {
  test(`default SDK defers an oversized legal ${kind} envelope without consuming its lease`, async () => {
    const bytes =
      kind === "audio"
        ? Buffer.from("RIFF")
        : Buffer.from('"' + "\\\\".repeat(2 * 1024 ** 2 - 1) + '"');
    const f = await fixture((open) => ({
      ok: true,
      data: {
        state: "ready",
        published: { generation: "1", output: { mediaType }, issues: [] },
        delivery: open(bytes, kind === "audio" ? 8 * 1024 ** 2 : bytes.length),
        evidence: { exact: true },
      },
    }));
    const reply = await f.client.callTool({ name: operation, arguments: audioArguments });
    const response = responseSchema.parse(reply.structuredContent);
    expect(response).toEqual({ id: response.id, ...f.result });
    expect(reply.content).toEqual([
      { type: "text", text: JSON.stringify(reply.structuredContent) },
    ]);
    expect(f.calls).toEqual({ reads: 0, renewals: 0, closes: 0 });
  });
}
for (const [name, operation, published, bytes, message, closes] of [
  [
    "image raw cap",
    "frame.get",
    { generation: "1", output: { mediaType: "image/png" }, issues: [] },
    32 * 1024 ** 2 + 1,
    "Image exceeds its buffered delivery byte limit",
    1,
  ],
  [
    "JSON raw cap",
    "waveform.get",
    { generation: "1", output: { mediaType: "application/json" }, issues: [] },
    4 * 1024 ** 2 + 1,
    "JSON evidence exceeds its buffered delivery byte limit",
    1,
  ],
  [
    "large audio metadata",
    "audio.get",
    { generation: "1", output: { mediaType: "audio/wav" }, issues: [] },
    Number.MAX_SAFE_INTEGER,
    null,
    0,
  ],
] as const) {
  test(`MCP admission preserves existing ${name} outcome and cleanup`, async () => {
    const f = await fixture((open) => ({
      ok: true,
      data: { state: "ready", published, delivery: open(Buffer.from([1]), bytes) },
    }));
    const reply = await f.client.callTool({
      name: operation,
      arguments:
        operation === "frame.get"
          ? { assetId: "fixture", streamId: "video", atUs: 0 }
          : audioArguments,
    });
    const response = responseSchema.parse(reply.structuredContent);
    expect(response).toEqual(
      message
        ? {
            id: response.id,
            ok: false,
            error: { code: "LIMIT_EXCEEDED", message, retryable: false, details: {} },
          }
        : { id: response.id, ...f.result },
    );
    expect(reply.content).toEqual([
      { type: "text", text: JSON.stringify(reply.structuredContent) },
    ]);
    expect(reply.isError).toBe(Boolean(message));
    expect(f.calls).toEqual({ reads: 0, renewals: 0, closes });
  });
}
for (const [kind, operation, mediaType, bytes] of [
  ["audio", "audio.get", "audio/wav", Buffer.from([82, 73, 70, 70, 0, 255, 33])],
  [
    "JSON",
    "waveform.get",
    "application/json",
    Buffer.from('{\n"quotes":"\\\"\\\\é", "channels":[{"min":-0.2,"max":0.9,"rms":0.3}]}\n'),
  ],
] as const) {
  test(`admitted ${kind} retains exact bytes and metadata, renews and closes its lease`, async () => {
    const f = await fixture((open) => ({
      ok: true,
      data: {
        state: "ready",
        published: { generation: "1", output: { mediaType }, issues: [] },
        delivery: { ...open(bytes), expiresAtMs: Date.now() + 1000 },
        clock: { originUs: 4, domain: "source" },
      },
    }));
    const reply = await f.client.callTool({ name: operation, arguments: audioArguments });
    const response = responseSchema.parse(reply.structuredContent);
    expect(response).toEqual({ id: response.id, ...f.result });
    expect(reply.content).toEqual([
      { type: "text", text: JSON.stringify(reply.structuredContent) },
      kind === "JSON"
        ? { type: "text", text: bytes.toString("utf8") }
        : { type: "audio", data: bytes.toString("base64"), mimeType: "audio/wav" },
    ]);
    expect(f.calls).toEqual({ reads: 1, renewals: 1, closes: 1 });
  });
}

test("complete admission counts actual escaped RPC identity at the wire boundary", async () => {
  const bytes = Buffer.alloc(6 * 1024 ** 2 - 1500, 31);
  const f = await fixture((open) => ({ ok: true, data: ready(open(bytes)) }));
  const answer = { id: "boundary", ...f.result };
  const rpcId = '"é\\'.repeat(1200);
  const deferred = await mcpResult(
    { socketPath: f.socketPath },
    "frame.get",
    answer,
    rpcId,
    (error) => {
      if (!(error instanceof ArtifactDeliveryError)) throw error;
      return { id: answer.id, ...operationError(error.code, error.message) };
    },
  );
  expect(deferred).toEqual({
    content: [{ type: "text", text: JSON.stringify(answer) }],
    structuredContent: answer,
    isError: false,
  });
  expect(f.calls).toEqual({ reads: 0, renewals: 0, closes: 0 });
  expect(mcpInlineBytes(rpcId)).toBeLessThan(mcpInlineBytes(1));
  const numeric = await f.client.callTool({
    name: "frame.get",
    arguments: { assetId: "fixture", streamId: "video", atUs: 7 },
  });
  const result = responseSchema.parse(numeric.structuredContent);
  expect(result).toEqual({ id: result.id, ...f.result });
  expect(numeric.content).toEqual([
    { type: "text", text: JSON.stringify(numeric.structuredContent) },
    { type: "image", data: bytes.toString("base64"), mimeType: "image/png" },
  ]);
  const numericBytes = Buffer.byteLength(
    JSON.stringify({ result: numeric, jsonrpc: "2.0", id: 1 }) + "\n",
  );
  const escapedBytes = Buffer.byteLength(
    JSON.stringify({ result: numeric, jsonrpc: "2.0", id: rpcId }) + "\n",
  );
  expect(numericBytes).toBeLessThanOrEqual(RESPONSE_FRAME_BYTES);
  expect(escapedBytes).toBeGreaterThan(RESPONSE_FRAME_BYTES);
});

test("admitted cancellation keeps the existing un-signaled close and full failure", async () => {
  const f = await fixture((open) => ({ ok: true, data: ready(open(Buffer.from([2, 3, 5]))) }));
  const controller = new AbortController();
  controller.abort();
  const answer = { id: "cancel", ...f.result };
  const reply = await mcpResult(
    { socketPath: f.socketPath, signal: controller.signal },
    "frame.get",
    answer,
    1,
    (error) => {
      if (!(error instanceof LocalTransportError) && !(error instanceof ArtifactDeliveryError))
        throw error;
      return { id: answer.id, ...operationError(error.code, error.message) };
    },
  );
  const expected = {
    id: "cancel",
    ...operationError("ABORTED", "Call canceled before connection"),
  };
  expect(reply).toEqual({
    content: [{ type: "text", text: JSON.stringify(expected) }],
    structuredContent: expected,
    isError: true,
  });
  expect(f.calls).toEqual({ reads: 0, renewals: 0, closes: 1 });
});

test("whole-batch deferral preserves item errors and never drains an earlier small image", async () => {
  const small = Buffer.from([137, 80, 78, 71, 1, 8]);
  const itemError = {
    code: "NOT_FOUND",
    message: "No frame at source support",
    retryable: false,
    details: { support: { startUs: 2, endUs: 3 }, unavailable: true },
  };
  const f = await fixture((open) => ({
    ok: true,
    data: {
      assetId: "fixture",
      streamId: "video",
      acquisitionId: "a",
      items: [
        { atUs: 7, ok: true, data: ready(open(small)) },
        { atUs: 2, ok: false, error: itemError },
        { atUs: 7, ok: true, data: ready(open(Buffer.from([33]), 8 * 1024 ** 2)) },
        { atUs: 7, ok: true, data: ready(open(small)) },
      ],
    },
  }));
  const reply = await f.client.callTool({
    name: "frame.batch",
    arguments: { assetId: "fixture", streamId: "video", acquisitionId: "a", atUs: [7, 2, 7, 7] },
  });
  const response = responseSchema.parse(reply.structuredContent);
  expect(response).toEqual({ id: response.id, ...f.result });
  expect(reply.content).toEqual([{ type: "text", text: JSON.stringify(reply.structuredContent) }]);
  expect(f.calls).toEqual({ reads: 0, renewals: 0, closes: 0 });
  if (!response.ok) throw Error(response.error.message);
  const items = (response.data as { items: { data: ReturnType<typeof ready> }[] }).items;
  expect(
    (await readBytes(f.client, items[0]!.data.delivery.token, small.length)).equals(small),
  ).toBe(true);
  expect(
    (await readBytes(f.client, items[3]!.data.delivery.token, small.length)).equals(small),
  ).toBe(true);
});
