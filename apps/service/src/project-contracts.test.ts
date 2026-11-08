import { createServer, createConnection, type Socket } from "node:net";
import { once } from "node:events";
import { chmod, mkdir, writeFile, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import { parakeetModel } from "@yap/core/models";
import type { SpeechTranscriptionRequest } from "@yap/core/transcript";
import type { SourceTranscriptRow } from "@yap/core/transcript-read";
import { callLocal } from "@yap/client";
import { REQUEST_FRAME_BYTES, type OperationRequest, type OperationResponse } from "@yap/protocol";
import { projectServiceFixture } from "./project-service.fixture.js";
import { publishControlledObservation, speakerSource } from "./speaker.fixture.js";
import { controlledSpeech, modelMetadata } from "./transcript.fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function save(name: string, value: unknown) {
  const directory = process.env.YAP_CONTRACT_TEST_OUTPUT;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name}.json`), JSON.stringify(value, null, 2) + "\n");
}
const canvas = {
  width: 16,
  height: 16,
  fps: { numerator: 30, denominator: 1 },
  background: "#000000ff",
};
async function emptyProject() {
  const f = await projectServiceFixture(cleanups, async (operation) => {
    throw new Error(`Unexpected worker operation: ${operation}`);
  });
  const created = await f.call("project.create", { requestId: "create", canvas });
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error(created.error.message);
  const { project, revision } = created.data as {
    project: { id: string };
    revision: { id: string };
  };
  const request = {
    id: "resize",
    operation: "edit.apply",
    params: {
      projectId: project.id,
      requestId: "resize",
      expectedRevisionId: revision.id,
      operations: [{ operation: "canvas.set", canvas: { ...canvas, width: 32 } }],
    },
  };
  const db = new DatabaseSync(join(f.home, "library", "catalog.sqlite"));
  cleanups.push(async () => db.close());
  async function state() {
    return {
      project: await f.call("project.get", { projectId: project.id }),
      history: await f.call("revision.history", { projectId: project.id }),
      requests: db
        .prepare("SELECT * FROM project_requests WHERE projectId=? ORDER BY requestId")
        .all(project.id),
    };
  }
  return { ...f, project, revision, request, state };
}

test("inspect, caption proposal and layout diagnostics stay pinned and read-only", async () => {
  const f = await emptyProject();
  const before = await f.state();
  const opened = await f.call("inspect.open", {
    projectId: f.project.id,
    revisionId: f.revision.id,
    range: { startUs: 0, endUs: 1 },
  });
  expect(opened).toMatchObject({
    ok: true,
    data: {
      projectId: f.project.id,
      headRevisionId: f.revision.id,
      revision: { id: f.revision.id },
      history: [{ id: f.revision.id, ordinal: 0 }],
      native: { opened: false },
    },
  });
  const proposed = await f.call("caption.propose", {
    projectId: f.project.id,
    revisionId: f.revision.id,
    trackId: "captions",
    canvas: { width: 100, height: 100 },
    style: {
      font: { assetId: "font", postScriptName: "Fixture" },
      width: 100,
      height: 100,
      size: 20,
      color: "#ffffffff",
      alignment: "left",
      wrap: true,
    },
    constraints: {
      widthGraphemes: 30,
      maxLines: 2,
      minDwellUs: 1,
      maxDwellUs: 100,
      maxCps: 30,
      pauseUs: 1,
      breakOnPunctuation: true,
      separator: " ",
      safeArea: { x: 0, y: 0, width: 100, height: 100 },
    },
  });
  expect(proposed).toMatchObject({ ok: false, error: { code: "NOT_READY" } });
  const diagnostics = await f.call("layout.diagnostics", {
    projectId: f.project.id,
    revisionId: f.revision.id,
    samples: [
      {
        atUs: 0,
        canvas: { width: 100, height: 100 },
        texts: [{ id: "caption", bounds: { x: 99, y: 0, width: 5, height: 5 } }],
      },
    ],
  });
  expect(diagnostics.ok).toBe(true);
  if (diagnostics.ok) {
    expect(diagnostics.data).toMatchObject({ revisionId: f.revision.id });
    const data = diagnostics.data as { issues: { code: string }[] };
    expect(data.issues.map((issue) => issue.code)).toContain("text-off-canvas");
  }
  expect(await f.state()).toEqual(before);
  expect(
    await f.call("inspect.open", { projectId: f.project.id, revisionId: "missing" }),
  ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
});
async function sendRaw(socketPath: string, bytes: Buffer) {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(socketPath, () => socket.write(bytes));
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Framing refusal did not close socket"));
    }, 1000);
    socket.resume();
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
test("public rendered recognition rejects absent generations and refuses a range wholly outside the project before any job", async () => {
  const f = await emptyProject();
  const selector = { projectId: f.project.id, revisionId: f.revision.id };
  expect(
    await f.call("transcript.render.get", {
      ...selector,
      generation: "c6df7efc-a023-4c40-aa08-3b8b1c0b1b90",
    }),
  ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  const request = {
    ...selector,
    range: { startUs: 0, endUs: 1000000 },
    tap: { target: { kind: "output" }, point: { kind: "processed" } },
    rendition: { sampleRate: 16000, channels: 1 },
  };
  expect(await f.call("transcript.render.prepare", request)).toMatchObject({
    ok: false,
    error: {
      code: "INVALID_RANGE",
      details: { requested: { startUs: 0, endUs: 1000000 }, bounds: { startUs: 0, endUs: 0 } },
    },
  });
  const db = new DatabaseSync(join(f.home, "library", "catalog.sqlite"));
  cleanups.push(async () => db.close());
  expect(db.prepare("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 0 });
});
function pcmWave(frames: number, sampleRate: number, channels: number) {
  const bytes = Buffer.alloc(44 + frames * channels * 4);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(3, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * channels * 4, 28);
  bytes.writeUInt16LE(channels * 4, 32);
  bytes.writeUInt16LE(32, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}
/**
 * One project with a placed audio clip, rendered by a controlled native edge: the project mix, the
 * PCM conversion and recognition each answer like the native worker, and `fail` names the one
 * native operation whose first attempt fails.
 */
async function renderedRecognition(fail: "media.mixCompositionAudio" | "speech.transcribe") {
  const calls: string[] = [];
  let failing = true,
    probes = 0;
  const speech = controlledSpeech([], [], [{ text: "rendered", startUs: 100_000, endUs: 400_000 }]);
  const audio = (sampleRate: number, channels: number, endUs: number) => ({
    id: "audio",
    kind: "audio",
    codec: "pcm",
    decodable: true,
    sampleRate,
    channels,
    startUs: 0,
    endUs,
    segments: [{ startUs: 0, endUs, empty: false }],
  });
  const f = await projectServiceFixture(cleanups, async (operation, params, options) => {
    calls.push(operation);
    if (operation === fail && failing) {
      failing = false;
      return {
        ok: false,
        error: {
          code: "MEDIA_WORKER_FAILED",
          message: "controlled failure",
          retryable: true,
          details: {},
        },
      };
    }
    // The first probe admits the source; later probes admit the converted PCM rendition.
    if (operation === "media.probe")
      return {
        ok: true,
        data: {
          originUs: 0,
          streams: [probes++ === 0 ? audio(48000, 2, 2_000_000) : audio(16000, 1, 1_000_000)],
        },
      };
    if (operation === "media.mixCompositionAudio") {
      const { output, range, clips } = params as {
        output: string;
        range: { start: number; end: number };
        clips: { clipId: string }[];
      };
      const frames = range.end - range.start;
      const bytes = pcmWave(frames, 48000, 2);
      await writeFile(output, bytes);
      return {
        ok: true,
        data: {
          file: output,
          bytes: bytes.length,
          sampleRate: 48000,
          channels: 2,
          frames,
          peak: 0,
          clippedSamples: 0,
          maximumBlockFrames: 1024,
          peakResidentBytes: 0,
          decoderContext: {
            policy: "bounded-current-retained-run",
            sampleRate: 48000,
            maximumPrerollFrames: 0,
            maximumTailFrames: 0,
          },
          unavailable: clips.map(({ clipId }) => ({ clipId, ranges: [] })),
        },
      };
    }
    if (operation === "media.convertSelectedAudio") {
      const { source, output, sampleRate, channels } = params as {
        source: string;
        output: string;
        sampleRate: number;
        channels: number;
      };
      // Like the native converter, the selected input's dimensions come from its WAV header.
      const selected = await readFile(source);
      const input = {
        sampleRate: selected.readUInt32LE(24),
        channels: selected.readUInt16LE(22),
        frames: (selected.length - 44) / (selected.readUInt16LE(22) * 4),
      };
      const frames = (input.frames * sampleRate) / input.sampleRate;
      const bytes = pcmWave(frames, sampleRate, channels);
      await writeFile(output, bytes);
      return {
        ok: true,
        data: {
          file: output,
          mediaType: "audio/wav",
          bytes: bytes.length,
          implementationId: "native-finite-pcm-v2",
          input,
          output: { frames, sampleRate, channels },
          channelPolicy: "equal-weight-double-rounded-float32",
          contextPolicy: "complete-selected-pcm-zero-origin",
        },
      };
    }
    return speech(operation, params, options);
  });
  await modelMetadata(await realpath(join(f.home, "library")));
  const imported = await f.call("asset.import", { requestId: "speech", path: f.path });
  if (!imported.ok) throw new Error(JSON.stringify(imported));
  const assetId = (await f.job((imported.data as { jobId: string }).jobId, "ready")).published!
    .output.assetId;
  const created = await f.call("project.create", { requestId: "rendered", canvas });
  if (!created.ok) throw new Error(JSON.stringify(created));
  const initial = created.data as {
    project: { id: string };
    revision: { id: string };
  };
  const edited = await f.call("edit.apply", {
    projectId: initial.project.id,
    expectedRevisionId: initial.revision.id,
    requestId: "place",
    operations: [
      { operation: "track.add", track: { kind: "audio", order: 0 }, label: "dialogue" },
      {
        operation: "place",
        clip: {
          trackId: { label: "dialogue" },
          assetId,
          streamId: "audio",
          source: { kind: "range", range: { startUs: 0, endUs: 1_000_000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 1_000_000 } },
        },
      },
    ],
  });
  if (!edited.ok) throw new Error(JSON.stringify(edited));
  const request = {
    projectId: initial.project.id,
    revisionId: (edited.data as { revision: { id: string } }).revision.id,
    range: { startUs: 0, endUs: 1_000_000 },
    tap: { target: { kind: "output" }, point: { kind: "processed" } },
    rendition: { sampleRate: 16000, channels: 1 },
  };
  type Status = {
    state: string;
    jobId: string | null;
    published: { output: { generation: string } } | null;
  };
  const prepare = async () => {
    const result = await f.call("transcript.render.prepare", request);
    if (!result.ok) throw new Error(JSON.stringify(result));
    return result.data as Status;
  };
  /** Polls the item's own status, as a caller would, until it settles. */
  const settled = async () => {
    const deadline = performance.now() + 5000;
    for (;;) {
      const status = await prepare();
      if (["ready", "failed", "canceled", "unavailable"].includes(status.state)) return status;
      if (performance.now() >= deadline) throw new Error(JSON.stringify(status));
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const words = async (generation: string) => {
    const read = await f.call("transcript.render.get", {
      projectId: request.projectId,
      revisionId: request.revisionId,
      generation,
    });
    expect(read).toMatchObject({ ok: true, data: { state: "ready" } });
    if (!read.ok) throw new Error(JSON.stringify(read));
    return (read.data as { rows: { text: string }[] }).rows.map((row) => row.text);
  };
  return { ...f, calls, prepare, settled, words };
}

test("failed rendered recognition recovers through job.retry with the jobId its prepare returned", async () => {
  const f = await renderedRecognition("speech.transcribe");
  const pending = await f.prepare();
  expect(pending.jobId).toEqual(expect.any(String));
  const failed = await f.settled();
  expect(failed).toMatchObject({ state: "failed", jobId: pending.jobId, published: null });
  expect(f.calls.filter((operation) => operation === "speech.transcribe")).toHaveLength(1);
  expect(await f.call("job.retry", { jobId: failed.jobId! })).toMatchObject({
    ok: true,
    data: { id: pending.jobId },
  });
  const ready = await f.settled();
  expect(ready).toMatchObject({ state: "ready", jobId: pending.jobId });
  expect(f.calls.filter((operation) => operation === "speech.transcribe")).toHaveLength(2);
  expect(await f.words(ready.published!.output.generation)).toEqual(["rendered"]);
});

test("a failed rendered PCM dependency recovers through job.retry with the jobId its prepare returned", async () => {
  const f = await renderedRecognition("media.mixCompositionAudio");
  const pending = await f.prepare();
  const failed = await f.settled();
  expect(failed).toMatchObject({ state: "failed", jobId: pending.jobId, published: null });
  expect(await f.call("job.get", { jobId: failed.jobId! })).toMatchObject({
    ok: true,
    data: {
      state: "failed",
      errorDetails: { dependencyJobId: expect.any(String), state: "failed" },
    },
  });
  expect(f.calls.filter((operation) => operation === "speech.transcribe")).toHaveLength(0);
  // The jobId the item reported is enough: its retry also re-runs the failed extraction.
  expect(await f.call("job.retry", { jobId: failed.jobId! })).toMatchObject({
    ok: true,
    data: { id: pending.jobId },
  });
  const ready = await f.settled();
  expect(ready).toMatchObject({ state: "ready", jobId: pending.jobId });
  expect(f.calls.filter((operation) => operation === "media.mixCompositionAudio")).toHaveLength(2);
  expect(await f.words(ready.published!.output.generation)).toEqual(["rendered"]);
});

test("oversized independently valid project mutation does not dispatch", async () => {
  const f = await emptyProject();
  const before = await f.state();
  // Whitespace, rather than an unknown field, keeps the domain request valid.
  await sendRaw(
    f.service.socketPath,
    Buffer.from(" ".repeat(REQUEST_FRAME_BYTES) + JSON.stringify(f.request) + "\n"),
  );
  const after = await f.state();
  await save("oversized-state", { before, after });
  expect(after).toEqual(before);
  const applied = await callLocal(f.service.socketPath, f.request);
  expect(applied.ok).toBe(true);
  expect(await f.state()).not.toEqual(before);
});

test("invalid UTF-8 in an otherwise valid project mutation does not dispatch", async () => {
  const f = await emptyProject();
  const before = await f.state();
  const bytes = Buffer.from(JSON.stringify(f.request) + "\n");
  const marker = bytes.indexOf(Buffer.from('"requestId":"resize"')) + '"requestId":"'.length;
  expect(marker).toBeGreaterThan(0);
  bytes[marker] = 0xff;
  await sendRaw(f.service.socketPath, bytes);
  const after = await f.state();
  await save("framing-state", { before, after });
  expect(after).toEqual(before);
  expect((await callLocal(f.service.socketPath, f.request)).ok).toBe(true);
  expect(await f.state()).not.toEqual(before);
});

test("client TIMEOUT after a real committed reply preserves same-ID replay and history", async () => {
  const f = await emptyProject();
  const sockets = new Set<Socket>();
  let resolveCommitted!: (value: { response: OperationResponse; at: number }) => void;
  let rejectCommitted!: (error: unknown) => void;
  const committed = new Promise<{ response: OperationResponse; at: number }>((resolve, reject) => {
    resolveCommitted = resolve;
    rejectCommitted = reject;
  });
  const proxy = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
    let input = "";
    socket.on("data", (bytes) => {
      input += bytes.toString();
      if (!input.endsWith("\n")) return;
      socket.removeAllListeners("data");
      const request = JSON.parse(input) as OperationRequest;
      void callLocal(f.service.socketPath, request).then(
        (response) => resolveCommitted({ response, at: performance.now() }),
        rejectCommitted,
      );
      // Hold the actual backend reply. The client, not the mutation owner, times out.
    });
  });
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      proxy.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const path = join(f.home, "timeout.sock");
  proxy.listen(path);
  await once(proxy, "listening");
  const started = performance.now();
  const pending = callLocal(path, f.request, { timeoutMs: 250 }).then(
    (response) => ({ response }),
    (error: unknown) => ({ error }),
  );
  const success = await committed;
  const timeout = await pending;
  const after = await f.state();
  await save("timeout-commit", { started, success, timeout, after });
  expect(success.response.ok).toBe(true);
  expect(success.at - started).toBeLessThan(250);
  expect(timeout).toMatchObject({ error: { code: "TIMEOUT" } });
  expect(await callLocal(f.service.socketPath, f.request)).toEqual(success.response);
  expect(await f.state()).toEqual(after);
  expect(after.history).toMatchObject({
    ok: true,
    data: {
      revisions: [{ id: f.revision.id }, { document: { canvas: { width: 32 } } }],
    },
  });
  expect(after.requests).toHaveLength(1);
  expect(after.requests[0]).toMatchObject({ projectId: f.project.id, requestId: "resize" });
  expect(JSON.parse(after.requests[0]!.result as string)).toEqual(
    success.response.ok ? success.response.data : null,
  );
  expect(JSON.parse(after.requests[0]!.arguments as string)).toEqual({
    operation: "apply",
    expectedRevisionId: f.revision.id,
    operations: f.request.params.operations,
  });
  const stale = await callLocal(f.service.socketPath, {
    ...f.request,
    params: { ...f.request.params, requestId: "stale-resize" },
  });
  expect(stale).toMatchObject({
    ok: false,
    error: {
      code: "STALE_REVISION",
      details: {
        currentRevisionId: (success.response.ok
          ? (success.response.data as { revision: { id: string } })
          : null
        )?.revision.id,
      },
    },
  });
});

test("package-root refusal does not revoke unrelated canonical project dispatch", async () => {
  const f = await emptyProject();
  await mkdir(join(f.home, "library", "packages"), { mode: 0o755 });
  await chmod(join(f.home, "library", "packages"), 0o755);
  const opened = await f.call("package.open", { path: "/absent.zip" });
  await save("package-refusal", opened);
  expect(opened).toMatchObject({
    ok: false,
    error: { code: "INVALID_STORAGE" },
  });
  expect(await f.call("package.status", {})).toEqual({
    id: "test",
    ok: true,
    data: { usage: null, admissions: [] },
  });
  expect(await f.call("project.get", { projectId: f.project.id })).toMatchObject({
    ok: true,
    data: { id: f.project.id, currentRevisionId: f.revision.id },
  });
  expect((await callLocal(f.service.socketPath, f.request)).ok).toBe(true);
});

test("selected-source transcript preserves filler, phrase and ready retry through actual model metadata", async () => {
  const requests: SpeechTranscriptionRequest[] = [];
  let failFirst = true;
  const speech = controlledSpeech(requests);
  const f = await projectServiceFixture(cleanups, async (operation, params, options) => {
    if (operation === "speech.transcribe" && failFirst) {
      failFirst = false;
      return {
        ok: false,
        error: {
          code: "MEDIA_WORKER_FAILED",
          message: "controlled failure",
          retryable: true,
          details: {},
        },
      };
    }
    return speech(operation, params, options);
  });
  const model = await modelMetadata(await realpath(join(f.home, "library")));
  const receipt = await readFile(model.receipt);
  const status = await f.call("model.status", { modelId: "parakeet" });
  expect(status).toMatchObject({ ok: true, data: { state: "ready" } });
  const prepared = await f.call("model.prepare", { modelId: "parakeet" });
  expect(prepared).toMatchObject({ ok: true, data: { state: "ready" } });
  expect(await f.call("model.prepare", { modelId: "parakeet" })).toEqual(prepared);
  expect(await readFile(model.receipt)).toEqual(receipt);
  const imported = await f.call("asset.import", { requestId: "speech", path: f.path });
  if (!imported.ok) throw new Error(JSON.stringify(imported));
  const ready = await f.job((imported.data as { jobId: string }).jobId, "ready");
  const selection = { assetId: ready.published!.output.assetId, streamId: "track:1" };
  expect(await f.call("transcript.get", selection)).toMatchObject({
    ok: true,
    data: { state: "idle", jobId: null },
  });
  const created = await f.call("project.create", { requestId: "cached-read", canvas });
  if (!created.ok) throw new Error(JSON.stringify(created));
  const initial = created.data as {
    project: { id: string };
    revision: { id: string };
  };
  const edited = await f.call("edit.apply", {
    projectId: initial.project.id,
    expectedRevisionId: initial.revision.id,
    requestId: "cached-place",
    operations: [
      { operation: "track.add", track: { kind: "audio", order: 0 }, label: "dialogue" },
      {
        operation: "place",
        clip: {
          trackId: { label: "dialogue" },
          ...selection,
          source: { kind: "range", range: { startUs: 0, endUs: 2000000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 2000000 } },
        },
      },
    ],
  });
  if (!edited.ok) throw new Error(JSON.stringify(edited));
  const projectSelection = {
    projectId: initial.project.id,
    revisionId: (edited.data as { revision: { id: string } }).revision.id,
  };
  expect(await f.call("transcript.get", projectSelection)).toMatchObject({
    ok: true,
    data: {
      state: "queued",
      reason: "source_evidence_not_ready",
      dependencies: [{ state: "idle", jobId: null }],
    },
  });
  const database = new DatabaseSync(join(f.home, "library", "catalog.sqlite"));
  cleanups.push(async () => database.close());
  expect(database.prepare("SELECT artifact FROM jobs WHERE artifact='transcript'").all()).toEqual(
    [],
  );
  expect(requests).toEqual([]);
  const pending = await f.call("transcript.transcribe", selection);
  if (!pending.ok) throw new Error(JSON.stringify(pending));
  const jobId = (pending.data as { jobId: string }).jobId;
  await f.job(jobId, "failed");
  expect(await f.call("job.retry", { jobId })).toMatchObject({ ok: true, data: { id: jobId } });
  await f.job(jobId, "ready");
  const speakerInput = {
    assetId: selection.assetId,
    streamId: "audio",
    channel: 0,
    sourceRange: { startUs: 0, endUs: 30000000 },
    modelId: speakerSource.engine.modelId,
  };
  const speakerMetadata = await publishControlledObservation(f.home, speakerInput);
  expect(
    await f.call("speaker.bind", {
      requestId: "speaker-bind-test",
      expectedBindingDigest: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
      assetId: speakerInput.assetId,
      streamId: speakerInput.streamId,
      channel: speakerInput.channel,
      modelId: speakerInput.modelId,
      sourceRange: speakerInput.sourceRange,
      generation: speakerMetadata.generation,
      bindings: [
        { slot: 0, displayName: "Ada" },
        { slot: 1, displayName: "Grace" },
      ],
    }),
  ).toMatchObject({ ok: true });
  const attributedSpeaker = {
    streamId: speakerInput.streamId,
    channel: speakerInput.channel,
    modelId: speakerInput.modelId,
    sourceRange: speakerInput.sourceRange,
    generation: speakerMetadata.generation,
  };
  const attributed = await f.call("transcript.get", {
    ...selection,
    limit: 4,
    speaker: attributedSpeaker,
  });
  expect(attributed).toMatchObject({
    ok: true,
    data: {
      rows: [
        { id: "w0", speaker: { state: "attributed", slot: 0, displayName: "Ada" } },
        { id: "w1", speaker: { state: "overlap", slots: [0, 1] } },
        { id: "w2", speaker: { state: "overlap", slots: [0, 1] } },
        { id: "w3", speaker: { state: "attributed", slot: 1, displayName: "Grace" } },
      ],
      nextCursor: expect.any(String),
    },
  });
  if (!attributed.ok) throw new Error(JSON.stringify(attributed));
  const attributedCursor = (attributed.data as { nextCursor: string }).nextCursor;
  expect(attributedCursor).toEqual(expect.any(String));
  const reorderedSpeaker = {
    generation: speakerMetadata.generation,
    sourceRange: speakerInput.sourceRange,
    modelId: speakerInput.modelId,
    channel: speakerInput.channel,
    streamId: speakerInput.streamId,
  };
  expect(
    await f.call("transcript.get", {
      ...selection,
      limit: 4,
      speaker: reorderedSpeaker,
      cursor: attributedCursor,
    }),
  ).toMatchObject({ ok: true });
  // The speaker request is part of the filter set; a continuation must repeat it.
  expect(
    await f.call("transcript.get", { ...selection, limit: 4, cursor: attributedCursor }),
  ).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });
  expect(
    await f.call("speaker.bind", {
      requestId: "speaker-bind-relabel",
      expectedBindingDigest: "0128e332e14906c60e2692d34693068c5e67b389409636c720801bad805e84d2",
      assetId: speakerInput.assetId,
      streamId: speakerInput.streamId,
      channel: speakerInput.channel,
      modelId: speakerInput.modelId,
      sourceRange: speakerInput.sourceRange,
      generation: speakerMetadata.generation,
      bindings: [
        { slot: 0, displayName: "Adele" },
        { slot: 1, displayName: "Grace" },
      ],
    }),
  ).toMatchObject({ ok: true });
  expect(
    await f.call("transcript.get", {
      ...selection,
      limit: 4,
      speaker: attributedSpeaker,
      cursor: attributedCursor,
    }),
  ).toMatchObject({ ok: false, error: { code: "ARTIFACT_CHANGED" } });
  expect(
    await f.call("speaker.bind", {
      requestId: "speaker-bind-test",
      expectedBindingDigest: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
      assetId: speakerInput.assetId,
      streamId: speakerInput.streamId,
      channel: speakerInput.channel,
      modelId: speakerInput.modelId,
      sourceRange: speakerInput.sourceRange,
      generation: speakerMetadata.generation,
      bindings: [
        { slot: 0, displayName: "Ada" },
        { slot: 1, displayName: "Grace" },
      ],
    }),
  ).toMatchObject({ ok: true });
  expect(
    await f.call("transcript.get", {
      ...selection,
      limit: 4,
      speaker: attributedSpeaker,
      cursor: attributedCursor,
    }),
  ).toMatchObject({ ok: false, error: { code: "ARTIFACT_CHANGED" } });
  const rows: SourceTranscriptRow[] = [];
  let cursor: unknown;
  let generation: string | undefined;
  do {
    const page = await f.call("transcript.get", {
      ...selection,
      limit: 4,
      ...(cursor ? { cursor } : {}),
    });
    if (!page.ok) throw new Error(JSON.stringify(page));
    const data = page.data as {
      generation: string;
      rows: SourceTranscriptRow[];
      nextCursor: unknown;
    };
    generation ??= data.generation;
    expect(data.generation).toBe(generation);
    rows.push(...data.rows);
    cursor = data.nextCursor;
  } while (cursor);
  await save("source-transcript", { requests, rows, generation });
  expect(
    rows.map((row) => (row.type === "word" ? `${row.id}:${row.text}` : `gap:${row.reason}`)),
  ).toEqual([
    "w0:Open",
    "w1:the",
    "w2:Settings",
    "w3:panel.",
    "gap:not_acquired",
    "w4:Um,",
    "w5:press",
    "w6:record",
    "gap:not_acquired",
  ]);
  expect(rows[5]).toMatchObject({
    kind: "filler",
    sourceRange: { startUs: 4100000, endUs: 4300000 },
  });
  expect(await f.call("transcript.search", { ...selection, text: "settings PANEL" })).toMatchObject(
    {
      ok: true,
      data: {
        generation,
        entries: [{ wordIds: ["w2", "w3"], sourceRange: { startUs: 800000, endUs: 2000000 } }],
        nextCursor: null,
      },
    },
  );
  const first = await f.call("job.get", { jobId });
  expect(first).toMatchObject({ ok: true, data: { state: "ready", id: jobId } });
  expect(await f.call("job.get", { jobId })).toEqual(first);
  expect(await f.call("transcript.get", selection)).toMatchObject({
    ok: true,
    data: { generation },
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    models: { directory: model.directory, files: parakeetModel.files },
    track: {
      streamId: "track:1",
      sourceOffsetUs: -48675,
      available: [
        { startUs: 0, endUs: 3000000 },
        { startUs: 4000000, endUs: 6000000 },
      ],
    },
  });
  expect(await readFile(requests[0]!.track.source, "utf8")).toBe("image bytes");
  let projectTranscript = await f.call("transcript.get", projectSelection);
  for (
    let poll = 0;
    projectTranscript.ok && (projectTranscript.data as { state: string }).state !== "ready";
    poll++
  ) {
    if (poll > 300) throw new Error(JSON.stringify(projectTranscript));
    await new Promise((resolve) => setTimeout(resolve, 10));
    projectTranscript = await f.call("transcript.get", projectSelection);
  }
  expect(projectTranscript).toMatchObject({ ok: true, data: { state: "ready" } });
  const proposed = await f.call("caption.propose", {
    ...projectSelection,
    range: { startUs: 0, endUs: 2_000_000 },
    trackId: "captions",
    canvas: { width: 640, height: 360 },
    style: {
      font: { assetId: "font", postScriptName: "Fixture" },
      width: 640,
      height: 120,
      size: 32,
      color: "#ffffffff",
      alignment: "center",
      wrap: true,
    },
    constraints: {
      widthGraphemes: 30,
      maxLines: 2,
      minDwellUs: 1,
      maxDwellUs: 3_600_000_000,
      maxCps: 30,
      pauseUs: 400_000,
      breakOnPunctuation: true,
      separator: " ",
      safeArea: { x: 0, y: 0, width: 640, height: 360 },
    },
  });
  if (!proposed.ok) throw new Error(JSON.stringify(proposed));
  expect(proposed).toMatchObject({
    ok: true,
    data: {
      identity: { projectId: projectSelection.projectId, revisionId: projectSelection.revisionId },
      proposals: [{ text: "Open the Settings panel." }],
    },
  });
  expect(await f.call("project.list", {})).toMatchObject({
    ok: true,
    data: {
      projects: [
        { id: projectSelection.projectId, currentRevisionId: projectSelection.revisionId },
      ],
    },
  });
});

test("ready source transcript reads carry the issues published with the transcript they read", async () => {
  // A word-dropped issue anchors to no word, so no row can carry it.
  const dropped = {
    code: "word-dropped",
    message: "Token 3 of 'bad' has a malformed engine estimate; the word is dropped.",
    range: { startUs: 2000000, endUs: 3000000 },
    evidence: {
      window: 0,
      token: 3,
      text: "bad",
      startSeconds: "NaN",
      endSeconds: 2.5,
      confidence: 1,
    },
  };
  const f = await projectServiceFixture(cleanups, controlledSpeech([], [dropped]));
  await modelMetadata(await realpath(join(f.home, "library")));
  const imported = await f.call("asset.import", { requestId: "speech", path: f.path });
  if (!imported.ok) throw new Error(JSON.stringify(imported));
  const ready = await f.job((imported.data as { jobId: string }).jobId, "ready");
  const selection = { assetId: ready.published!.output.assetId, streamId: "track:1" };
  const pending = await f.call("transcript.transcribe", selection);
  if (!pending.ok) throw new Error(JSON.stringify(pending));
  const { published: publication } = await f.job(
    (pending.data as { jobId: string }).jobId,
    "ready",
  );
  const {
    range,
    evidence: { endSeconds: _endSeconds, ...evidence },
    ...reported
  } = dropped;
  const published = {
    generation: publication!.generation,
    issues: [{ ...reported, evidence: { ...evidence, endUs: 2_500_000 }, at: { range } }],
  };
  for (const operation of ["transcript.get", "transcript.review"])
    expect(await f.call(operation, selection), operation).toMatchObject({
      ok: true,
      data: { state: "ready", generation: publication!.attemptId, issues: [], published },
    });

  // A project read names the source generations it projects; each carries its own issues.
  const created = await f.call("project.create", { requestId: "issues", canvas });
  if (!created.ok) throw new Error(JSON.stringify(created));
  const initial = created.data as {
    project: { id: string };
    revision: { id: string };
  };
  const edited = await f.call("edit.apply", {
    projectId: initial.project.id,
    expectedRevisionId: initial.revision.id,
    requestId: "place",
    operations: [
      { operation: "track.add", track: { kind: "audio", order: 0 }, label: "dialogue" },
      {
        operation: "place",
        clip: {
          trackId: { label: "dialogue" },
          ...selection,
          source: { kind: "range", range: { startUs: 0, endUs: 2000000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 2000000 } },
        },
      },
    ],
  });
  if (!edited.ok) throw new Error(JSON.stringify(edited));
  const project = { projectId: initial.project.id };
  let read = await f.call("transcript.get", project);
  for (let poll = 0; read.ok && (read.data as { state: string }).state !== "ready"; poll++) {
    if (poll > 300) throw new Error(JSON.stringify(read));
    await new Promise((resolve) => setTimeout(resolve, 10));
    read = await f.call("transcript.get", project);
  }
  expect(read).toMatchObject({
    ok: true,
    data: {
      state: "ready",
      issues: [],
      dependencies: [
        {
          selection,
          transcript: { generation: publication!.attemptId },
          issues: published.issues,
        },
      ],
    },
  });
});

test("ready and canceled source jobs retain identity through public cancel and restart", async () => {
  let holdProbe = false;
  let failProbe = false;
  let announceProbe!: () => void;
  let probeEntry = new Promise<void>((resolve) => {
    announceProbe = resolve;
  });
  const worker: Parameters<typeof projectServiceFixture>[1] = async (...[operation, , options]) => {
    expect(operation).toBe("media.probe");
    if (failProbe)
      return {
        ok: false,
        error: {
          code: "MEDIA_UNAVAILABLE",
          message: "Controlled retained source access failure",
          retryable: true,
          details: {},
        },
      };
    if (holdProbe) {
      announceProbe();
      const signal = options!.signal!;
      signal.throwIfAborted();
      await once(signal, "abort");
      signal.throwIfAborted();
    }
    return {
      ok: true,
      data: {
        originUs: 0,
        streams: [
          {
            id: "image:0",
            kind: "image",
            codec: "public.png",
            decodable: true,
            width: 2,
            height: 1,
            orientedWidth: 2,
            orientedHeight: 1,
            orientation: 1,
          },
        ],
      },
    };
  };
  let f = await projectServiceFixture(cleanups, worker);
  const imported = await f.call("asset.import", { requestId: "ready", path: f.path });
  if (!imported.ok) throw new Error(JSON.stringify(imported));
  const readyId = (imported.data as { jobId: string }).jobId;
  await f.job(readyId, "ready");
  const ready = await f.call("job.get", { jobId: readyId });
  for (const operation of ["job.get", "job.retry", "job.cancel"])
    expect(await f.call(operation, { jobId: readyId })).toEqual(ready);
  failProbe = true;
  const other = join(f.home, "other.png");
  await writeFile(other, "other source bytes");
  const pending = await f.call("asset.import", { requestId: "canceled", path: other });
  if (!pending.ok) throw new Error(JSON.stringify(pending));
  const jobId = (pending.data as { jobId: string }).jobId;
  await f.job(jobId, "failed");
  const failed = await f.call("job.get", { jobId });
  expect(failed).toMatchObject({
    ok: true,
    data: { state: "failed", errorCode: "MEDIA_UNAVAILABLE", retryable: true, published: null },
  });
  failProbe = false;
  holdProbe = true;
  expect(await f.call("job.retry", { jobId })).toMatchObject({
    ok: true,
    data: { id: jobId, target: (failed.ok ? (failed.data as { target: unknown }) : null)?.target },
  });
  await probeEntry;
  const canceled = await f.call("job.cancel", { jobId });
  expect(canceled).toMatchObject({
    ok: true,
    data: { id: jobId, state: "canceled", target: { kind: "import" }, published: null },
  });
  const home = f.home;
  await f.service.close();
  f = await projectServiceFixture(cleanups, worker, home);
  expect(await f.call("job.get", { jobId })).toEqual(canceled);
  probeEntry = new Promise<void>((resolve) => {
    announceProbe = resolve;
  });
  const retried = await f.call("job.retry", { jobId });
  expect(retried).toMatchObject({
    ok: true,
    data: {
      id: jobId,
      target: (canceled.ok ? (canceled.data as { target: unknown }) : null)?.target,
    },
  });
  if (!retried.ok || !canceled.ok) throw new Error("Job operation failed");
  expect((retried.data as { attemptId: string }).attemptId).not.toBe(
    (canceled.data as { attemptId: string }).attemptId,
  );
  await probeEntry;
  const stopped = await f.call("job.cancel", { jobId });
  expect(stopped).toMatchObject({
    ok: true,
    data: { id: jobId, state: "canceled", target: (canceled.data as { target: unknown }).target },
  });
  expect(await f.call("job.get", { jobId })).toEqual(stopped);
  for (const operation of ["job.get", "job.retry", "job.cancel"])
    expect(await f.call(operation, { jobId: "missing-job" })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
  await save("source-jobs", { ready, failed, canceled, retried, stopped });
  expect(await f.call("project.list", {})).toMatchObject({ ok: true, data: { projects: [] } });
});
