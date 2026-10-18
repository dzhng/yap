import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { JourneyService, hash, poll, root } from "./source-evidence-fixture.mjs";
import { readAudioWaveFile } from "../../core/dist/audio-wave.js";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    home: { type: "string" },
    model: { type: "string" },
    source: { type: "string" },
    case: { type: "string", default: "trend-cut" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "Usage: YAP_NATIVE=FROZEN_WORKER node rendered-speech-public.mjs --out EMPTY_DIRECTORY --model PREPARED_PARAKEET_DIRECTORY [--home REUSABLE_SCRATCH_HOME] [--source PHRASE_FINAL_TREND_WAV] [--case trend-cut]\nUses ordinary model.prepare, real native rendering/recognition and public CLI/MCP. Recognizes a cut inside a retained source-word estimate and compares it with source projection; exact PCM/project mapping and retained restart reads stay distinct from ASR lexical certainty. External original bytes remain intact. Saves failures and has bounded observation deadlines.",
  );
  process.exit(0);
}
assert(values.out && values.model && process.env.YAP_NATIVE);
assert.equal(values.case, "trend-cut");
const out = resolve(values.out);
await mkdir(out);
const home = values.home
  ? await realpath(values.home)
  : await realpath(await mkdtemp("/tmp/yap-rendered-speech-public-"));
