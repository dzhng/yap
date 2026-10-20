import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { lstat, mkdir, truncate, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { operationNames } from "@yap/protocol";
import { afterEach, expect, test } from "vitest";
import { CaptureStore } from "./capture-store.js";
import { CatalogError } from "./catalog.js";
import type { CapturePublishedSource } from "./capture-publication.js";
import { writeNativeCaptureFixture } from "./capture-native.fixture.js";
import { AcquisitionStore, AcquisitionImporter } from "./acquisitions.js";
import { AssetStore } from "./assets.js";
import { Models, parakeetModel } from "./models.js";
import { JobQueue } from "./jobs.js";
import { SourceEvidenceStore } from "./evidence.js";
import { mediaWorker } from "../../../apps/service/dist/worker.js";
import { sourceExporter } from "../../../apps/service/dist/source-export.js";
import { readMediaProbe } from "../../../apps/service/dist/media-probe.js";
import { TranscriptBacklog } from "./transcript-backlog.js";
import { TranscriptStore } from "./transcript.js";
import { TranscriptProcessing, assetTranscriptOwner } from "./transcript-processing.js";
import {
  recordingPromptFacts,
  renderRecordingPrompt,
  type RecordingPromptSources,
} from "./recording-prompt.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

function fixture() {
  const home = mkdtempSync("/tmp/recording-prompt-");
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  let id = 0;
  const recordings = new CaptureStore(join(home, "catalog.sqlite"), {
    newId: () => `take-${++id}`,
    now: () => "2026-10-20T00:00:00.000Z",
  });
  cleanups.push(() => recordings.close());
  const acquisitions = new AcquisitionStore(recordings);
  const assets = new AssetStore(recordings, home);
  const models = new Models(home, globalThis.fetch, undefined, recordings);
  const jobs = new JobQueue({
    store: recordings,
    providers: { newId: randomUUID },
    targets: {
      pin: (target) => {
        if (target.kind !== "asset") throw new Error("Expected an asset transcript");
        assets.get(target.id);
        return { ...target, revisionId: null };
      },
      isAvailable: (target) => target.kind === "asset" && !!assets.get(target.id),
      isDeleting: () => false,
      isCapturing: () => recordings.isCapturing(),
    },
    execute: (job) => transcripts.execute(job),
  });
  cleanups.push(() => jobs.close());
  const speech = { fail: false };
  const transcribeModel = models.transcription("parakeet");
  const transcripts = new TranscriptProcessing({
    jobs,
    models: models.transcription("parakeet"),
    asset: { assets, acquisitions },
    transcripts: new TranscriptStore(recordings, home, assetTranscriptOwner(assets, acquisitions)),
    transcribe: async (request) => {
      if (speech.fail) throw new Error("Native transcription failed");
      const lines = request.track.available.map((source, ordinal) => ({
        ordinal,
        source,
        owned: source,
        state: "transcribed" as const,
        words: [],
      }));
      const body = lines.map((line) => JSON.stringify(line) + "\n").join("");
      await writeFile(request.output, body);
      return {
        output: {
          file: request.output,
          bytes: Buffer.byteLength(body),
          sha256: createHash("sha256").update(body).digest("hex"),
        },
        engine: {
          runtime: transcribeModel.pins.runtime,
          runtimeVersion: transcribeModel.pins.runtimeVersion,
          decoder: transcribeModel.pins.decoder,
          encoderPrecision: "int8",
          computeUnits: "cpuAndNeuralEngine",
        },
        segments: lines.map(({ words, ...line }) => ({ ...line, wordCount: words.length })),
        wordCount: 0,
        execution: request.execution,
        available: request.track.available,
      };
    },
  });
  const backlog = new TranscriptBacklog(recordings, {
    readiness: () => models.transcription("parakeet").status().state === "ready",
    status: (selection) => transcripts.sourceStatus(selection),
    submit: (selection) => {
      transcripts.prepareSource(selection);
    },
    report: (error) => {
      throw error;
    },
  });
  return {
    recordings,
    acquisitions,
    assets,
    transcripts,
    backlog,
    jobs,
    models,
    home,
    speech,
    autoTranscribe: true,
    status: undefined as RecordingPromptSources["status"],
  };
}

function publish(
  sources: ReturnType<typeof fixture>,
  options: {
    mic?: boolean;
    system?: boolean;
    camera?: boolean;
    kind?: "display" | "camera";
    legacy?: boolean;
    marks?: CapturePublishedSource["marks"];
  } = {},
) {
  const take = sources.recordings.allocate({
    requestId: "prompt",
    arguments: "{}",
    ...(options.camera ? { cameraDeviceId: "camera" } : {}),
  }).recording;
  const directory = join(sources.home, "recordings", take.id, "source");
  const publication = writeNativeCaptureFixture(directory, {
    ...options,
    recordingId: take.id,
    sourceId: take.sourceId,
    ...(take.camera ? { cameraSourceId: take.camera.sourceId } : {}),
  });
  sources.recordings.ingestLifecycle(take.id, {
    sourceId: take.sourceId,
    sequence: 1,
    state: "finalizing",
    publication,
  });
  sources.recordings.ingestLifecycle(take.id, {
    sourceId: take.sourceId,
    sequence: 2,
    state: "complete",
    sourceDurationUs: 190_000_000,
  });
  return take;
}
const pointer = "Use the yap skill to work with this recording (or run `yap --help`).";
const screen =
  "I recorded my screen to show you something. Watch it with Yap and act on what I asked for.";
const silent = "I recorded my screen without narration. Watch what happens with Yap.";

test.each([
  {
    name: "approved screen, camera, microphone and both marks",
    options: {
      mic: true,
      camera: true,
      kind: "display" as const,
      marks: { pins: true, strokes: true },
    },
    lines: [
      screen,
      "Recording: take-1 (3:10, screen, camera, microphone, no system audio).",
      "I left numbered pins and drew on screen while talking. Each one is a moment I'm pointing at.",
      "The transcript is being prepared automatically.",
      pointer,
    ],
  },
  {
    name: "pins only",
    options: { mic: true, kind: "display" as const, marks: { pins: true, strokes: false } },
    lines: [
      screen,
      "Recording: take-1 (3:10, screen, microphone, no camera, no system audio).",
      "I left numbered pins while talking. Each one is a moment I'm pointing at.",
      "The transcript is being prepared automatically.",
      pointer,
    ],
  },
  {
    name: "pins only without narration",
    options: { kind: "display" as const, marks: { pins: true, strokes: false } },
    lines: [
      silent,
      "Recording: take-1 (3:10, screen, no camera, no microphone, no system audio).",
      "I left numbered pins. Each one is a moment I'm pointing at.",
      pointer,
    ],
  },
  {
    name: "strokes only with narration",
    options: { mic: true, kind: "display" as const, marks: { pins: false, strokes: true } },
    lines: [
      screen,
      "Recording: take-1 (3:10, screen, microphone, no camera, no system audio).",
      "I drew on screen while talking. Each one is a moment I'm pointing at.",
      "The transcript is being prepared automatically.",
      pointer,
    ],
  },
  {
    name: "strokes only without narration",
    options: { kind: "display" as const, marks: { pins: false, strokes: true } },
    lines: [
      silent,
      "Recording: take-1 (3:10, screen, no camera, no microphone, no system audio).",
      "I drew on screen. Each one is a moment I'm pointing at.",
      pointer,
    ],
  },
  {
    name: "both marks without narration",
    options: { kind: "display" as const, marks: { pins: true, strokes: true } },
    lines: [
      silent,
      "Recording: take-1 (3:10, screen, no camera, no microphone, no system audio).",
      "I left numbered pins and drew on screen. Each one is a moment I'm pointing at.",
      pointer,
    ],
  },
  {
    name: "no marks and system audio",
    options: {
      mic: true,
      system: true,
      kind: "display" as const,
      marks: { pins: false, strokes: false },
    },
    lines: [
      screen,
      "Recording: take-1 (3:10, screen, microphone, system audio, no camera).",
      "The transcript is being prepared automatically.",
      pointer,
    ],
  },
  {
    name: "old summary omits marks",
    options: { mic: true },
    lines: [
      "I recorded something for you. Watch it with Yap.",
      "Recording: take-1 (3:10, microphone, no system audio).",
      "The transcript is being prepared automatically.",
      pointer,
    ],
  },
  {
    name: "camera only",
    options: { kind: "camera" as const },
    lines: [
      "I recorded myself on camera. Watch it with Yap.",
      "Recording: take-1 (3:10, camera, no screen, no microphone, no system audio).",
      pointer,
    ],
  },
])("golden: $name through capture and transcript stores", async ({ options, lines }) => {
  const sources = fixture();
  publish(sources, options);
  const text = renderRecordingPrompt(await recordingPromptFacts(sources));
  expect(text).toBe(lines.join("\n"));
  for (const name of operationNames) expect(text).not.toContain(name);
});

test("auto-transcribe off suppresses the transcript promise before import", async () => {
  const sources = fixture();
  publish(sources, { mic: true, kind: "display" });
  sources.autoTranscribe = false;
  expect(renderRecordingPrompt(await recordingPromptFacts(sources))).toBe(
    [
      screen,
      "Recording: take-1 (3:10, screen, microphone, no camera, no system audio).",
      pointer,
    ].join("\n"),
  );
});

test("only missing and discarded takes refuse a prompt", async () => {
  const sources = fixture();
  await expect(recordingPromptFacts(sources)).rejects.toMatchObject({ code: "NOT_FOUND" });
  const take = sources.recordings.allocate().recording;
  sources.recordings.ingestLifecycle(take.id, {
    sourceId: take.sourceId,
    sequence: 1,
    state: "canceled",
  });
  await expect(recordingPromptFacts(sources, take.id)).rejects.toMatchObject({
    code: "UNAVAILABLE",
  });
});

// There is no voice-only capture source today; preserve its existing pure-renderer variant.
test("voice-only golden", () => {
  expect(
    renderRecordingPrompt({
      recordingId: "voice",
      live: false,
      durationUs: 190_000_000,
      captured: { screen: false, camera: false, mic: true, system: false },
      transcript: "ready",
    }),
  ).toBe(
    [
      "I recorded my voice. Listen to it with Yap.",
      "Recording: voice (3:10, microphone, no screen, no camera, no system audio).",
      "The transcript is ready.",
      pointer,
    ].join("\n"),
  );
});

test.each(["recording", "paused"] as const)(
  "live %s golden uses capture status without a duration",
  async (state) => {
    const sources = fixture();
    const take = sources.recordings.allocate().recording;
    sources.recordings.ingestLifecycle(take.id, {
      sourceId: take.sourceId,
      sequence: 1,
      state: "recording",
    });
    if (state === "paused")
      sources.recordings.ingestLifecycle(take.id, { sourceId: take.sourceId, sequence: 2, state });
    // This is the native capture.status edge; catalog and transcript owners remain real.
    sources.status = async () => ({
      device: {
        state,
        recordingId: take.id,
        sourceId: take.sourceId,
        elapsedUs: 1_000_000,
        selection: { source: { kind: "display", id: 99 }, microphone: true, systemAudio: false },
        camera: null,
        permissions: { screen: true, microphone: "authorized", camera: "not_determined" },
      },
    });
    expect(renderRecordingPrompt(await recordingPromptFacts(sources, take.id))).toBe(
      [
        screen,
        "Recording: take-1 (still recording, screen, microphone, no camera, no system audio).",
        "The transcript is being prepared automatically.",
        pointer,
      ].join("\n"),
    );
  },
);

async function importedNarration(sources: ReturnType<typeof fixture>) {
  const take = publish(sources, { mic: true, kind: "display" });
  await sources.assets.recover();
  const evidence = new SourceEvidenceStore(sources.recordings, (identity) => {
    if (identity.owner.kind !== "acquisition") throw new Error("Expected an acquisition");
    sources.acquisitions.intent(identity.owner.id);
  });
  const importer = new AcquisitionImporter(
    sources.recordings,
    sources.acquisitions,
    sources.assets,
    evidence,
    sources.home,
  );
  await importer.recover(new AbortController().signal);
  const intent = sources.acquisitions.admitCapture(
    sources.recordings,
    take.id,
    join(sources.home, "recordings", take.id, "source"),
  );
  const native = mediaWorker();
  const acquisition = await importer.executeImport(
    intent.acquisitionId,
    "prompt-import",
    {
      exportSource: sourceExporter(native),
      probe: (path, signal, lifetime) =>
        readMediaProbe(native, sources.home, path, signal, lifetime ? [lifetime.fd] : []),
    },
    new AbortController().signal,
  );
  const narration = acquisition.bindings.find((binding) =>
    binding.sourceRoles.includes("narration"),
  )!;
  return {
    assetId: narration.assetId,
    streamId: narration.streamId,
    acquisitionId: acquisition.id,
  };
}

// Sparse native model inputs exercise real Models readiness without inference or downloads.
async function readyModel(sources: ReturnType<typeof fixture>) {
  const root = join(sources.home, "models", "parakeet", parakeetModel.revision);
  const files: Record<string, { modifiedNs: string; inode: string }> = {};
  for (const file of parakeetModel.files) {
    const path = join(root, parakeetModel.folderName, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "");
    await truncate(path, file.bytes);
    const stat = await lstat(path, { bigint: true });
    files[file.path] = { modifiedNs: String(stat.mtimeNs), inode: String(stat.ino) };
  }
  await writeFile(
    join(root, "receipt.json"),
    JSON.stringify({
      modelDigest: sources.models.transcription("parakeet").modelDigest,
      files,
    }),
  );
}

test("post-import backlog and transcript state determine the exact transcript line", async () => {
  const sources = fixture();
  const selection = await importedNarration(sources);
  const text = () => recordingPromptFacts(sources).then(renderRecordingPrompt);
  const identity = "Recording: take-1 (3:10, screen, microphone, no camera, no system audio).";
  expect(await text()).toBe([screen, identity, pointer].join("\n"));
  sources.backlog.enqueue(selection);
  expect(await text()).toBe(
    [screen, identity, "The transcript is being prepared automatically.", pointer].join("\n"),
  );

  await readyModel(sources);
  sources.transcripts.prepareSource(selection);
  await expect.poll(() => sources.transcripts.sourceStatus(selection).state).toBe("ready");
  expect(await text()).toBe([screen, identity, "The transcript is ready.", pointer].join("\n"));
  sources.autoTranscribe = false;
  expect(await text()).toBe([screen, identity, pointer].join("\n"));
});

test("an imported take with a failed transcript makes no promise, even before backlog drain", async () => {
  const sources = fixture();
  const selection = await importedNarration(sources);
  await readyModel(sources);
  sources.speech.fail = true;
  sources.backlog.enqueue(selection);
  sources.transcripts.prepareSource(selection);
  await expect.poll(() => sources.transcripts.sourceStatus(selection).state).toBe("failed");
  expect(renderRecordingPrompt(await recordingPromptFacts(sources))).toBe(
    [
      screen,
      "Recording: take-1 (3:10, screen, microphone, no camera, no system audio).",
      pointer,
    ].join("\n"),
  );
});

test("legacy camera summary keeps unknown picture identity without inventing a screen", async () => {
  const sources = fixture();
  publish(sources, { kind: "camera", legacy: true });
  expect(renderRecordingPrompt(await recordingPromptFacts(sources))).toBe(
    [
      "I recorded something for you. Watch it with Yap.",
      "Recording: take-1 (3:10, no microphone, no system audio).",
      pointer,
    ].join("\n"),
  );
});

test.each(["missing", "disconnected"] as const)(
  "an existing take with %s device observations does not invent absent inputs",
  async (observation) => {
    const sources = fixture();
    const take = sources.recordings.allocate().recording;
    if (observation === "disconnected")
      sources.status = async () => {
        throw new CatalogError("CONNECTION_CLOSED", "Capture controller disconnected");
      };
    expect(renderRecordingPrompt(await recordingPromptFacts(sources, take.id))).toBe(
      [
        "I recorded something for you. Watch it with Yap.",
        "Recording: take-1 (still recording).",
        pointer,
      ].join("\n"),
    );
  },
);
