import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm, readFile, readdir, open } from "node:fs/promises";
import { listenLocal } from "@yap/service";
import { operationError, type OperationResponse } from "@yap/protocol";
import { artifactBytes, consumeBatch, artifactFile } from "./artifact-delivery.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture(
  bytes: Buffer,
  malformed: boolean | number = false,
  mediaType: "image/png" | "audio/wav" | "video/mp4" | "application/json" = "image/png",
  onRead: () => void = () => {},
) {
  const runtimeDirectory = await mkdtemp("/tmp/scr-delivery-client-");
  let closes = 0;
  let reads = 0;
  let renewals = 0;
  const listener = await listenLocal({
    runtimeDirectory,
    handler: async (request) => {
      if (request.operation === "artifact.close") {
        closes++;
        return { ok: true, data: { closed: true } };
      }
      if (request.operation === "artifact.renew") {
        renewals++;
        return {
          ok: true,
          data: { token: "lease", sizeBytes: bytes.length, expiresAtMs: Date.now() + 30000 },
        };
      }
      onRead();
      reads++;
      const { offsetBytes: offset, maxBytes } = request.params as {
        offsetBytes: number;
        maxBytes: number;
      };
      const part = bytes.subarray(offset, offset + maxBytes);
      return {
        ok: true,
        data: {
          offsetBytes: offset,
          nextOffsetBytes:
            malformed === true || malformed === reads ? offset : offset + part.length,
          eof: offset + part.length === bytes.length,
          data: part.toString("base64"),
        },
      };
    },
  });
  cleanups.push(async () => {
    await listener.close();
    await rm(runtimeDirectory, { recursive: true, force: true });
  });
  const result: OperationResponse = {
    id: "frame",
    ok: true,
    data: {
      state: "ready",
      delivery: { token: "lease", sizeBytes: bytes.length, expiresAtMs: Date.now() + 30000 },
      published: { generation: "1", output: { mediaType }, issues: [] },
    },
  };
  return {
    result,
    selection: { socketPath: listener.socketPath },
    reads: () => reads,
    renewals: () => renewals,
    closes: () => closes,
  };
}

test("the image transport assembles bytes larger than one metadata response and releases its delivery", async () => {
  const bytes = Buffer.alloc(9 * 1024 * 1024 + 17);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const f = await fixture(bytes);
  expect((await artifactBytes(f.selection, f.result))?.bytes.equals(bytes)).toBe(true);
  expect(f.reads()).toBeGreaterThan(1);
  expect(f.closes()).toBe(1);
});

test("a nonadvancing chunk fails immediately and still releases the delivery", async () => {
  const f = await fixture(Buffer.from("evidence"), true);
  await expect(artifactBytes(f.selection, f.result)).rejects.toMatchObject({
    code: "INVALID_RESPONSE",
  });
  expect(f.reads()).toBe(1);
  expect(f.closes()).toBe(1);
});

test("audio payloads can exceed the image limit while preserving type and bytes", async () => {
  const bytes = Buffer.alloc(33 * 1024 * 1024 + 3, 0x71);
  const f = await fixture(bytes, false, "audio/wav");
  const media = await artifactBytes(f.selection, f.result);
  expect(media?.mediaType).toBe("audio/wav");
  expect(media?.bytes.equals(bytes)).toBe(true);
  expect(f.closes()).toBe(1);
});

test("an oversized image is refused before reading and its lease is released", async () => {
  const f = await fixture(Buffer.alloc(33 * 1024 * 1024));
  await expect(artifactBytes(f.selection, f.result)).rejects.toMatchObject({
    code: "LIMIT_EXCEEDED",
  });
  expect(f.reads()).toBe(0);
  expect(f.closes()).toBe(1);
});

test("timestamp batches preserve timestamp identity on failed media reads", async () => {
  const f = await fixture(Buffer.from("evidence"), true);
  const result = await consumeBatch(
    f.selection,
    {
      id: "time",
      ok: true,
      data: {
        projectId: "project",
        revisionId: "r2",
        items: [{ atUs: 42, ok: true, data: f.result.ok ? f.result.data : null }],
      },
    },
    "atUs",
    async () => ({}),
    (error) => operationError((error as { code: string }).code, (error as Error).message).error,
  );
  expect(result).toEqual({
    id: "time",
    ok: true,
    data: {
      projectId: "project",
      revisionId: "r2",
      items: [
        {
          atUs: 42,
          ok: false,
          error: {
            code: "INVALID_RESPONSE",
            message: "Media chunk does not advance within the delivery",
            retryable: true,
            details: {},
          },
        },
      ],
    },
  });
  expect(f.closes()).toBe(1);
});

