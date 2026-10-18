import { captureFixture, sourceWorker } from "./project-capture.fixture.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import { callLocal } from "@yap/client";
import { CONTROL_FRAME_BYTES, JsonLineStream, controlMessageSchema } from "@yap/protocol";
import { startProjectService } from "./project-service.js";
import { once } from "node:events";
import { Socket } from "node:net";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const fixture = captureFixture.bind(undefined, cleanup);

test("public discovery preserves native camera order and empty results without selecting an input", async () => {
  const f = await fixture(undefined, undefined, "capture.sources");
  for (const cameras of [
    [
      { cameraId: "camera-b", name: "External camera", isDefault: false },
      { cameraId: "camera-a", name: "Built-in camera", isDefault: true },
    ],
    [],
  ]) {
    const pending = f.call("capture.sources");
    const count = f.nativeCalls.length;
    await expect.poll(() => f.nativeCalls.length).toBeGreaterThan(count);
    const sources = { displays: [], windows: [], microphones: [], cameras };
    await f.reply("capture.sources", sources);
    expect(await pending).toMatchObject({ ok: true, data: sources });
  }
  expect(f.nativeCalls).toEqual(["capture.sources", "capture.sources"]);
});

test("public status preserves every native camera authorization state without capture", async () => {
  const f = await fixture(undefined, undefined, "capture.status");
  for (const camera of ["denied", "authorized", "restricted", "not_determined", "unknown"]) {
    const count = f.nativeCalls.length;
    const pending = f.call("capture.status");
    await expect.poll(() => f.nativeCalls.length).toBeGreaterThan(count);
    const device = {
      state: "idle",
      recordingId: null,
      sourceId: null,
      elapsedUs: null,
      selection: null,
      camera: null,
      permissions: { screen: true, microphone: "authorized", camera },
    };
    await f.reply("capture.status", device);
    expect(await pending).toMatchObject({ ok: true, data: { device, recording: null } });
  }
  expect(f.nativeCalls.every((operation) => operation === "capture.status")).toBe(true);
});

test("public camera selection preserves its allocated binding across native forwarding and replay", async () => {
  const f = await fixture();
  const params = {
    requestId: "camera-selection",
    source: { kind: "display", displayId: 1 },
    cameraDeviceId: "camera-a",
  };
  const started = await f.call("capture.start", params);
  expect(started).toMatchObject({ ok: true, data: { camera: { deviceId: "camera-a" } } });
  if (!started.ok) throw new Error(JSON.stringify(started));
  const recording = started.data as {
    recordingId: string;
    sourceId: string;
    camera: { sourceId: string; deviceId: string };
  };
  expect(
    f.nativeRequests.find((request) => request.operation === "capture.start")?.params,
  ).toMatchObject({
    recordingId: recording.recordingId,
    sourceId: recording.sourceId,
    cameraDeviceId: "camera-a",
    cameraSourceId: recording.camera.sourceId,
    microphone: true,
    systemAudio: false,
  });
  expect(await f.call("capture.status")).toMatchObject({
    ok: true,
    data: { device: { selection: { cameraDeviceId: "camera-a" } } },
  });
  expect(await f.call("capture.start", params)).toMatchObject({ ok: true, data: started.data });
  expect(await f.call("capture.start", { ...params, cameraDeviceId: "camera-b" })).toMatchObject({
    ok: false,
    error: { code: "REQUEST_CONFLICT" },
  });
  expect(f.nativeCalls.filter((operation) => operation === "capture.start")).toHaveLength(1);
});

test("a published primary reaches ready while its selected camera publication remains pending", async () => {
  const f = await fixture(undefined, sourceWorker);
  const started = await f.call("capture.start", {
    requestId: "independent-publication",
    source: { kind: "display", displayId: 1 },
    cameraDeviceId: "camera-a",
  });
  if (!started.ok) throw new Error(JSON.stringify(started));
  const { recordingId, sourceId, camera } = started.data as {
    recordingId: string;
    sourceId: string;
    camera: { sourceId: string };
  };
  const root = join(f.home, "library/recordings", recordingId, "source");
  const journal = JSON.stringify({ sessionID: sourceId });
  await writeFile(join(root, "source.journal.jsonl"), journal);
  await writeFile(join(root, "capture.journal.jsonl"), journal + "\nLATER_LIFECYCLE");
  await writeFile(join(root, "video.mov"), "video");
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const publication = {
    generation: "fixture-generation",
    sourceId,
    inputsClosed: true,
    primary: {
      state: "published",
      source: {
        kind: "primary",
        sourceId,
        sourceDurationUs: 100,
        originHostUs: 0,
        journal: {
          file: "source.journal.jsonl",
          bytes: Buffer.byteLength(journal),
          sha256: hash(journal),
          lastSequence: 2,
          layout: 2,
        },
        members: { "video.mov": { bytes: "5", sha256: hash("video") } },
      },
    },
    camera: {
      state: "pending",
      error: { code: "IO_ERROR", message: "Camera output held", retryable: true },
    },
  };
  expect(
    await f.report({ recordingId, sourceId, sequence: 3, state: "finalizing", publication }),
  ).toMatchObject({ ok: true });
  await expect
    .poll(() => f.call("recording.get", { recordingId }))
    .toMatchObject({
      ok: true,
      data: {
        state: "finalizing",
        sourceAdmissions: [
          { kind: "primary", sourceId, acquisitionId: expect.any(String), job: { state: "ready" } },
          {
            kind: "camera",
            sourceId: camera.sourceId,
            acquisitionId: null,
            job: null,
            publication: publication.camera,
          },
        ],
      },
    });
  const current = await f.call("recording.get", { recordingId });
  if (!current.ok) throw new Error(JSON.stringify(current));
  const acquisitionId = (current.data as { sourceAdmissions: { acquisitionId: string }[] })
    .sourceAdmissions[0]!.acquisitionId;
  expect(await f.call("acquisition.get", { acquisitionId })).toMatchObject({
    ok: true,
    data: { id: acquisitionId, sourceId },
  });
});

