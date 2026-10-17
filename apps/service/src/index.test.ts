import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { callLocal } from "@yap/client";
import { listenLocal } from "./index.js";
import { EventEmitter, once } from "node:events";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

it("an occupied socket cannot be evicted, and ordinary close permits a fresh listener", async () => {
  const runtimeDirectory = await mkdtemp("/tmp/scr-service-");
  cleanup.push(() => rm(runtimeDirectory, { recursive: true, force: true }));
  const first = await listenLocal({
    runtimeDirectory,
    handler: () => ({ ok: true, data: "first" }),
  });
  cleanup.push(first.close);
  expect((await stat(runtimeDirectory)).mode & 0o777).toBe(0o700);
  expect((await stat(first.socketPath)).mode & 0o777).toBe(0o600);
  await expect(
    listenLocal({ runtimeDirectory, handler: () => ({ ok: true, data: "second" }) }),
  ).rejects.toMatchObject({ code: "EADDRINUSE" });
  expect(await callLocal(first.socketPath, { id: "one", operation: "test", params: {} })).toEqual({
    id: "one",
    ok: true,
    data: "first",
  });
  await first.close();
  const second = await listenLocal({
    runtimeDirectory,
    handler: () => ({ ok: true, data: "second" }),
  });
  cleanup.push(second.close);
  expect(await callLocal(second.socketPath, { id: "two", operation: "test", params: {} })).toEqual({
    id: "two",
    ok: true,
    data: "second",
  });
});

it("lets a complete inspection outlive the read deadline using the caller's timeout", async () => {
  const directory = await mkdtemp("/tmp/scr-inspect-");
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const { setTimeout: delay } = await import("node:timers/promises");
  const listener = await listenLocal({
    runtimeDirectory: directory,
    readTimeoutMs: 20,
    handler: async () => {
      await delay(60);
      return { ok: true, data: "inspection" };
    },
  });
  cleanup.push(listener.close);
  expect(
    await callLocal(
      listener.socketPath,
      { id: "slow", operation: "inspect", params: {} },
      { timeoutMs: 500 },
    ),
  ).toEqual({ id: "slow", ok: true, data: "inspection" });
});

it("closing the listener disconnects pending calls and signals their handlers", async () => {
  const directory = await mkdtemp("/tmp/scr-close-");
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const events = new EventEmitter();
  const entered = once(events, "entered"),
    aborted = once(events, "aborted");
  const listener = await listenLocal({
    runtimeDirectory: directory,
    handler: (request, signal) =>
      new Promise((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            events.emit("aborted");
            resolve({ ok: true, data: null });
          },
          { once: true },
        );
        events.emit("entered", request.id);
      }),
  });
  cleanup.push(listener.close);
  const result = callLocal(listener.socketPath, {
    id: "pending",
    operation: "inspect",
    params: {},
  }).catch((error) => error);
  expect(await entered).toEqual(["pending"]);
  await listener.close();
  await aborted;
  expect(await result).toBeInstanceOf(Error);
  await expect(stat(listener.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
}, 1000);

it("closes an incomplete request at the read deadline and stays available", async () => {
  const directory = await mkdtemp("/tmp/scr-read-");
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const listener = await listenLocal({
    runtimeDirectory: directory,
    readTimeoutMs: 30,
    handler: () => ({ ok: true, data: "available" }),
  });
  cleanup.push(listener.close);
  const { createConnection } = await import("node:net");
  const socket = createConnection(listener.socketPath, () => socket.write('{"id":'));
  const received: Buffer[] = [];
  socket.on("data", (chunk) => received.push(chunk));
  await once(socket, "close");
  expect(Buffer.concat(received).length).toBe(0);
  expect(
    await callLocal(listener.socketPath, { id: "next", operation: "test", params: {} }),
  ).toEqual({ id: "next", ok: true, data: "available" });
}, 1000);

it("keeps abandoned work in the admission bound until its handler actually finishes", async () => {
  const directory = await mkdtemp("/tmp/scr-admission-");
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const events = new EventEmitter();
  const entered = once(events, "entered");
  const released = once(events, "release");
  cleanup.push(async () => {
    events.emit("release");
  });
  const listener = await listenLocal({
    runtimeDirectory: directory,
    maxInFlight: 1,
    handler: async (request) => {
      if (request.id === "held") {
        events.emit("entered");
        await released;
      }
      return { ok: true, data: request.id };
    },
  });
  cleanup.push(listener.close);
  const cancel = new AbortController();
  const held = callLocal(
    listener.socketPath,
    { id: "held", operation: "test", params: {} },
    {
      signal: cancel.signal,
    },
  ).catch((error) => error);
  await entered;
  const rejected = () =>
    callLocal(listener.socketPath, {
      id: "excess",
      operation: "test",
      params: {},
    });
  expect(await rejected()).toMatchObject({
    ok: false,
    error: { code: "CAPACITY_EXCEEDED", retryable: true },
  });
  cancel.abort();
  expect(await held).toMatchObject({ code: "ABORTED" });
  expect(await rejected()).toMatchObject({
    ok: false,
    error: { code: "CAPACITY_EXCEEDED", retryable: true },
  });
  events.emit("release");
  // Yield through the handler's completion before asking for its released slot.
  await new Promise((resolve) => setImmediate(resolve));
  expect(await rejected()).toMatchObject({ ok: true, data: "excess" });
});

it("closes excess connections before reading them and accepts clients after a slot is released", async () => {
  const directory = await mkdtemp("/tmp/scr-connections-");
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const events = new EventEmitter();
  const entered = once(events, "entered");
  const released = once(events, "release");
  const disconnected = once(events, "disconnected");
  cleanup.push(async () => {
    events.emit("release");
  });
  const listener = await listenLocal({
    runtimeDirectory: directory,
    maxConnections: 1,
    handler: async (request, signal) => {
      if (request.id === "held") {
        signal.addEventListener("abort", () => events.emit("disconnected"), { once: true });
        events.emit("entered");
        await released;
      }
      return { ok: true, data: request.id };
    },
  });
  cleanup.push(listener.close);
  const first = callLocal(listener.socketPath, { id: "held", operation: "test", params: {} });
  await entered;
  await expect(
    callLocal(listener.socketPath, { id: "excess", operation: "test", params: {} }),
  ).rejects.toBeInstanceOf(Error);
  events.emit("release");
  expect(await first).toMatchObject({ ok: true, data: "held" });
  await disconnected;
  expect(
    await callLocal(listener.socketPath, { id: "next", operation: "test", params: {} }),
  ).toMatchObject({ ok: true, data: "next" });
});
