import { afterEach, expect, it } from "vitest";
import { createServer, type Server } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { callLocal } from "./transport.js";
import { operationSchema } from "@yap/protocol";

const cleanup: (() => Promise<void>)[] = [];
it("keeps retry delay and a valid resolving request on both response paths", async () => {
  const retry = { operation: "job.get", params: { jobId: "missing" } };
  const envelope = {
    id: "wanted",
    ok: false,
    error: {
      code: "NOT_READY",
      message: "Still preparing",
      retryable: true,
      retryAfterMs: 15000,
      details: { retry },
    },
  };
  for (const delivery of [false, true]) {
    const socketPath = await responder(JSON.stringify(envelope) + "\n");
    const result = await callLocal(socketPath, {
      id: "wanted",
      operation: "job.get",
      params: { jobId: "missing" },
      ...(delivery ? { resultDelivery: { inlineBytes: 1024 } } : {}),
    });
    expect(result).toEqual(envelope);
    if (!result.ok && "error" in result)
      expect(operationSchema.parse(result.error.details.retry)).toEqual(retry);
  }
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function responder(
  reply: string | undefined,
  options: { delayMs?: number; onRequest?: () => void } = {},
): Promise<string> {
  const directory = await mkdtemp("/tmp/scr-client-");
  const path = directory + "/s";
  const server: Server = createServer((socket) => {
    socket.on("error", () => socket.destroy());
    socket.once("data", () => {
      options.onRequest?.();
      if (reply === undefined) return;
      if (!options.delayMs) {
        socket.end(reply);
        return;
      }
      const timer = setTimeout(() => socket.end(reply), options.delayMs);
      socket.once("close", () => clearTimeout(timer));
    });
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(path, resolve));
  cleanup.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  return path;
}

it("rejects a successful result correlated to a different request", async () => {
  const socketPath = await responder('{"id":"wrong","ok":true,"data":{}}\n');
  await expect(
    callLocal(socketPath, { id: "wanted", operation: "test", params: {} }),
  ).rejects.toMatchObject({ code: "UNCORRELATED_RESPONSE" });
});

it("accepts additive response metadata without changing the operation result", async () => {
  const socketPath = await responder(
    '{"id":"wanted","ok":true,"data":{"value":3},"diagnostic":"new field"}\n',
  );
  expect(await callLocal(socketPath, { id: "wanted", operation: "test", params: {} })).toEqual({
    id: "wanted",
    ok: true,
    data: { value: 3 },
  });
});

it.each([undefined, '{"id":"wanted","ok":true,"data":null}\n'])(
  "times out a missing or delayed reply without resending the request",
  async (reply) => {
    let requests = 0;
    const socketPath = await responder(reply, { delayMs: 200, onRequest: () => requests++ });
    await expect(
      callLocal(socketPath, { id: "wanted", operation: "test", params: {} }, { timeoutMs: 30 }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(requests).toBe(1);
  },
);

it("rejects EOF before a response newline instead of accepting partial JSON", async () => {
  const socketPath = await responder('{"id":"wanted","ok":true,"data":null}');
  await expect(
    callLocal(socketPath, { id: "wanted", operation: "test", params: {} }),
  ).rejects.toMatchObject({ code: "TRUNCATED_FRAME" });
});

it("rejects a response beyond eight MiB without waiting for a terminator", async () => {
  const socketPath = await responder(" ".repeat(8 * 1024 * 1024 + 1));
  await expect(
    callLocal(socketPath, { id: "wanted", operation: "test", params: {} }),
  ).rejects.toMatchObject({ code: "FRAME_TOO_LARGE" });
});

it("correlates against the sent request even if the caller reuses its object", async () => {
  const socketPath = await responder('{"id":"sent","ok":true,"data":null}\n', { delayMs: 20 });
  const request = { id: "sent", operation: "test", params: {} };
  const response = callLocal(socketPath, request);
  request.id = "next";
  expect(await response).toEqual({ id: "sent", ok: true, data: null });
});