test("a reserved camera starts off and turns on and off in the take's control order, answering like status", async () => {
  const f = await fixture(undefined, undefined, "capture.pause");
  const started = await f.call("capture.start", {
    requestId: "camera-starts-off",
    source: { kind: "display", displayId: 1 },
    cameraDeviceId: "camera-a",
    cameraAtStart: "off",
  });
  if (!started.ok) throw new Error(JSON.stringify(started));
  const { recordingId, sourceId } = started.data as { recordingId: string; sourceId: string };
  expect(
    f.nativeRequests.find((request) => request.operation === "capture.start")?.params,
  ).toMatchObject({ cameraDeviceId: "camera-a", cameraAtStart: "off" });
  expect(await f.call("capture.status")).toMatchObject({
    ok: true,
    data: { device: { recordingId, camera: { deviceId: "camera-a", state: "off" } } },
  });
  // A toggle joins the capture control order: it waits behind a pause native has not answered.
  const paused = f.call("capture.pause", { recordingId });
  await expect.poll(() => f.nativeCalls).toContain("capture.pause");
  const turnedOn = f.call("capture.setCamera", { recordingId, on: true });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(f.nativeCalls).not.toContain("capture.setCamera");
  await f.reply("capture.pause", { recordingId, sourceId, sequence: 2, state: "paused" });
  expect(await paused).toMatchObject({ ok: true, data: { state: "paused" } });
  expect(await turnedOn).toMatchObject({
    ok: true,
    data: {
      device: { state: "paused", recordingId, camera: { deviceId: "camera-a", state: "on" } },
      recording: { recordingId, state: "paused", camera: { deviceId: "camera-a" } },
    },
  });
  expect(await f.call("capture.setCamera", { recordingId, on: false })).toMatchObject({
    ok: true,
    data: {
      device: { camera: { deviceId: "camera-a", state: "off" } },
      recording: { recordingId },
    },
  });
  expect(
    f.nativeRequests
      .filter((request) => request.operation === "capture.setCamera")
      .map((request) => request.params),
  ).toEqual([
    { recordingId, on: true },
    { recordingId, on: false },
  ]);
});

test("a camera turn-on that outlasts an ordinary native call is still answered", async () => {
  // The channel's ordinary deadline is shortened here; a cold camera start gets the operation's
  // own public budget, so native's late answer still reaches the caller.
  const f = await fixture(undefined, undefined, "capture.setCamera", 100);
  const started = await f.call("capture.start", {
    requestId: "slow-camera",
    source: { kind: "display", displayId: 1 },
    cameraDeviceId: "camera-a",
    cameraAtStart: "off",
  });
  if (!started.ok) throw new Error(JSON.stringify(started));
  const { recordingId, sourceId } = started.data as { recordingId: string; sourceId: string };
  const turnedOn = f.call("capture.setCamera", { recordingId, on: true });
  await expect.poll(() => f.nativeCalls).toContain("capture.setCamera");
  await new Promise((resolve) => setTimeout(resolve, 300));
  await f.reply("capture.setCamera", {
    state: "recording",
    recordingId,
    sourceId,
    elapsedUs: 0,
    selection: { source: { kind: "display", displayId: 1 }, cameraDeviceId: "camera-a" },
    camera: { deviceId: "camera-a", state: "on" },
    permissions: { screen: true, microphone: "authorized", camera: "authorized" },
  });
  expect(await turnedOn).toMatchObject({
    ok: true,
    data: { device: { camera: { deviceId: "camera-a", state: "on" } } },
  });
});

test("a camera toggle refuses without a reserved camera or a live take, and carries native's refusal", async () => {
  const f = await fixture();
  const started = await f.call("capture.start", {
    requestId: "camera-refusals",
    source: { kind: "display", displayId: 1 },
    cameraDeviceId: "camera-a",
    cameraAtStart: "off",
  });
  if (!started.ok) throw new Error(JSON.stringify(started));
  const { recordingId } = started.data as { recordingId: string };
  f.refuseNext("capture.setCamera", "SOURCE_UNAVAILABLE", "The camera is gone.");
  expect(await f.call("capture.setCamera", { recordingId, on: true })).toMatchObject({
    ok: false,
    error: { code: "SOURCE_UNAVAILABLE", message: "The camera is gone." },
  });
  // A failed turn-on leaves the take recording.
  expect(await f.call("recording.get", { recordingId })).toMatchObject({
    ok: true,
    data: { state: "recording" },
  });
  expect(await f.call("capture.cancel", { recordingId })).toMatchObject({
    ok: true,
    data: { state: "canceled" },
  });
  expect(await f.call("capture.setCamera", { recordingId, on: true })).toMatchObject({
    ok: false,
    error: { code: "INVALID_STATE", details: { state: "canceled" } },
  });

  const plain = await f.call("capture.start", {
    requestId: "no-camera",
    source: { kind: "display", displayId: 1 },
  });
  if (!plain.ok) throw new Error(JSON.stringify(plain));
  const screenOnly = (plain.data as { recordingId: string }).recordingId;
  expect(await f.call("capture.setCamera", { recordingId: screenOnly, on: true })).toMatchObject({
    ok: false,
    error: { code: "CAMERA_NOT_RESERVED" },
  });
  // Only the live, reserved take reached native.
  expect(f.nativeCalls.filter((operation) => operation === "capture.setCamera")).toHaveLength(1);
});