const source = resolve(
  values.source ?? join(root, "fixtures/video-editing-feedback/phrase-final-trend.wav"),
);
const report = {
  passed: false,
  case: values.case,
  home,
  source,
  trace: [],
  exchanges: [],
  nativeSha256: hash(await readFile(process.env.YAP_NATIVE)),
  sourceSha256: hash(await readFile(source)),
};
const service = new JourneyService(home, report, join(out, "native"));
const call = service.call.bind(service);
async function rows(operation, input) {
  const output = [];
  let cursor;
  do {
    const data = await call(operation, { ...input, limit: 3, ...(cursor ? { cursor } : {}) });
    assert.equal(data.state, "ready");
    output.push(...data.page.rows);
    cursor = data.page.nextCursor;
  } while (cursor);
  return output;
}
try {
  await service.start();
  await call("model.prepare", { modelId: "parakeet", modelSource: await realpath(values.model) });
  await poll(
    () => call("model.status", { modelId: "parakeet" }),
    (value) => value.state === "ready",
    "model",
  );
  const imported = await call("asset.import", {
    requestId: "rendered-speech-source",
    path: source,
  });
  const importJob = await poll(
    () => call("job.get", { jobId: imported.jobId }),
    (value) => value.state === "ready",
    "source",
  );
  const asset = await call("asset.get", { assetId: importJob.published.output.assetId });
  const streamId = asset.streams.find((stream) => stream.kind === "audio").id;
  const sourceSelection = { assetId: asset.assetId, streamId };
  const sourceScope = {
    ...sourceSelection,
    sourceRange: { startUs: 20500000, endUs: 26500000 },
  };
  const sourcePrepared = await poll(
    () => call("transcript.transcribe", sourceScope),
    (value) => value.state === "ready",
    "source recognition",
  );
  const sourceGeneration = sourcePrepared.published.output.generation;
  const made = await call("project.create", {
    requestId: "rendered-speech-project-landmark",
    canvas: {
      width: 16,
      height: 16,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  const edited = await call("edit.apply", {
    projectId: made.project.projectId,
    expectedRevisionId: made.revision.id,
    requestId: "plant-trend-cut-landmark",
    operations: [
      { operation: "track.add", label: "dialogue", track: { kind: "audio", order: 0 } },
      {
        operation: "place",
        clip: {
          ...sourceSelection,
          trackId: { label: "dialogue" },
          source: { kind: "range", range: { startUs: 20500000, endUs: 25180000 } },
          placement: { kind: "project", range: { startUs: 3000001, endUs: 7680001 } },
        },
      },
    ],
  });
  const project = { projectId: made.project.projectId, revisionId: edited.revision.id };
  const projectionInput = {
    ...project,
    sourceGenerations: [{ ...sourceSelection, generation: sourceGeneration }],
    trackIds: [edited.edit.labels.dialogue],
  };
  await poll(
    () => call("transcript.get", projectionInput),
    (value) => value.state === "ready",
    "projection",
  );
  report.projected = await rows("transcript.get", projectionInput);
  // The independently authored impulse times validate the delivered project clock;
  // speech estimates are not used to find or place these landmarks.
  const markerPath = join(home, "landmark.wav");
  const marker = Buffer.alloc(44 + 48000 * 4);
  marker.write("RIFF");
  marker.writeUInt32LE(marker.length - 8, 4);
  marker.write("WAVEfmt ", 8);
  marker.writeUInt32LE(16, 16);
  marker.writeUInt16LE(3, 20);
  marker.writeUInt16LE(1, 22);
  marker.writeUInt32LE(48000, 24);
  marker.writeUInt32LE(192000, 28);
  marker.writeUInt16LE(4, 32);
  marker.writeUInt16LE(32, 34);
  marker.write("data", 36);
  marker.writeUInt32LE(marker.length - 44, 40);
  for (const [frame, amplitude] of [
    [12000, 0.4],
    [24000, 0.7],
    [36000, 0.5],
  ])
    marker.writeFloatLE(amplitude, 44 + frame * 4);
  await writeFile(markerPath, marker);
  const markerImport = await call("asset.import", {
    requestId: "independent-landmark",
    path: markerPath,
  });
  const markerJob = await poll(
    () => call("job.get", { jobId: markerImport.jobId }),
    (value) => value.state === "ready",
    "landmark import",
  );
  const markerAsset = await call("asset.get", { assetId: markerJob.published.output.assetId });
  const marked = await call("edit.apply", {
    projectId: project.projectId,
    expectedRevisionId: project.revisionId,
    requestId: "place-independent-landmark",
    operations: [
      { operation: "track.add", label: "landmark", track: { kind: "audio", order: 1 } },
      {
        operation: "place",
        clip: {
          assetId: markerAsset.id,
          streamId: markerAsset.streams[0].id,
          trackId: { label: "landmark" },
          source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
          placement: { kind: "project", range: { startUs: 7680001, endUs: 8680001 } },
        },
      },
    ],
  });
  project.revisionId = marked.revision.id;
  report.project = project;
  const selected = {
    ...project,
    range: { startUs: 3000001, endUs: 8680001 },
    tap: { target: { kind: "output" }, point: { kind: "processed" } },
    rendition: { sampleRate: 16000, channels: 1 },
  };
  report.selection = selected;
  const rendered = await poll(
    () => call("transcript.render.prepare", selected),
    (value) => value.state === "ready",
    "rendered recognition",
  );
  const speech = rendered.published.output;
  report.prepared = rendered;
  assert.equal(speech.kind, "rendered-speech");
  assert.notEqual(speech.transcript.generation, sourceGeneration);
  assert.deepEqual(speech.pcm.origin.selection.sampleRange, { start: 144000, end: 416640 });
  assert.equal(speech.pcm.frames, 90880);
  const query = { ...project, generation: speech.generation };
  report.measured = await rows("transcript.render.get", query);
  const mcp = await call("transcript.render.get", query, { transport: "mcp" });
  assert.deepEqual(mcp.page.rows, report.measured);
  for (const row of report.measured) {
    assert.equal(row.projectRange.startUs, 3000000 + row.sourceRange.startUs);
    assert.equal(row.projectRange.endUs, 3000000 + row.sourceRange.endUs);
  }
  const pcmAsset = await call("asset.get", { assetId: speech.pcm.assetId });
  const pcm = await readFile(join(home, "library/assets", pcmAsset.fileName));
  assert.equal(hash(pcm), speech.pcm.assetId);
  await writeFile(join(out, "rendered-pcm.wav"), pcm);
  report.pcmSha256 = hash(pcm);
  const dimensions = readAudioWaveFile(join(out, "rendered-pcm.wav"));
  assert.equal(dimensions.sampleRate, 16000);
  report.landmarks = [4930000, 5180000, 5430000].map((relativeUs) => {
    const expectedFrame = (relativeUs * 16000) / 1000000;
    let peak = 0,
      peakFrame;
    for (let frame = expectedFrame - 32; frame <= expectedFrame + 32; frame++) {
      const value = Math.abs(pcm.readFloatLE(dimensions.dataOffset + frame * 4));
      if (value > peak) {
        peak = value;
        peakFrame = frame;
      }
    }
    assert(peak > 0.1, "Authored audio landmark must actually be present");
    assert(
      Math.abs(peakFrame - expectedFrame) <= 1,
      "Delivered landmark differs from authored sample clock",
    );
    return { expectedFrame, peakFrame, peak, projectUs: 3000000 + (peakFrame * 1000000) / 16000 };
  });
  const nativeRecognition = JSON.parse(
    await readFile(join(out, "native/speech-0-request.json"), "utf8"),
  );
  // Source recognition is already retained on a reused home, so its ordinal is absent there.
  const deliveredRecognition = nativeRecognition.track.source.includes(speech.pcm.assetId)
    ? nativeRecognition
    : JSON.parse(await readFile(join(out, "native/speech-1-request.json"), "utf8"));
  assert.equal(hash(await readFile(deliveredRecognition.track.source)), speech.pcm.assetId);
  report.recognizedPCM = { path: deliveredRecognition.track.source, sha256: speech.pcm.assetId };
  report.projectedText = report.projected
    .filter((row) => row.type === "word")
    .map((row) => row.text)
    .join(" ");
  report.measuredText = report.measured
    .filter((row) => row.type === "word")
    .map((row) => row.text)
    .join(" ");
  assert(
    report.projected.some((row) => row.type === "word" && /^trend/iu.test(row.text) && row.partial),
    "Projection must retain the planted partial source word",
  );
  report.interpretation =
    "Fresh ASR may complete a word whose retained source estimate was cut. Consumed PCM identity and independent sample landmarks prove measured output and mapping; lexical differences alone never certify a clean or defective cut.";
  const before = await call("transcript.render.get", query);
  await service.stop();
  process.env.YAP_TEST_UNAVAILABLE_OPERATIONS = JSON.stringify([
    "speech.transcribe",
    "media.mixCompositionAudio",
    "media.convertSelectedAudio",
  ]);
  await service.start();
  assert.deepEqual(await call("transcript.render.get", query), before);
  delete process.env.YAP_TEST_UNAVAILABLE_OPERATIONS;
  assert.equal(hash(await readFile(source)), report.sourceSha256);
  report.passed = true;
} catch (error) {
  report.error = { message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  await service.stop();
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ passed: report.passed, out, home, error: report.error?.message }));
}
