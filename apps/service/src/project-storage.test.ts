import { afterEach, expect, test, vi } from "vitest";
import * as filesystem from "node:fs/promises";
import { mkdir, mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { callLocal } from "@yap/client";
import { startProjectService } from "./project-service.js";
import { projectServiceControlFixture } from "./project-service.fixture.js";
import { once } from "node:events";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup() {
  const home = await mkdtemp(join(tmpdir(), "project-storage-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  const service = await startProjectService({
    home,
    worker: async (operation) => {
      if (operation === "media.audioCapabilities") return { ok: true, data: {} };
      if (operation === "storage.clearRenderWorkspace")
        return { ok: true, data: { removed: true } };
      throw Error(`Storage inspection must not start media work: ${operation}`);
    },
  });
  cleanups.push(() => service.close());
  return {
    home,
    service,
    call: (operation: string, params: Record<string, unknown>) =>
      callLocal(service.socketPath, { id: "storage", operation, params }),
  };
}

test("aggregate project-library storage reports live managed bytes including model storage", async () => {
  const f = await setup();
  const first = await f.call("storage.usage", {});
  expect(first.ok).toBe(true);
  if (!first.ok) throw Error(first.error.message);
  const baseline = first.data as { totalBytes: number; sharedBytes: number };
  for (const [path, bytes] of [
    ["assets/unpublished.bin", 11],
    ["acquisitions/retained/journal.jsonl", 13],
    ["staging/prepared-audio/unfinished.wav", 17],
    ["models/weights.bin", 1000],
    ["models/.cache/parakeet/compiler.bin", 7],
    ["models/.staging/parakeet/flight/model.bin", 9],
  ] as const) {
    const file = join(f.home, "library", path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, Buffer.alloc(bytes));
  }
  await writeFile(join(f.home, "donor.bin"), Buffer.alloc(2000));
  const result = await f.call("storage.usage", {});
  expect(result.ok).toBe(true);
  if (!result.ok) throw Error(result.error.message);
  expect(result.data).toMatchObject({
    recordingId: null,
    measurement: "live",
    totalBytes: baseline.totalBytes + 1057,
    sharedBytes: baseline.sharedBytes + 41,
    modelBytes: 1016,
    sourceBytes: 0,
    evidenceBytes: 0,
  });
  expect(await f.call("storage.usage", { recordingId: "old-recording" })).toMatchObject({
    ok: false,
    error: { code: "INVALID_PARAMS" },
  });
  expect(await f.call("storage.usage", { projectId: "unrequested-scope" })).toMatchObject({
    ok: false,
    error: { code: "INVALID_PARAMS" },
  });
});

test("public shutdown aborts and drains a held library scan before releasing its file", async () => {
  const f = await setup();
  const path = join(f.home, "library", "assets", "held.bin");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.alloc(3));
  await writeFile(join(dirname(path), "next.bin"), Buffer.alloc(5));
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let entered!: () => void, release!: () => void;
  const opened = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const canonicalDirectory = await realpath(dirname(path));
  let stopping = false;
  let readsAfterStop = 0;
  let descriptor: Awaited<ReturnType<typeof actual.open>> | undefined;
  vi.mocked(filesystem.open).mockImplementation(async (file, flags, mode) => {
    const handle = await actual.open(file, flags, mode);
    if (stopping) readsAfterStop++;
    if (String(file).startsWith(canonicalDirectory + "/") && descriptor === undefined) {
      descriptor = handle;
      entered();
      await held;
    }
    return handle;
  });
  const observation = f.call("storage.usage", {});
  void observation.catch(() => {});
  let stopped = false;
  let closing: Promise<void> | undefined;
  try {
    await opened;
    stopping = true;
    closing = f.service.close().then(() => {
      stopped = true;
    });
    await setImmediate();
    expect(stopped).toBe(false);
  } finally {
    release();
    await closing;
    vi.mocked(filesystem.open).mockImplementation(actual.open);
  }
  await expect(observation).rejects.toMatchObject({ code: "TRUNCATED_FRAME" });
  expect(readsAfterStop).toBe(0);
  expect(stopped).toBe(true);
  await expect(descriptor!.stat()).rejects.toMatchObject({ code: "EBADF" });
});

test("a disconnected storage observation remains a blocker until its descriptor settles", async () => {
  const f = await projectServiceControlFixture(cleanups, async () => {
    throw Error("Storage must not execute media");
  });
  const path = join(f.home, "library/assets/held.bin");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "managed bytes");
  const directory = await realpath(dirname(path));
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  cleanups.push(async () => {
    release();
  });
  let descriptor: Awaited<ReturnType<typeof actual.open>> | undefined;
  vi.mocked(filesystem.open).mockImplementation(async (file, flags, mode) => {
    const handle = await actual.open(file, flags, mode);
    if (String(file).startsWith(directory + "/") && !descriptor) {
      descriptor = handle;
      enter();
      await held;
    }
    return handle;
  });
  const canceled = new AbortController();
  const observation = callLocal(
    f.service.socketPath,
    { id: "scan", operation: "storage.usage", params: {} },
    { signal: canceled.signal },
  ).catch((error) => error);
  await entered;
  canceled.abort();
  expect(await observation).toMatchObject({ code: "ABORTED" });
  expect(await f.control("update.prepare")).toMatchObject({
    ok: true,
    data: { kind: "blocked", blockers: expect.arrayContaining(["storage"]) },
  });
  const progress = once(f.events, "update.progress");
  release();
  await progress;
  await expect(descriptor!.stat()).rejects.toMatchObject({ code: "EBADF" });
  expect(await f.control("update.prepare")).toMatchObject({ ok: true, data: { kind: "prepared" } });
});