test("a take whose reserved camera never turned on completes and admits its primary", async () => {
  const f = await fixture(undefined, sourceWorker);
  const started = await f.call("capture.start", {
    requestId: "camera-never-on",
    source: { kind: "display", displayId: 1 },
    cameraDeviceId: "camera-a",
    cameraAtStart: "off",
  });
  if (!started.ok) throw new Error(JSON.stringify(started));
  const { recordingId, sourceId, camera } = started.data as {
    recordingId: string;
    sourceId: string;
    camera: { sourceId: string };
  };
  const root = join(f.home, "library/recordings", recordingId, "source");
  const journal = JSON.stringify({ sessionID: sourceId });
  await writeFile(join(root, "source.journal.jsonl"), journal);
  await writeFile(join(root, "capture.journal.jsonl"), journal);
  await writeFile(join(root, "video.mov"), "video");
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const notTurnedOn = {
    state: "unavailable",
    error: { code: "CAMERA_NOT_TURNED_ON", message: "The camera was never turned on." },
  };
  expect(await f.call("capture.stop", { recordingId })).toMatchObject({ ok: true });
  expect(
    await f.report({
      recordingId,
      sourceId,
      sequence: 3,
      state: "complete",
      sourceDurationUs: 100,
      publication: {
        generation: "never-on",
        sourceId,
        inputsClosed: true,
        primary: {
          state: "published",
          source: {
            kind: "primary",
            sourceId,
            sourceDurationUs: 100,
            originHostUs: 0,
            journal: {
              file: "source.journal.jsonl",
              bytes: Buffer.byteLength(journal),
              sha256: hash(journal),
              lastSequence: 2,
              layout: 2,
            },
            members: { "video.mov": { bytes: "5", sha256: hash("video") } },
          },
        },
        camera: notTurnedOn,
      },
    }),
  ).toMatchObject({ ok: true, data: { state: "complete" } });
  await expect
    .poll(() => f.call("recording.get", { recordingId }))
    .toMatchObject({
      ok: true,
      data: {
        state: "complete",
        sourceAdmissions: [
          { kind: "primary", sourceId, acquisitionId: expect.any(String), job: { state: "ready" } },
          {
            kind: "camera",
            sourceId: camera.sourceId,
            acquisitionId: null,
            job: null,
            publication: notTurnedOn,
          },
        ],
      },
    });
});

test("source admission failure remains discoverable through stop replay and service reopen", async () => {
  const f = await fixture();
  const started = await f.call("capture.start", {
    requestId: "failed-source",
    source: { kind: "display", displayId: 1 },
  });
  if (!started.ok) throw new Error(JSON.stringify(started));
  const { recordingId, sourceId } = started.data as { recordingId: string; sourceId: string };
  expect(await f.call("capture.stop", { recordingId })).toMatchObject({
    ok: true,
    data: { state: "finalizing" },
  });
  expect(
    await f.report({
      recordingId,
      sourceId,
      sequence: 3,
      state: "complete",
      sourceDurationUs: 100,
    }),
  ).toMatchObject({ ok: true, data: { state: "complete" } });
  await expect
    .poll(() => f.call("recording.get", { recordingId }))
    .toMatchObject({
      ok: true,
      data: {
        sourceAdmissions: [
          {
            kind: "primary",
            sourceId,
            acquisitionId: expect.any(String),
            job: { state: "failed", errorCode: "ACQUISITION_NOT_FOUND", retryable: true },
          },
        ],
      },
    });
  const failed = await f.call("recording.get", { recordingId });
  if (!failed.ok) throw new Error(JSON.stringify(failed));
  expect(await f.call("capture.stop", { recordingId })).toMatchObject({
    ok: true,
    data: failed.data,
  });
  await f.service.close();
  const reopened = await fixture(f.home);
  expect(await reopened.call("recording.get", { recordingId })).toMatchObject({
    ok: true,
    data: failed.data,
  });
});