test("selected batch metadata cannot masquerade as timestamp batch metadata", async () => {
  const f = await fixture(Buffer.from("unused"));
  await expect(
    consumeBatch(
      f.selection,
      {
        id: "wrong",
        ok: true,
        data: {
          projectId: "project",
          revisionId: "r1",
          generation: "index",
          items: [{ atUs: 0, ok: true, data: { state: "running" } }],
        },
      },
      "ordinal",
      async () => ({}),
      () => ({ code: "UNEXPECTED", message: "unexpected", retryable: false, details: {} }),
    ),
  ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  expect(f.reads()).toBe(0);
});

test.each([
  { owner: "recording", data: { recordingId: "recording" } },
  { owner: "package", data: { packageHandle: "package" } },
])("$owner-owned timestamp batches are rejected before media reads", async ({ owner, data }) => {
  const f = await fixture(Buffer.from("unused"));
  await expect(
    consumeBatch(
      f.selection,
      {
        id: `legacy-${owner}`,
        ok: true,
        data: {
          ...data,
          revisionId: "r1",
          items: [{ atUs: 0, ok: true, data: f.result.ok ? f.result.data : null }],
        },
      },
      "atUs",
      async () => ({}),
      () => ({ code: "UNEXPECTED", message: "unexpected", retryable: false, details: {} }),
    ),
  ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  expect(f.reads()).toBe(0);
  expect(f.closes()).toBe(0);
});

test.each(["video/mp4", "audio/wav"] as const)(
  "large %s media streams to an exclusive output",
  async (mediaType) => {
    const bytes = Buffer.alloc(49 * 1024 * 1024 + 17, 0x5d);
    const f = await fixture(bytes, false, mediaType);
    const directory = await mkdtemp("/tmp/yap-preview-delivery-");
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const output = directory + "/preview.mp4";
    if (mediaType === "audio/wav") {
      expect(await artifactBytes(f.selection, f.result)).toBeNull();
      expect(f.reads()).toBe(0);
      expect(f.closes()).toBe(0);
    }
    expect(await artifactFile(f.selection, f.result, output)).toEqual({
      output,
      sizeBytes: bytes.length,
      mediaType,
    });
    expect((await readFile(output)).equals(bytes)).toBe(true);
    expect(f.reads()).toBeGreaterThan(1);
    expect(f.closes()).toBe(1);
    await expect(artifactFile(f.selection, f.result, output)).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect((await readFile(output)).equals(bytes)).toBe(true);
  },
);

test("a failed streamed read leaves no output or partial staging and releases its lease", async () => {
  const f = await fixture(Buffer.alloc(512 * 1024 + 17, 0x6d), 2, "video/mp4");
  const directory = await mkdtemp("/tmp/yap-preview-failure-");
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  await expect(
    artifactFile(f.selection, f.result, directory + "/preview.mp4"),
  ).rejects.toMatchObject({
    code: "INVALID_RESPONSE",
  });
  expect(await readdir(directory)).toEqual([]);
  expect(f.closes()).toBe(1);
});

test("streaming renews the same delivery beyond its original expiry", async () => {
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const bytes = Buffer.alloc(5 * 512 * 1024, 0x27);
  const f = await fixture(bytes, false, "audio/wav", () => {
    now += 9000;
  });
  const directory = await mkdtemp("/tmp/yap-renew-delivery-");
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const output = directory + "/full.wav";
  await artifactFile(f.selection, f.result, output);
  expect((await readFile(output)).equals(bytes)).toBe(true);
  expect(f.renewals()).toBe(1);
  expect(f.closes()).toBe(1);
});

test("waveform JSON streams unchanged and uses bounded buffered delivery with lease cleanup", async () => {
  const bytes = Buffer.from(
    JSON.stringify({ buckets: [{ channels: [{ min: -0.25, max: 0.5, rms: 0.3 }] }] }),
  );
  const f = await fixture(bytes, false, "application/json");
  expect(await artifactBytes(f.selection, f.result)).toEqual({
    bytes,
    mediaType: "application/json",
  });
  const folder = await mkdtemp("/tmp/scr-waveform-delivery-");
  cleanups.push(() => rm(folder, { recursive: true, force: true }));
  const output = folder + "/waveform.json";
  expect(await artifactFile(f.selection, f.result, output)).toEqual({
    output,
    sizeBytes: bytes.length,
    mediaType: "application/json",
  });
  expect(await readFile(output)).toEqual(bytes);
  expect(f.closes()).toBe(2);
  const oversized = await fixture(Buffer.alloc(4 * 1024 ** 2 + 1), false, "application/json");
  await expect(artifactBytes(oversized.selection, oversized.result)).rejects.toMatchObject({
    code: "LIMIT_EXCEEDED",
  });
  expect(oversized.reads()).toBe(0);
  expect(oversized.closes()).toBe(1);
});

test("invalid JSON evidence fails as a delivery error and releases its lease", async () => {
  const f = await fixture(Buffer.from('{"buckets":'), false, "application/json");
  await expect(artifactBytes(f.selection, f.result)).rejects.toMatchObject({
    code: "INVALID_RESPONSE",
  });
  expect(f.closes()).toBe(1);
});

test("invalid JSON evidence never publishes a final output file", async () => {
  const f = await fixture(Buffer.from('{"measurement":'), false, "application/json");
  const directory = await mkdtemp("/tmp/yap-invalid-json-");
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  await expect(
    artifactFile(f.selection, f.result, `${directory}/evidence.json`),
  ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  expect(await readdir(directory)).toEqual([]);
  expect(f.closes()).toBe(1);
});

test("cancellation during file synchronization refuses final publication and drains staging", async () => {
  const f = await fixture(Buffer.from("{}"), false, "application/json");
  const directory = await mkdtemp("/tmp/yap-sync-cancel-");
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const probe = await open(`${directory}/probe`, "wx");
  const prototype = Object.getPrototypeOf(probe);
  const sync = prototype.sync;
  await probe.close();
  await rm(`${directory}/probe`);
  const controller = new AbortController();
  vi.spyOn(prototype, "sync").mockImplementation(async function (this: typeof probe) {
    await sync.call(this);
    controller.abort();
  });
  await expect(
    artifactFile(
      { ...f.selection, signal: controller.signal },
      f.result,
      `${directory}/evidence.json`,
    ),
  ).rejects.toMatchObject({ code: "ABORTED" });
  expect(await readdir(directory)).toEqual([]);
  expect(f.closes()).toBe(1);
});
