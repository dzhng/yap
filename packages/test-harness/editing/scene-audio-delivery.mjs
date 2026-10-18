import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { JourneyService, hash, poll, run } from "./source-evidence-fixture.mjs";
import { waveHeader, writeSourceWave } from "./audio-project-fixture.mjs";

const { values } = parseArgs({ options: { out: { type: "string" }, help: { type: "boolean" } } });
if (values.help) {
  console.log(
    "Usage: YAP_NATIVE=WORKER node scene-audio-delivery.mjs --out DIRECTORY\nCreate one public/native A/V export, inspect delivered video scenes and decode its audio separately.",
  );
  process.exit(0);
}
assert.ok(values.out && process.env.YAP_NATIVE, "Set --out and YAP_NATIVE");
const out = resolve(values.out);
await mkdir(out, { recursive: true });
const home = await mkdtemp("/tmp/yap-scene-audio-delivery-");
const report = {
  status: "failed",
  kind: "delivered-av-scene-audio-report",
  nativeSha256: hash(await readFile(process.env.YAP_NATIVE)),
  trace: [],
};
const service = new JourneyService(home, report);
const call = service.call.bind(service);
const ffmpeg = process.env.YAP_FFMPEG ?? "/opt/homebrew/bin/ffmpeg";
const save = () => writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");

async function importAsset(path) {
  const imported = await call("asset.import", { requestId: randomUUID(), path });
  const job = await poll(
    () => call("job.get", { jobId: imported.jobId }),
    (value) => value.state === "ready",
    "asset import",
  );
  return call("asset.get", { assetId: job.published.output.assetId });
}