test.each(["already-ended", "buffered EOF"])(
  "a %s private controller cannot publish or retain a fresh service",
  async (state) => {
    const home = await mkdtemp("/tmp/project-capture-ended-");
    cleanup.push(() => rm(home, { recursive: true, force: true }));
    const input = new PassThrough(),
      output = new PassThrough();
    if (state === "already-ended") {
      input.resume();
      const ended = once(input, "end");
      input.end();
      await ended;
    } else input.end();
    const start = startProjectService({
      home,
      control: { input, output },
      worker: async () => ({ ok: true, data: {} }),
    }).then((service) => {
      cleanup.push(() => service.close());
      return service;
    });
    await expect(start).rejects.toMatchObject({ code: "SERVICE_STOPPED" });
    const restarted = await fixture(home);
    expect(await restarted.call("recording.list")).toMatchObject({
      ok: true,
      data: { recordings: [] },
    });
  },
);

test("failed queue admission stays pending without read mutations and resumes from durable settlement", async () => {
  const f = await fixture();
  const started = await f.call("capture.start", {
    requestId: "admission-rollback",
    source: { kind: "display", displayId: 1 },
  });
  if (!started.ok) throw new Error(JSON.stringify(started));
  const { recordingId, sourceId } = started.data as { recordingId: string; sourceId: string };
  const database = new DatabaseSync(join(f.home, "library/catalog.sqlite"));
  cleanup.push(async () => database.close());
  database.exec(
    "CREATE TRIGGER refuse_capture_admission BEFORE INSERT ON acquisitions BEGIN SELECT RAISE(ABORT,'fixture admission refused'); END",
  );
  await f.call("capture.stop", { recordingId });
  const pending = {
    state: "complete",
    sourceAdmissions: [{ kind: "primary", sourceId, acquisitionId: null, job: null }],
  };
  expect(
    await f.report({
      recordingId,
      sourceId,
      sequence: 3,
      state: "complete",
      sourceDurationUs: 100,
    }),
  ).toMatchObject({ ok: true, data: pending });
  for (let index = 0; index < 2; index++) {
    expect(await f.call("recording.get", { recordingId })).toMatchObject({
      ok: true,
      data: pending,
    });
    expect(await f.call("recording.get")).toMatchObject({ ok: true, data: pending });
    expect(await f.call("recording.list")).toMatchObject({
      ok: true,
      data: { recordings: [pending] },
    });
  }
  expect(database.prepare("SELECT id FROM acquisitions").all()).toEqual([]);
  expect(database.prepare("SELECT jobId FROM jobs").all()).toEqual([]);
  await f.service.close();
  database.exec("DROP TRIGGER refuse_capture_admission");
  const reopened = await fixture(f.home);
  await expect
    .poll(() => reopened.call("recording.get", { recordingId }))
    .toMatchObject({
      ok: true,
      data: {
        state: "complete",
        sourceAdmissions: [
          {
            sourceId,
            acquisitionId: expect.any(String),
            job: { state: "failed", errorCode: "ACQUISITION_NOT_FOUND" },
          },
        ],
      },
    });
  expect(
    database
      .prepare("SELECT admission FROM acquisitions")
      .all()
      .map((row) => JSON.parse(row.admission as string)),
  ).toMatchObject([{ kind: "capture", recordingId, sourceId }]);
});

test("explicit source retry publishes the same acquisition and remains ready without donor files", async () => {
  const f = await fixture(undefined, sourceWorker);
  const started = await f.call("capture.start", {
    requestId: "ready-source",
    source: { kind: "display", displayId: 1 },
  });
  if (!started.ok) throw new Error(JSON.stringify(started));
  const { recordingId, sourceId } = started.data as { recordingId: string; sourceId: string };
  await f.call("capture.stop", { recordingId });
  await f.report({ recordingId, sourceId, sequence: 3, state: "complete", sourceDurationUs: 100 });
  const inspect = async () => {
    const result = await f.call("recording.get", { recordingId });
    if (!result.ok) throw new Error(JSON.stringify(result));
    return (
      result.data as {
        sourceAdmissions: {
          acquisitionId: string;
          job: { jobId: string; state: string; attemptId: string };
        }[];
      }
    ).sourceAdmissions[0]!;
  };
  await expect.poll(async () => (await inspect()).job.state).toBe("failed");
  const failed = await inspect();
  const directory = join(f.home, "library", "recordings", recordingId, "source");
  await writeFile(
    join(directory, "capture.journal.jsonl"),
    JSON.stringify({ sessionID: sourceId }),
  );
  await writeFile(join(directory, "video.mov"), "scripted source bytes");
  await f.call("capture.stop", { recordingId });
  expect(await inspect()).toEqual(failed);
  expect(await f.call("job.retry", { jobId: failed.job.jobId })).toMatchObject({ ok: true });
  await expect.poll(async () => (await inspect()).job.state).toBe("ready");
  const ready = await inspect();
  expect(ready).toMatchObject({
    acquisitionId: failed.acquisitionId,
    job: {
      jobId: failed.job.jobId,
      published: { output: { acquisitionId: failed.acquisitionId } },
    },
  });
  expect(ready.job.attemptId).not.toBe(failed.job.attemptId);
  const acquisition = await f.call("acquisition.get", { acquisitionId: ready.acquisitionId });
  expect(acquisition).toMatchObject({
    ok: true,
    data: {
      id: ready.acquisitionId,
      sourceId,
      bindings: [{ sourceRoles: ["video"], streamId: "track:1" }],
    },
  });
  await rm(directory, { recursive: true });
  await f.service.close();
  const reopened = await fixture(f.home, sourceWorker);
  expect(await reopened.call("capture.stop", { recordingId })).toMatchObject({
    ok: true,
    data: { sourceAdmissions: [ready] },
  });
  expect(
    await reopened.call("acquisition.get", { acquisitionId: ready.acquisitionId }),
  ).toMatchObject({ ok: true, data: acquisition.ok ? acquisition.data : null });
  expect(await reopened.call("project.list")).toMatchObject({ ok: true, data: { projects: [] } });
});

