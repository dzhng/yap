import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { Catalog, CatalogError } from "./catalog.js";
import { AssetStore } from "./assets.js";
import { AcquisitionStore } from "./acquisitions.js";
import { DerivedCache } from "./cache.js";
import { JobQueue } from "./jobs.js";
import { projectStoreFixture } from "./project-store.fixture.js";
import { MediaAudioInspection, type ProjectAudioRenderer } from "./audio-inspection.js";
import { PreparedAudioStore } from "./prepared-audio.js";
import { AudioExtraction } from "./audio-extraction.js";
import { readAudioWaveFile } from "./audio-wave.js";
import { TranscriptStore, type SpeechTranscriptionRequest } from "./transcript.js";
import { TranscriptProcessing, assetTranscriptOwner } from "./transcript-processing.js";
import { RenderedSpeech } from "./rendered-speech.js";
import { expectPageTraversal } from "./page-traversal.fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function wave(frames: number, sampleRate: number, channels: 1 | 2) {
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
async function fixture() {
  const home = await mkdtemp("/tmp/rendered-speech-");
  const catalog = new Catalog(join(home, "catalog.sqlite"));
  const assets = new AssetStore(catalog, home);
  await assets.recover();
  const acquisitions = new AcquisitionStore(catalog);
  const projects = projectStoreFixture(catalog, assets, home, acquisitions);
  const records = new TranscriptStore(catalog, home, assetTranscriptOwner(assets, acquisitions));
  const cache = new DerivedCache(catalog, home, () => {});
  await cache.reconcile();
  let extraction!: AudioExtraction, processing!: TranscriptProcessing, rendered!: RenderedSpeech;
  const jobs = new JobQueue({
    store: catalog,
    providers: { newId: randomUUID },
    targets: {
      pin(target) {
        if (target.kind === "asset") assets.get(target.assetId);
        else if (target.kind === "project") projects.revision(target.projectId, target.revisionId);
        else throw Error("Wrong owner");
        return target;
      },
      isAvailable: () => true,
      isDeleting: () => false,
      isCapturing: () => false,
    },
    execute: (execution) =>
      execution.job.artifact === "audio-extract"
        ? extraction.execute(execution)
        : execution.job.artifact === "transcript"
          ? processing.execute(execution)
          : rendered.execute(execution),
  });
  cleanups.push(async () => {
    await jobs.close();
    catalog.close();
    await rm(home, { recursive: true, force: true });
  });
  const probe = async (path: string) => {
    const bytes = await readFile(path);
    const pcm = readAudioWaveFile(path, bytes.length);
    const durationUs = (pcm.frames * 1e6) / pcm.sampleRate;
    return {
      originUs: 0,
      streams: [
        {
          id: "audio",
          kind: "audio",
          codec: "pcm",
          decodable: true,
          startUs: 0,
          endUs: durationUs,
          segments: [{ startUs: 0, endUs: durationUs, empty: false }],
          sampleRate: pcm.sampleRate,
          channels: pcm.channels,
        },
      ],
    };
  };
  const original = join(home, "original.wav");
  await writeFile(original, wave(48000, 16000, 1));
  const asset = await assets.import(original, { kind: "import" }, probe);
  const state = {
    modelReady: true,
    gaps: false,
    renders: 0,
    failRender: false,
    failOriginal: true,
    hold: false,
    words: [
      { text: "rendered", source: { startUs: 100000, endUs: 300000 }, confidence: 0.8 },
      { text: "landmark", source: { startUs: 500000, endUs: 700000 }, confidence: 0.8 },
    ],
  };
  let reportStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    reportStarted = resolve;
  });
  const renderer: ProjectAudioRenderer = {
    implementationId: "controlled-native-project-pcm",
    async render({ window, output }) {
      state.renders++;
      if (state.failRender)
        throw new CatalogError("MEDIA_WORKER_FAILED", "Controlled render failure", {});
      const frames = window.manifest.sampleRange.end - window.manifest.sampleRange.start;
      const bytes = wave(frames, 48000, 2);
      await writeFile(output, bytes);
      return {
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
        unavailable: [...window.audio()]
          .filter((clip) => clip.source.kind === "range")
          .map((clip) => ({
            clipId: clip.clipId,
            ranges: state.gaps ? [{ start: 48000, end: 48100 }] : [],
          })),
      };
    },
  };
  const prepared = new PreparedAudioStore({
    catalog,
    assets,
    projects,
    jobs,
    renderer,
    probe,
    staging: join(home, "prepared"),
  });
  await prepared.recover();
  const audio = new MediaAudioInspection({
    assets,
    acquisitions,
    jobs,
    cache,
    project: { projects, prepared, renderer },
    sourceRenderer: {
      implementationId: "unused",
      async render() {
        throw Error("Unexpected source render");
      },
    },
  });
  extraction = new AudioExtraction({
    assets,
    acquisitions,
    projects,
    jobs,
    audio,
    probe,
    staging: join(home, "extraction"),
    converter: {
      implementationId: "controlled-native-conversion",
      async convert(request) {
        const frames = (request.input.frames * request.sampleRate) / request.input.sampleRate;
        const bytes = wave(frames, request.sampleRate, request.channels);
        await writeFile(request.output, bytes);
        return {
          file: request.output,
          mediaType: "audio/wav",
          bytes: bytes.length,
          implementationId: "controlled-native-conversion",
          input: request.input,
          output: { frames, sampleRate: request.sampleRate, channels: request.channels },
          channelPolicy: "equal-weight-double-rounded-float32",
          contextPolicy: "complete-selected-pcm-zero-origin",
        };
      },
    },
  });
  await extraction.recover();
  const requests: SpeechTranscriptionRequest[] = [];
  processing = new TranscriptProcessing({
    jobs,
    transcripts: records,
    asset: { assets, acquisitions },
    models: {
      status: () => ({ state: state.modelReady ? "ready" : "absent" }),
      modelDigest: "a".repeat(64),
      nativeRequest: async () => ({ directory: home, files: [] }),
      pins: {
        runtime: "FluidAudio",
        runtimeVersion: "0.15.7",
        runtimeRevision: "frozen",
        decoder: "parakeet-tdt-batch",
        model: "Parakeet",
        modelRevision: "frozen",
      },
    },
    async transcribe(request, signal) {
      requests.push(request);
      if (state.hold) {
        reportStarted();
        await new Promise<void>((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
      }
      if (state.failOriginal && request.track.source === assets.path(asset.id))
        throw Error("Failed original transcript");
      const source = request.track.available[0]!;
      const words = state.words;
      const line = { ordinal: 0, source, owned: source, state: "transcribed", words };
      const raw = JSON.stringify(line) + "\n";
      await writeFile(request.output, raw);
      return {
        output: {
          file: request.output,
          bytes: Buffer.byteLength(raw),
          sha256: createHash("sha256").update(raw).digest("hex"),
        },
        engine: {
          runtime: "FluidAudio",
          runtimeVersion: "0.15.7",
          decoder: "parakeet-tdt-batch",
          encoderPrecision: "int8",
          computeUnits: "cpuAndNeuralEngine",
        },
        execution: request.execution,
        available: request.track.available,
        segments: [
          { ordinal: 0, source, owned: source, state: "transcribed", wordCount: words.length },
        ],
        wordCount: words.length,
      };
    },
  });
  rendered = new RenderedSpeech({
    catalog,
    projects,
    assets,
    jobs,
    extraction,
    transcripts: processing,
    records,
  });
  jobs.startAdmission((job) => rendered.admit(job));
  const created = projects.create({
    requestId: "create",
    canvas: {
      width: 16,
      height: 16,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  const placed = projects.apply(created.project.projectId, {
    expectedRevisionId: created.revision.id,
    requestId: "place",
    operations: [
      { operation: "track.add", label: "audio", track: { kind: "audio", order: 0 } },
      {
        operation: "place",
        clip: {
          assetId: asset.id,
          streamId: "audio",
          trackId: { label: "audio" },
          source: { kind: "range", range: { startUs: 0, endUs: 3000000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 3000000 } },
        },
      },
    ],
  });
  const selection = {
    projectId: created.project.projectId,
    revisionId: placed.revision.id,
    tap: { target: { kind: "output" as const }, point: { kind: "processed" as const } },
    range: { startUs: 1000001, endUs: 2000001 },
    rendition: { sampleRate: 16000, channels: 1 as const },
  };
  return {
    home,
    catalog,
    jobs,
    projects,
    processing,
    records,
    rendered,
    asset,
    state,
    requests,
    selection,
    started,
  };
}

test("rendered recognition survives failed original transcription and maps actual selected sample origin", async () => {
  const f = await fixture();
  f.processing.prepareSource({ assetId: f.asset.id, streamId: "audio" });
  await f.jobs.idle();
  expect(f.processing.sourceStatus({ assetId: f.asset.id, streamId: "audio" }).state).toBe(
    "failed",
  );
  const pending = f.rendered.prepare(f.selection);
  expect(f.rendered.prepare(f.selection).jobId).toBe(pending.jobId);
  await f.jobs.idle();
  const ready = f.rendered.prepare(f.selection);
  expect(ready.state, JSON.stringify(f.jobs.inspect(ready.jobId!))).toBe("ready");
  expect(ready.published!.speech.pcm.origin.selection).toMatchObject({
    kind: "project",
    projectId: f.selection.projectId,
    revisionId: f.selection.revisionId,
    tap: f.selection.tap,
    range: f.selection.range,
    sampleRange: { start: 48000, end: 96000 },
  });
  const first = f.rendered.get({
    projectId: f.selection.projectId,
    revisionId: f.selection.revisionId,
    generation: ready.published!.speech.generation,
    limit: 1,
  });
  expect(first).toHaveProperty("transcript", ready.published!.speech.transcript);
  expect(first.page.rows[0]).toMatchObject({
    type: "word",
    text: "rendered",
    sourceRange: { startUs: 100000, endUs: 300000 },
    projectRange: { startUs: 1100000, endUs: 1300000 },
  });
  f.state.modelReady = false;
  await f.processing.cleanup(new AbortController().signal);
  const second = f.rendered.get({
    projectId: f.selection.projectId,
    revisionId: f.selection.revisionId,
    generation: ready.published!.speech.generation,
    cursor: first.page.nextCursor!,
  });
  expect(second.page.rows[0]).toMatchObject({
    text: "landmark",
    projectRange: { startUs: 1500000, endUs: 1700000 },
  });
  expect(f.state.renders).toBe(1);
  expect(f.requests).toHaveLength(2);
});

test("receipt 09: a render range past the project's end shares the applied range's words and reports range-clamped", async () => {
  const f = await fixture();
  // The project ends at 3 s; receipt 09 asked 128–143.08 s of a project ending at 139.73 s.
  const applied = { ...f.selection, range: { startUs: 2000000, endUs: 3000000 } };
  const selection = { ...f.selection, range: { startUs: 2000000, endUs: 3500000 } };
  const pending = f.rendered.prepare(selection);
  await f.jobs.idle();
  const ready = f.rendered.prepare(selection);
  expect(ready.jobId).toBe(pending.jobId);
  expect(ready.state, JSON.stringify(f.jobs.inspect(ready.jobId!))).toBe("ready");
  const clamped = {
    code: "range-clamped",
    message: expect.any(String),
    at: { range: applied.range },
    evidence: {
      requested: selection.range,
      applied: applied.range,
      bounds: { startUs: 0, endUs: 3000000 },
    },
  };
  // The clamp belongs to this request, not to the output the applied range shares.
  expect(ready.issues).toEqual([clamped]);
  expect(ready.published!.issues).toEqual([]);
  const exact = f.rendered.prepare(applied);
  expect(exact).toMatchObject({ jobId: ready.jobId, state: "ready", issues: [] });
  expect(f.state.renders).toBe(1);
  expect(ready.published!.speech.selection.range).toEqual(applied.range);
  expect(ready.published!.speech.pcm.origin.selection).toMatchObject({ range: applied.range });
  const words = f.rendered.get({
    projectId: selection.projectId,
    revisionId: selection.revisionId,
    generation: ready.published!.speech.generation,
  });
  expect(words.issues).toEqual([]);
  expect(words.page.rows[0]).toMatchObject({
    text: "rendered",
    projectRange: { startUs: 2100000, endUs: 2300000 },
  });
});

test("a render range wholly outside the project refuses with its bounds before any job exists", async () => {
  const f = await fixture();
  const jobs = () =>
    (f.catalog.catalog.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n;
  const before = jobs();
  expect(() =>
    f.rendered.prepare({ ...f.selection, range: { startUs: 3000000, endUs: 4000000 } }),
  ).toThrow(
    expect.objectContaining({
      code: "INVALID_RANGE",
      details: expect.objectContaining({ bounds: { startUs: 0, endUs: 3000000 } }),
    }),
  );
  expect(jobs()).toBe(before);
  expect(f.state.renders).toBe(0);
});

test("missing selected support refuses recognition while preserving extraction identity", async () => {
  const f = await fixture();
  f.state.gaps = true;
  const pending = f.rendered.prepare(f.selection);
  await f.jobs.idle();
  expect(f.jobs.inspect(pending.jobId!)).toMatchObject({
    state: "failed",
    errorCode: "UNAVAILABLE_SUPPORT",
    retryable: false,
    errorDetails: {
      pcmAssetId: expect.stringMatching(/^[a-f0-9]{64}$/),
      unavailable: [{ ranges: [{ start: 48000, end: 48100 }] }],
    },
  });
  expect(f.requests).toEqual([]);
});

test("byte-identical rendered PCM still gets fresh recognition instead of reusing a failed source job", async () => {
  const f = await fixture();
  f.processing.prepareSource({ assetId: f.asset.id, streamId: "audio" });
  await f.jobs.idle();
  f.state.failOriginal = false;
  const selection = { ...f.selection, range: { startUs: 0, endUs: 3000000 } };
  const pending = f.rendered.prepare(selection);
  await f.jobs.idle();
  const ready = f.rendered.prepare(selection);
  expect(ready.state, JSON.stringify(f.jobs.inspect(pending.jobId!))).toBe("ready");
  expect(ready.published!.speech.pcm.assetId).toBe(f.asset.id);
  expect(f.processing.sourceStatus({ assetId: f.asset.id, streamId: "audio" }).state).toBe(
    "failed",
  );
  expect(f.requests).toHaveLength(2);
});

test("canceling active recognition publishes no words; explicit retry reuses PCM and creates a fresh attempt", async () => {
  const f = await fixture();
  f.state.hold = true;
  const pending = f.rendered.prepare(f.selection);
  await f.started;
  const canceled = f.jobs.cancel(pending.jobId!);
  await f.jobs.idle();
  expect(f.jobs.inspect(pending.jobId!)).toMatchObject({ state: "canceled", published: null });
  f.state.hold = false;
  f.rendered.retry(f.selection);
  await f.jobs.idle();
  const ready = f.rendered.prepare(f.selection);
  expect(ready.state).toBe("ready");
  expect(ready.published!.speech.generation).not.toBe(canceled.attemptId);
  expect(ready.published!.speech.transcript.generation).toBe(ready.published!.speech.generation);
  expect(f.state.renders).toBe(1);
  expect(f.requests).toHaveLength(2);
});

test("model absence is retryable and retained output reads refuse foreign revision and continuation", async () => {
  const f = await fixture();
  f.state.modelReady = false;
  const pending = f.rendered.prepare(f.selection);
  await f.jobs.idle();
  expect(f.jobs.inspect(pending.jobId!)).toMatchObject({
    state: "failed",
    errorCode: "MODEL_NOT_PREPARED",
    retryable: true,
  });
  expect(f.requests).toEqual([]);
  f.state.modelReady = true;
  f.rendered.retry(f.selection);
  await f.jobs.idle();
  const ready = f.rendered.prepare(f.selection);
  const read = {
    projectId: f.selection.projectId,
    revisionId: f.selection.revisionId,
    generation: ready.published!.speech.generation,
  };
  const changed = f.projects.apply(f.selection.projectId, {
    requestId: "newer",
    expectedRevisionId: f.selection.revisionId,
    operations: [
      {
        operation: "canvas.set",
        canvas: {
          width: 32,
          height: 16,
          fps: { numerator: 30, denominator: 1 },
          background: "#000000ff",
        },
      },
    ],
  });
  expect(f.rendered.get(read).page.rows[0]).toMatchObject({ text: "rendered" });
  expect(() => f.rendered.get({ ...read, revisionId: changed.revision.id })).toThrow(
    "another revision",
  );
  const first = f.rendered.get({ ...read, limit: 1 });
  expect(() =>
    f.rendered.get({ ...read, cursor: { ...first.page.nextCursor!, generation: randomUUID() } }),
  ).toThrow(expect.objectContaining({ code: "INVALID_PARAMS" }));
  expect(f.state.renders).toBe(1);
});

test("explicit rendered retry recovers a failed extraction prerequisite", async () => {
  const f = await fixture();
  f.state.failRender = true;
  const pending = f.rendered.prepare(f.selection);
  await f.jobs.idle();
  expect(f.jobs.inspect(pending.jobId!)).toMatchObject({
    state: "failed",
    errorCode: "MEDIA_WORKER_FAILED",
    retryable: true,
    errorDetails: { state: "failed", dependencyJobId: expect.any(String) },
  });
  expect(f.requests).toEqual([]);
  f.state.failRender = false;
  f.rendered.retry(f.selection);
  await f.jobs.idle();
  const ready = f.rendered.prepare(f.selection);
  expect(ready.state, JSON.stringify(f.jobs.inspect(pending.jobId!))).toBe("ready");
  expect(
    f.rendered.get({
      projectId: f.selection.projectId,
      revisionId: f.selection.revisionId,
      generation: ready.published!.speech.generation,
    }).page.rows[0],
  ).toMatchObject({ text: "rendered" });
});

test("a retained rendered publication without the current transcript policy cannot answer a new request", async () => {
  const f = await fixture();
  f.rendered.prepare(f.selection);
  await f.jobs.idle();
  const original = f.rendered.prepare(f.selection);
  const retained = f.jobs.retainedArtifact(
    { kind: "project", projectId: f.selection.projectId },
    "rendered-speech",
    original.published!.speech.generation,
  )!;
  const restored = f.projects.restore(f.selection.projectId, {
    requestId: "historical-policy-revision",
    expectedRevisionId: f.selection.revisionId,
    targetRevisionId: f.selection.revisionId,
  });
  const selection = { ...f.selection, revisionId: restored.id };
  const historicalInput = JSON.parse(retained.input);
  historicalInput.request.revisionId = restored.id;
  delete historicalInput.execution.policy;
  const historical = JSON.parse(retained.result);
  historical.selection.revisionId = restored.id;
  historical.pcm.origin.selection.revisionId = restored.id;
  historical.transcript.engine.policy = "historical-policy";
  f.jobs.adoptArtifact(
    {
      ...retained,
      target: { kind: "project", projectId: selection.projectId, revisionId: restored.id },
      attemptId: randomUUID(),
      input: JSON.stringify(historicalInput),
      result: JSON.stringify(historical),
    },
    [],
  );
  const pending = f.rendered.prepare(selection);
  expect(pending.published).toBeNull();
  await f.jobs.idle();
  const ready = f.rendered.prepare(selection);
  expect(ready.state).toBe("ready");
  expect(ready.published!.speech.transcript.engine.policy).not.toBe("historical-policy");
  expect(ready.published!.speech.generation).not.toBe(original.published!.speech.generation);
});

test("rendered speech pages conform to the paging contract", async () => {
  const f = await fixture();
  f.state.failOriginal = false;
  f.state.words = ["rendered", "landmark", "marker", "anchor"].map((text, index) => ({
    text,
    source: { startUs: 100000 + index * 200000, endUs: 200000 + index * 200000 },
    confidence: 0.8,
  }));
  f.rendered.prepare(f.selection);
  await f.jobs.idle();
  const ready = f.rendered.prepare(f.selection);
  expect(ready.state, JSON.stringify(f.jobs.inspect(ready.jobId!))).toBe("ready");
  const read = {
    projectId: f.selection.projectId,
    revisionId: f.selection.revisionId,
    generation: ready.published!.speech.generation,
  };
  type Continuation = { generation: string; sourceCursor: unknown };
  const { firstCursor } = expectPageTraversal<Continuation>((limit, cursor) => {
    const page = f.rendered.get({ ...read, limit, ...(cursor ? { cursor } : {}) }).page;
    return { items: page.rows, nextCursor: page.nextCursor };
  });
  expect(() => f.rendered.get({ ...read, cursor: { ...firstCursor, sourceCursor: 7 } })).toThrow(
    expect.objectContaining({ code: "INVALID_PARAMS" }),
  );
  // The requested generation is a filter; a continuation from another one is refused.
  expect(() =>
    f.rendered.get({ ...read, cursor: { ...firstCursor, generation: randomUUID() } }),
  ).toThrow(expect.objectContaining({ code: "INVALID_PARAMS" }));
});