async function makeImage(name, color) {
  const path = join(home, `${name}.png`);
  await run(ffmpeg, [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=c=${color}:s=64x48`,
    "-frames:v",
    "1",
    path,
  ]);
  return importAsset(path);
}

async function makeAudio(name, source) {
  const path = join(home, `${name}.wav`);
  await writeSourceWave(path, { source, seconds: 1 });
  return importAsset(path);
}

try {
  await service.start();
  const [red, blue, audioA, audioB] = await Promise.all([
    makeImage("red", "red"),
    makeImage("blue", "blue"),
    makeAudio("audio-a", 0),
    makeAudio("audio-b", 1),
  ]);
  const project = await call("project.create", {
    requestId: randomUUID(),
    canvas: {
      width: 64,
      height: 48,
      fps: { numerator: 4, denominator: 1 },
      background: "#000000ff",
    },
  });
  const edited = await call("edit.apply", {
    projectId: project.project.projectId,
    expectedRevisionId: project.revision.revisionId,
    requestId: randomUUID(),
    operations: [
      { operation: "track.add", label: "video-a", track: { kind: "video", order: 0 } },
      { operation: "track.add", label: "video-b", track: { kind: "video", order: 1 } },
      { operation: "track.add", label: "audio-a-track", track: { kind: "audio", order: 0 } },
      { operation: "track.add", label: "audio-b-track", track: { kind: "audio", order: 1 } },
      {
        operation: "place",
        label: "red",
        clip: {
          trackId: { label: "video-a" },
          assetId: red.id,
          streamId: red.streams[0].streamId,
          source: { kind: "hold", atUs: 0 },
          placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
        },
      },
      {
        operation: "place",
        label: "blue",
        clip: {
          trackId: { label: "video-b" },
          assetId: blue.id,
          streamId: blue.streams[0].streamId,
          source: { kind: "hold", atUs: 0 },
          placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
        },
      },
      ...[
        ["audio-a", "audio-a-track", audioA],
        ["audio-b", "audio-b-track", audioB],
      ].map(([label, trackLabel, asset]) => ({
        operation: "place",
        label,
        clip: {
          trackId: { label: trackLabel },
          assetId: asset.id,
          streamId: asset.streams[0].streamId,
          source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
        },
      })),
      {
        operation: "transition",
        kind: "crossfade",
        targets: [
          { kind: "clip", id: { label: "red" } },
          { kind: "clip", id: { label: "blue" } },
        ],
        mediaKind: "video",
        window: { kind: "project", range: { startUs: 250000, endUs: 750000 } },
      },
      {
        operation: "transition",
        kind: "crossfade",
        targets: [
          { kind: "clip", id: { label: "audio-a" } },
          { kind: "clip", id: { label: "audio-b" } },
        ],
        mediaKind: "audio",
        window: { kind: "project", range: { startUs: 250000, endUs: 750000 } },
      },
    ],
  });
  const exportId = randomUUID();
  await call("export.create", {
    exportId,
    projectId: project.project.projectId,
    revisionId: edited.revision.revisionId,
    kind: "video",
    directory: out,
    leaf: "combined.mp4",
  });
  const exported = await poll(
    () => call("export.status", { exportId }),
    (value) => value.state === "ready",
    "combined A/V export",
  );
  const moviePath = exported.output;
  const movieBytes = await readFile(moviePath);
  assert.equal(hash(movieBytes), exported.receipt.sha256);
  const delivered = await importAsset(moviePath);
  const video = delivered.streams.find((stream) => stream.kind === "video");
  const audio = delivered.streams.find((stream) => stream.kind === "audio");
  assert.ok(video && audio, "combined export must retain video and audio streams");
  const events = await poll(
    () => call("timeline.events", { assetId: delivered.id, streamId: video.id, limit: 50 }),
    (value) => value.state === "ready",
    "delivered video scenes",
  );
  const sceneRows = events.page.rows
    .filter((row) => row.kind === "scene")
    .map((row) => row.sourceAtUs);
  assert.deepEqual(sceneRows, [250000, 500000, 750000]);
  const audioPath = join(out, "delivered.wav");
  const audioResult = await poll(
    () => call("audio.get", { assetId: delivered.id, streamId: audio.id }, { output: audioPath }),
    (value) => value.state === "ready",
    "delivered audio",
  );
  const audioBytes = await readFile(audioPath);
  const header = waveHeader(audioBytes, audioBytes.length);
  assert.equal(header.frames, 48000);
  const pcm = audioBytes.subarray(header.offset);
  const samples = {};
  for (const atUs of [100000, 500000, 900000]) {
    const frame = Math.floor((atUs * 48000) / 1000000);
    const offset = frame * 8;
    samples[atUs] = [pcm.readFloatLE(offset), pcm.readFloatLE(offset + 4)];
  }
  report.export = {
    path: "combined.mp4",
    sha256: exported.receipt.sha256,
    bytes: movieBytes.length,
    mediaType: "video/mp4",
    durationUs: video.endUs,
    videoFrames: video.samples.count,
  };
  report.deliveredVideo = { streamId: video.id, sceneRows };
  report.deliveredAudio = {
    path: "delivered.wav",
    sha256: hash(audioBytes),
    bytes: audioBytes.length,
    streamId: audio.id,
    sampleRate: audioResult.published.output.sampleRate,
    channels: audioResult.published.output.channels,
    frames: header.frames,
    samples,
  };
  report.export.audioFrames = audioResult.published.output.frames;
  report.export.sampleRate = audioResult.published.output.sampleRate;
  report.export.channels = audioResult.published.output.channels;
  report.checks = {
    exportCommitted: true,
    videoSceneRowsObserved: true,
    audioDecodedThroughPublicAudioGet: true,
    sameExportContainsVideoAndAudio: true,
    crossPlaneAssociation: "refused",
    sharedClockPromotion: false,
  };
  report.status = "passed";
} catch (error) {
  report.error = { message: error.message, stack: error.stack };
  throw error;
} finally {
  await service.stop().catch(() => {});
  await save();
  await rm(home, { recursive: true, force: true });
}
console.log(JSON.stringify({ out, status: report.status }));