test("capture priority holds heavy jobs and released capacity admits a pending settled source", async () => {
  let release!: () => void, entered!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const opened = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let probes = 0;
  const f = await fixture(undefined, async (operation, params, options) => {
    if (operation === "media.probe" && ++probes === 1) {
      entered();
      await hold;
    }
    return sourceWorker(operation, params, options);
  });
  cleanup.push(async () => release());
  const started = await f.call("capture.start", {
    requestId: "capture-priority",
    source: { kind: "display", displayId: 1 },
  });
  if (!started.ok) throw new Error(JSON.stringify(started));
  const { recordingId, sourceId } = started.data as { recordingId: string; sourceId: string };
  const path = join(f.home, "background.mov");
  await writeFile(path, "scripted background bytes");
  for (let index = 0; index < 32; index++) {
    expect(await f.call("asset.import", { requestId: `background-${index}`, path })).toMatchObject({
      ok: true,
      data: { state: "queued" },
    });
  }
  expect(probes).toBe(0);
  expect(await f.call("asset.import", { requestId: "over-capacity", path })).toMatchObject({
    ok: false,
    error: { code: "CAPACITY_EXCEEDED", retryable: true },
  });
  await f.call("capture.stop", { recordingId });
  expect(
    await f.report({
      recordingId,
      sourceId,
      sequence: 3,
      state: "complete",
      sourceDurationUs: 100,
    }),
  ).toMatchObject({
    ok: true,
    data: { sourceAdmissions: [{ sourceId, acquisitionId: null, job: null }] },
  });
  await opened;
  expect(await f.call("recording.get", { recordingId })).toMatchObject({
    ok: true,
    data: { sourceAdmissions: [{ sourceId, acquisitionId: null, job: null }] },
  });
  release();
  await expect
    .poll(() => f.call("recording.get", { recordingId }), { timeout: 5000 })
    .toMatchObject({
      ok: true,
      data: {
        sourceAdmissions: [
          {
            sourceId,
            acquisitionId: expect.any(String),
            job: { state: "failed", errorCode: "ACQUISITION_NOT_FOUND" },
          },
        ],
      },
    });
});

test("private lifecycle order, cancel and no-video outcomes retain the capture owner's authority", async () => {
  const f = await fixture();
  const selection = { source: { kind: "display", displayId: 1 } };
  const started = await f.call("capture.start", { requestId: "ordered-take", ...selection });
  if (!started.ok) throw new Error(JSON.stringify(started));
  const { recordingId, sourceId } = started.data as { recordingId: string; sourceId: string };
  expect(await f.call("capture.pause", { recordingId })).toMatchObject({
    ok: true,
    data: { state: "paused", lifecycleSequence: 2, sourceAdmissions: [] },
  });
  expect(await f.report({ recordingId, sourceId, sequence: 1, state: "recording" })).toMatchObject({
    ok: true,
    data: { state: "paused", lifecycleSequence: 2 },
  });
  expect(
    await f.report({ recordingId, sourceId: "another-source", sequence: 3, state: "recording" }),
  ).toMatchObject({ ok: false, error: { code: "INVALID_STATE" } });
  expect(
    await f.call("capture.report", { recordingId, sourceId, sequence: 3, state: "recording" }),
  ).toMatchObject({ ok: false, error: { code: "UNKNOWN_OPERATION" } });
  expect(await f.call("capture.resume", { recordingId })).toMatchObject({
    ok: true,
    data: { state: "recording", lifecycleSequence: 3 },
  });
  const params = { requestId: "restart-take", recordingId, ...selection };
  const restarted = await f.call("capture.restart", params);
  expect(restarted).toMatchObject({ ok: true, data: { state: "recording", sourceAdmissions: [] } });
  if (!restarted.ok) throw new Error(JSON.stringify(restarted));
  expect(await f.call("capture.restart", params)).toMatchObject({ ok: true, data: restarted.data });
  expect(await f.call("recording.get", { recordingId })).toMatchObject({
    ok: true,
    data: { state: "canceled", sourceAdmissions: [] },
  });
  const next = restarted.data as { recordingId: string; sourceId: string };
  expect(
    await f.report({
      ...next,
      sequence: 2,
      state: "interrupted",
      reason: "NO_VIDEO",
      sourceDurationUs: null,
    }),
  ).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });
  expect(
    await f.report({
      recordingId: next.recordingId,
      sourceId: next.sourceId,
      sequence: 2,
      state: "interrupted",
      reason: "NO_VIDEO",
      sourceDurationUs: null,
    }),
  ).toMatchObject({ ok: true, data: { state: "interrupted", sourceAdmissions: [] } });
  expect(
    await f.call("recording.delete", { requestId: "test-delete", recordingId: next.recordingId }),
  ).toMatchObject({
    ok: true,
    data: { deleted: true },
  });
  expect(await f.call("recording.cleanup", { recordingId: next.recordingId })).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND" },
  });
});

test("lost public start reply reopens the same take and reconciles before publishing source admission", async () => {
  const f = await fixture();
  const params = { requestId: "lost-start-reply", source: { kind: "display", displayId: 1 } };
  await new Promise<void>((resolve, reject) => {
    const socket = new Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Lost-reply deadline"));
    }, 3000);
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("data", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });
    socket.connect(f.service.socketPath, () =>
      socket.write(JSON.stringify({ id: randomUUID(), operation: "capture.start", params }) + "\n"),
    );
  });
  const latest = await f.call("recording.get");
  if (!latest.ok) throw new Error(JSON.stringify(latest));
  const take = latest.data as { recordingId: string; sourceId: string };
  await f.service.close();
  let entered!: () => void, release!: () => void;
  const recovery = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reopened = await fixture(f.home, async (operation, request) => {
    if (operation !== "media.recover")
      throw new Error(`Unexpected recovery operation: ${operation}`);
    expect(request.sourceAuthority).toEqual({ kind: "primary", sourceId: take.sourceId });
    entered();
    await hold;
    const journal = JSON.stringify({ sessionID: take.sourceId });
    return {
      ok: true,
      data: {
        durationUs: 100,
        journal: { header: { sessionID: take.sourceId } },
        inputsClosed: true,
        sourcePublication: {
          state: "published",
          source: {
            kind: "primary",
            sourceId: take.sourceId,
            sourceDurationUs: 100,
            originHostUs: 0,
            journal: {
              file: "source.journal.jsonl",
              bytes: Buffer.byteLength(journal),
              sha256: createHash("sha256").update(journal).digest("hex"),
              lastSequence: 2,
              layout: 2,
            },
            members: {
              "video.mov": {
                bytes: "5",
                sha256: createHash("sha256").update("video").digest("hex"),
              },
            },
          },
        },
      },
    };
  });
  cleanup.push(async () => release());
  await recovery;
  expect(await reopened.call("capture.status")).toMatchObject({
    ok: true,
    data: {
      recording: { recordingId: take.recordingId, state: "finalizing", sourceAdmissions: [] },
    },
  });
  release();
  await expect
    .poll(() => reopened.call("capture.start", params))
    .toMatchObject({
      ok: true,
      data: {
        recordingId: take.recordingId,
        sourceId: take.sourceId,
        state: "interrupted",
        sourceDurationUs: 100,
        sourceAdmissions: [
          { sourceId: take.sourceId, acquisitionId: expect.any(String), job: { state: "failed" } },
        ],
      },
    });
  expect(
    await reopened.report({
      recordingId: take.recordingId,
      sourceId: take.sourceId,
      sequence: 2,
      state: "finalizing",
    }),
  ).toMatchObject({
    ok: true,
    data: {
      recordingId: take.recordingId,
      state: "interrupted",
      sourceDurationUs: 100,
    },
  });
  expect(await reopened.call("recording.list")).toMatchObject({
    ok: true,
    data: {
      recordings: [{ recordingId: take.recordingId }],
      nextCursor: null,
    },
  });
});

test("reopened recovery admits a verified primary while allocated camera recovery is held", async () => {
  const f = await fixture();
  const started = await f.call("capture.start", {
    requestId: "independent-recovery",
    source: { kind: "display", displayId: 1 },
    cameraDeviceId: "camera-a",
  });
  if (!started.ok) throw new Error(JSON.stringify(started));
  const take = started.data as {
    recordingId: string;
    sourceId: string;
    camera: { sourceId: string; deviceId: string };
  };
  await f.service.close();
  const directory = join(f.home, "library/recordings", take.recordingId, "source");
  const journal = JSON.stringify({ sessionID: take.sourceId });
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const source = {
    kind: "primary",
    sourceId: take.sourceId,
    sourceDurationUs: 100,
    originHostUs: 0,
    journal: {
      file: "source.journal.jsonl",
      bytes: Buffer.byteLength(journal),
      sha256: hash(journal),
      lastSequence: 2,
      layout: 2,
    },
    members: { "video.mov": { bytes: "5", sha256: hash("video") } },
  };
  await writeFile(join(directory, "source.journal.jsonl"), journal);
  await writeFile(join(directory, "video.mov"), "video");
  await writeFile(join(directory, "source.publication.json"), JSON.stringify(source));
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requests: Record<string, unknown>[] = [];
  const reopened = await fixture(f.home, async (operation, params, options) => {
    if (operation !== "media.recover") return sourceWorker(operation, params, options);
    requests.push(params);
    const authority = params.sourceAuthority as { kind: string };
    if (authority?.kind === "camera") {
      await hold;
      return {
        ok: true,
        data: {
          durationUs: 0,
          journal: null,
          inputsClosed: true,
          sourcePublication: {
            state: "unavailable",
            error: { code: "NO_CAMERA", message: "No recoverable camera" },
          },
        },
      };
    }
    return {
      ok: true,
      data: {
        durationUs: 100,
        journal: { header: { sessionID: take.sourceId } },
        inputsClosed: true,
        sourcePublication: { state: "published", source },
      },
    };
  });
  cleanup.push(async () => release());
  await expect.poll(() => requests).toHaveLength(2);
  // Primary and camera recover concurrently (capture.ts), so only the set of requests is fixed.
  const byKind = (value: Record<string, unknown>) =>
    (value.sourceAuthority as { kind: string }).kind === "primary" ? 0 : 1;
  expect(
    [...requests].sort((a, b) => byKind(a) - byKind(b)).map((value) => value.sourceAuthority),
  ).toEqual([
    { kind: "primary", sourceId: take.sourceId },
    {
      kind: "camera",
      sourceId: take.camera.sourceId,
      binding: { recordingId: take.recordingId, ...take.camera },
    },
  ]);
  await expect
    .poll(() => reopened.call("recording.get", { recordingId: take.recordingId }))
    .toMatchObject({
      ok: true,
      data: {
        state: "finalizing",
        publication: { inputsClosed: true, primary: { state: "published" } },
        sourceAdmissions: [
          { kind: "primary", job: { state: "ready" } },
          { kind: "camera", acquisitionId: null },
        ],
      },
    });
  release();
  await expect
    .poll(() => reopened.call("recording.get", { recordingId: take.recordingId }))
    .toMatchObject({
      ok: true,
      data: { state: "interrupted", publication: { camera: { state: "unavailable" } } },
    });
});

test("controller loss drains an unanswered native start before releasing the capture catalog", async () => {
  const f = await fixture(undefined, undefined, "capture.start");
  const start = f
    .call("capture.start", { requestId: "silent-start", source: { kind: "display", displayId: 1 } })
    .catch((error: Error) => ({ disconnected: error.message }));
  await expect.poll(() => f.nativeCalls).toContain("capture.start");
  f.input.end();
  await f.service.close();
  const answer = await start;
  expect("disconnected" in answer || !answer.ok).toBe(true);
  const reopened = await fixture(f.home, async (operation) => {
    expect(operation).toBe("media.recover");
    return {
      ok: true,
      data: {
        durationUs: 0,
        journal: null,
        inputsClosed: true,
        sourcePublication: {
          state: "unavailable",
          error: {
            code: "NO_SOURCE_MEDIA",
            message: "Allocated source directory contains no retained members.",
          },
        },
      },
    };
  });
  await expect
    .poll(() => reopened.call("recording.get"))
    .toMatchObject({
      ok: true,
      data: {
        state: "interrupted",
        sourceDurationUs: null,
        sourceAdmissions: [
          {
            kind: "primary",
            acquisitionId: null,
            job: null,
            publication: { state: "unavailable", error: { code: "NO_SOURCE_MEDIA" } },
          },
        ],
      },
    });
});

test("an explicit-import namespace collision refuses source admission without hiding completed capture facts", async () => {
  const f = await fixture(undefined, sourceWorker);
  const params = { requestId: "collision-take", source: { kind: "display", displayId: 1 } };
  const started = await f.call("capture.start", params);
  if (!started.ok) throw new Error(JSON.stringify(started));
  const { recordingId, sourceId } = started.data as { recordingId: string; sourceId: string };
  const path = join(f.home, "explicit-source");
  await mkdir(path);
  await writeFile(
    join(path, "capture.journal.jsonl"),
    JSON.stringify({ sessionID: "explicit-source" }),
  );
  await writeFile(join(path, "video.mov"), "explicit source bytes");
  const imported = await f.call("acquisition.import", { requestId: `capture:${sourceId}`, path });
  if (!imported.ok) throw new Error(JSON.stringify(imported));
  const explicit = imported.data as { jobId: string; target: { acquisitionId: string } };
  await f.call("capture.stop", { recordingId });
  const capture = {
    recordingId,
    sourceId,
    state: "complete",
    sourceAdmissions: [
      {
        kind: "primary",
        sourceId,
        acquisitionId: null,
        job: null,
        admissionError: { code: "REQUEST_CONFLICT", retryable: false },
      },
    ],
  };
  expect(
    await f.report({
      recordingId,
      sourceId,
      sequence: 3,
      state: "complete",
      sourceDurationUs: 100,
    }),
  ).toMatchObject({ ok: true, data: capture });
  expect(await f.call("recording.get", { recordingId })).toMatchObject({ ok: true, data: capture });
  expect(await f.call("recording.get")).toMatchObject({ ok: true, data: capture });
  expect(await f.call("recording.list")).toMatchObject({
    ok: true,
    data: { recordings: [capture] },
  });
  expect(await f.call("capture.stop", { recordingId })).toMatchObject({ ok: true, data: capture });
  await expect
    .poll(() => f.call("job.get", { jobId: explicit.jobId }))
    .toMatchObject({
      ok: true,
      data: {
        state: "ready",
        published: { output: { acquisitionId: explicit.target.acquisitionId } },
      },
    });
  expect(
    await f.call("acquisition.get", { acquisitionId: explicit.target.acquisitionId }),
  ).toMatchObject({ ok: true, data: { sourceId: "explicit-source" } });
  await f.service.close();
  const reopened = await fixture(f.home, sourceWorker);
  expect(await reopened.call("capture.start", params)).toMatchObject({ ok: true, data: capture });
});

test("fresh capture allocates and replays through its private controller without editorial state", async () => {
  const home = await mkdtemp("/tmp/project-capture-");
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const input = new PassThrough();
  const output = new PassThrough();
  const frames = new JsonLineStream(CONTROL_FRAME_BYTES);
  let starts = 0;
  let outputDirectory: unknown;
  output.on("data", (chunk: Buffer) => {
    for (const value of frames.push(chunk)) {
      if (!value.ok) throw value.error;
      const message = controlMessageSchema.parse(value.value);
      if (message.event !== "call") continue;
      expect(message.request.operation).toBe("capture.start");
      starts++;
      const { recordingId, sourceId } = message.request.params;
      outputDirectory = message.request.params.outputDirectory;
      input.write(
        JSON.stringify({
          event: "result",
          response: {
            id: message.request.id,
            ok: true,
            data: { recordingId, sourceId, sequence: 1, state: "recording" },
          },
        }) + "\n",
      );
    }
  });
  const service = await startProjectService({
    home,
    control: { input, output },
    worker: async (operation) => {
      if (operation === "storage.clearRenderWorkspace")
        return { ok: true, data: { removed: true } };
      if (operation === "media.audioCapabilities") return { ok: true, data: {} };
      throw new Error(`Unexpected worker operation: ${operation}`);
    },
  });
  cleanup.push(() => service.close());
  const params = {
    requestId: "capture-replay",
    source: { kind: "display", displayId: 1 },
    microphone: false,
    systemAudio: false,
  };
  const call = (operation: string, params: Record<string, unknown>) =>
    callLocal(service.socketPath, { id: randomUUID(), operation, params });
  const started = await call("capture.start", params);
  expect(started).toMatchObject({
    ok: true,
    data: {
      state: "recording",
      lifecycleSequence: 1,
      sourceDurationUs: null,
    },
  });
  expect(outputDirectory).toBe(
    join(
      home,
      "library",
      "recordings",
      (started.ok ? (started.data as { recordingId: string }) : { recordingId: "" }).recordingId,
      "source",
    ),
  );
  expect(await call("capture.start", params)).toMatchObject({
    ok: true,
    data: started.ok ? started.data : null,
  });
  expect(starts).toBe(1);
  expect(
    await call("capture.start", { ...params, cameraDeviceId: "changed-camera" }),
  ).toMatchObject({
    ok: false,
    error: { code: "REQUEST_CONFLICT" },
  });
  const before = await call("storage.usage", {});
  if (!before.ok) throw new Error(JSON.stringify(before));
  await writeFile(join(String(outputDirectory), "video.mov"), "capture bytes");
  expect(await call("storage.usage", {})).toMatchObject({
    ok: true,
    data: {
      totalBytes: (before.data as { totalBytes: number }).totalBytes + 13,
      sharedBytes: (before.data as { sharedBytes: number }).sharedBytes + 13,
    },
  });
  await service.close();
  const database = new DatabaseSync(join(home, "library/catalog.sqlite"), { readOnly: true });
  try {
    expect(database.prepare("SELECT state FROM recordings").all()).toEqual([
      { state: "recording" },
    ]);
    expect(database.prepare("SELECT projectId FROM projects").all()).toEqual([]);
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE name IN ('revisions','edit_requests','undo_stack')",
        )
        .all(),
    ).toEqual([]);
  } finally {
    database.close();
  }
});

test("unpublished raw camera recovery receives its byte-scaled materialization budget", async () => {
  const budgets: number[] = [];
  for (const bytes of [4096, 2 ** 30]) {
    const f = await fixture();
    const started = await f.call("capture.start", {
      requestId: "raw-camera-budget",
      source: { kind: "display", displayId: 1 },
      cameraDeviceId: "camera-a",
    });
    if (!started.ok) throw new Error(JSON.stringify(started));
    const take = started.data as { recordingId: string };
    await f.service.close();
    const directory = join(f.home, "library/recordings", take.recordingId, "camera");
    await mkdir(directory, { recursive: true });
    const raw = await open(join(directory, "camera.raw.mov"), "w+");
    await raw.truncate(bytes);
    await raw.close();
    await writeFile(join(directory, "camera.closed.json"), "{}");
    const reopened = await fixture(f.home, async (operation, params, options) => {
      if (operation !== "media.recover") return sourceWorker(operation, params, options);
      const camera = (params.sourceAuthority as { kind: string }).kind === "camera";
      const budget = options?.timeoutMs ?? 30000;
      if (camera) budgets.push(budget);
      // Simulated materialization needs one minute; the test never waits that long.
      if (camera && budget < 60000)
        return {
          ok: false,
          error: {
            code: "TIMEOUT",
            message: "Raw materialization exhausted budget",
            details: {},
            retryable: true,
          },
        };
      return {
        ok: true,
        data: {
          durationUs: 0,
          journal: null,
          inputsClosed: true,
          sourcePublication: {
            state: "unavailable",
            error: { code: "NO_SOURCE", message: "No recoverable support" },
          },
        },
      };
    });
    await expect
      .poll(() => reopened.call("recording.get", { recordingId: take.recordingId }))
      .toMatchObject({
        ok: true,
        data: {
          state: "interrupted",
          publication: {
            inputsClosed: true,
            camera: { state: "unavailable", error: { code: "NO_SOURCE" } },
          },
        },
      });
    await reopened.service.close();
  }
  expect(budgets[1]).toBeGreaterThan(budgets[0]!);
});
