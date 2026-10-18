import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { JourneyService, hash, poll } from "./source-evidence-fixture.mjs";
import { readAudioWaveFile } from "../../core/dist/audio-wave.js";

const { values } = parseArgs({ options: { out: { type: "string" } } });
assert(values.out && process.env.YAP_NATIVE);
const out = resolve(values.out),
  home = await realpath(await mkdtemp("/tmp/sr-pause-"));
await mkdir(out);
const report = {
  passed: false,
  trace: [],
  exchanges: [],
  checks: {},
  nativeSha256: hash(await readFile(process.env.YAP_NATIVE)),
};
const service = new JourneyService(home, report),
  call = service.call.bind(service);
const rate = 48000,
  stride = 8,
  frames = rate * 3;
const sourcePCM = Buffer.alloc(frames * stride);
// The first quarter second contains only authored ambience, never inferred silence.
for (let f = 0; f < frames; f++) {
  const t = f / rate;
  const ambience = 0.015 * Math.sin(2 * Math.PI * 60 * t) + 0.007 * Math.sin(2 * Math.PI * 172 * t);
  const voice =
    f < rate / 4
      ? 0
      : 0.18 *
        (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t)) *
        (Math.sin(2 * Math.PI * 180 * t) + 0.3 * Math.sin(2 * Math.PI * 540 * t));
  for (let c = 0; c < 2; c++)
    sourcePCM.writeFloatLE(ambience + voice * (c ? 0.8 : 1), f * stride + c * 4);
}
const header = Buffer.alloc(44);
header.write("RIFF");
header.writeUInt32LE(36 + sourcePCM.length, 4);
header.write("WAVEfmt ", 8);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(3, 20);
header.writeUInt16LE(2, 22);
header.writeUInt32LE(rate, 24);
header.writeUInt32LE(rate * stride, 28);
header.writeUInt16LE(stride, 32);
header.writeUInt16LE(32, 34);
header.write("data", 36);
header.writeUInt32LE(sourcePCM.length, 40);
const sourcePath = join(out, "source.wav");
await writeFile(sourcePath, Buffer.concat([header, sourcePCM]));
let projectId, revisionId;
async function edit(requestId, operations, transport = "cli") {
  const result = await call(
    "edit.apply",
    { projectId, expectedRevisionId: revisionId, requestId, operations },
    { transport },
  );
  revisionId = result.revision.id;
  return result;
}
async function audio(name, selection = { projectId, revisionId }) {
  await poll(
    () => call("audio.get", selection),
    (v) => v.state === "ready",
    name,
  );
  const path = join(out, `${name}.wav`);
  await call("audio.get", selection, { output: path });
  const info = readAudioWaveFile(path),
    bytes = await readFile(path);
  assert.equal(info.sampleRate, rate);
  assert.equal(info.channels, 2);
  return bytes.subarray(info.dataOffset, info.dataOffset + info.dataBytes);
}
function retained(actual, original) {
  assert.equal(actual.length, original.length + (rate / 2) * stride);
  assert.deepEqual(
    actual.subarray(0, rate * 1.5 * stride),
    original.subarray(0, rate * 1.5 * stride),
  );
  assert.deepEqual(actual.subarray(rate * 2 * stride), original.subarray(rate * 1.5 * stride));
}
try {
  await service.start();
  const imported = await call("asset.import", { requestId: "source", path: sourcePath });
  const job = await poll(
    () => call("job.get", { jobId: imported.jobId }),
    (v) => v.state === "ready",
    "import",
  );
  const asset = await call("asset.get", { assetId: job.published.output.assetId });
  const made = await call("project.create", {
    requestId: "pause",
    canvas: {
      width: 16,
      height: 16,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  projectId = made.project.projectId;
  revisionId = made.revision.id;
  const placed = await edit("place", [
    { operation: "track.add", label: "narration", track: { kind: "audio", order: 0 } },
    {
      operation: "place",
      clip: {
        trackId: { label: "narration" },
        assetId: asset.id,
        streamId: asset.streams[0].id,
        source: { kind: "range", range: { startUs: 0, endUs: 3000000 } },
        placement: { kind: "project", range: { startUs: 0, endUs: 3000000 } },
        pitch: "preserve",
      },
    },
  ]);
  const baselineRevision = revisionId,
    baseline = await audio("baseline");
  assert.deepEqual(baseline, sourcePCM);
  const gap = await edit(
    "insert-pause",
    [
      {
        operation: "insert",
        atUs: 1500000,
        durationUs: 500000,
        ripple: { trackIds: [placed.edit.labels.narration] },
      },
    ],
    "mcp",
  );
  const gapRevision = revisionId,
    silent = await audio("gap");
  retained(silent, baseline);
  assert.deepEqual(
    silent.subarray(rate * 1.5 * stride, rate * 2 * stride),
    Buffer.alloc((rate / 2) * stride),
  );
  assert.deepEqual(gap.revision.document.processing, []);
  assert.equal(gap.revision.document.tracks.length, 1);
  report.checks.gap = {
    noImplicitFillOrProcessing: true,
    exactRetainedPCM: true,
    mapping: [
      { sourceUs: [0, 1500000], projectUs: [0, 1500000] },
      { sourceUs: [1500000, 3000000], projectUs: [2000000, 3500000] },
    ],
    resamplingJoinInfluenceFrames: 0,
    protectedJoinGuardFrames: 0,
  };
  const selection = {
    assetId: asset.id,
    streamId: asset.streams[0].id,
    range: { startUs: 0, endUs: 250000 },
    rendition: { sampleRate: rate, channels: 2 },
  };
  const extraction = await poll(
    () => call("audio.extract", selection),
    (v) => v.state === "ready",
    "retained ambience",
  );
  assert.deepEqual(await call("audio.extract", selection, { transport: "mcp" }), extraction);
  const excerpt = extraction.published.output;
  assert.deepEqual(
    await audio("ambience", { assetId: excerpt.assetId, streamId: excerpt.streamId }),
    sourcePCM.subarray(0, (rate / 4) * stride),
  );
  report.extraction = excerpt;
  const occurrences = [
    { startUs: 1500000, endUs: 1750000 },
    { startUs: 1700000, endUs: 1950000 },
    { startUs: 1900000, endUs: 2000000 },
  ];
  const room = await edit("room-occurrences", [
    ...occurrences.map((_, i) => ({
      operation: "track.add",
      label: `roomTrack${i}`,
      track: { kind: "audio", order: i + 1 },
    })),
    ...occurrences.map((range, i) => ({
      operation: "place",
      label: `room${i}`,
      clip: {
        trackId: { label: `roomTrack${i}` },
        assetId: excerpt.assetId,
        streamId: excerpt.streamId,
        source: { kind: "range", range: { startUs: 0, endUs: range.endUs - range.startUs } },
        placement: { kind: "project", range },
        pitch: "preserve",
      },
    })),
  ]);
  const fades = occurrences.flatMap((range, i) => [
    {
      i,
      range: { startUs: range.startUs, endUs: range.startUs + (i === 0 ? 10000 : 50000) },
      from: 0,
      to: 1,
    },
    {
      i,
      range: { startUs: range.endUs - (i === 2 ? 10000 : 50000), endUs: range.endUs },
      from: 1,
      to: 0,
    },
  ]);
  await edit(
    "explicit-gain-fades",
    [
      ...occurrences.map((_, i) => ({
        operation: "processing.set",
        target: { kind: "clip", id: room.edit.labels[`room${i}`] },
        steps: [{ processor: { type: "gain", gain: 0.5 } }],
      })),
      ...fades.map(({ i, ...fade }) => ({
        operation: "fade",
        target: { kind: "clip", id: room.edit.labels[`room${i}`] },
        mediaKind: "audio",
        window: { kind: "project", range: fade.range },
        from: fade.from,
        to: fade.to,
      })),
    ],
    "mcp",
  );
  const filled = await audio("filled");
  retained(filled, baseline);
  let maxError = 0,
    energy = 0;
  for (let f = rate * 1.5; f < rate * 2; f++) {
    const us = (f / rate) * 1000000;
    let expected = 0;
    for (const [i, range] of occurrences.entries()) {
      if (us < range.startUs || us >= range.endUs) continue;
      let gain = 0.5;
      for (const fade of fades.filter((v) => v.i === i))
        if (us >= fade.range.startUs && us < fade.range.endUs)
          gain *=
            fade.from +
            ((fade.to - fade.from) * (us - fade.range.startUs)) /
              (fade.range.endUs - fade.range.startUs);
      expected +=
        sourcePCM.readFloatLE((f - Math.round((range.startUs * rate) / 1000000)) * stride) * gain;
    }
    for (let c = 0; c < 2; c++)
      maxError = Math.max(maxError, Math.abs(filled.readFloatLE(f * stride + c * 4) - expected));
    energy += expected * expected;
  }
  assert(energy > 0.1);
  assert(maxError < 1e-7, `Explicit room mix PCM error ${maxError}`);
  report.checks.room = {
    occurrences,
    gain: 0.5,
    authoredFades: fades,
    maxSampleError: maxError,
    exactRetainedPCM: true,
    resamplingJoinInfluenceFrames: 0,
    speechAbsentByFixtureConstruction: true,
  };
  report.revisions = { baselineRevision, gapRevision, filledRevision: revisionId };
  const preview = await poll(
    () => call("preview.get", { projectId, revisionId }),
    (v) => v.state === "ready",
    "render",
  );
  await call("preview.get", { projectId, revisionId }, { output: join(out, "filled.mp4") });
  assert.equal(preview.published.output.durationUs, 3500000);
  const exported = await call("export.create", {
    projectId,
    kind: "video",
    requestId: randomUUID(),
    directory: out,
    leaf: "export.mp4",
  });
  const exportId = exported.exportId;
  assert.equal(exported.snapshot.revisionId, revisionId);
  const published = await poll(
    () => call("export.status", { exportId }, { transport: "mcp" }),
    (v) => v.state === "ready",
    "export",
  );
  assert.deepEqual(await readFile(published.output), await readFile(join(out, "filled.mp4")));
  report.export = published.receipt;
  for (let n = 0; n < 2; n++)
    revisionId = (
      await call("edit.undo", {
        projectId,
        expectedRevisionId: revisionId,
        requestId: `undo-room-${n}`,
      })
    ).id;
  assert.deepEqual(await audio("undo-room"), silent);
  const capability = (await call("processing.capabilities", {})).find((v) => v.type === "rnnoise");
  report.checks.rnnoise = {
    capability: {
      execution: capability?.execution ?? false,
      implementationId: capability?.implementationId ?? null,
    },
    verified: false,
  };
  if (capability?.execution) {
    assert.equal(
      capability.implementationId,
      "rnnoise-70f1d256-d6021b7697677c4d2274c912975e143765552b0e6f25500aa660fdb4a9849be5-f480-s32768-flush2-delay960-independent-channels-v2",
    );
    const target = { kind: "track", id: placed.edit.labels.narration };
    const window = { kind: "project", range: { startUs: 1000000, endUs: 2500000 } };
    const noise = await edit(
      "selected-noise",
      [
        {
          operation: "processing.set",
          target,
          steps: [{ enabled: true, window, processor: { type: "rnnoise", mix: 1 } }],
        },
      ],
      "mcp",
    );
    assert.deepEqual(noise.revision.document.clips, gap.revision.document.clips);
    assert.deepEqual(noise.revision.document.tracks, gap.revision.document.tracks);
    const prepared = await poll(
      () => call("audio.prepare", { projectId, revisionId }),
      (v) => v.state === "ready",
      "selected RNNoise",
    );
    report.rnnoisePreparation = prepared;
    const wet = await audio("noise-wet");
    assert.equal(wet.length, silent.length);
    assert(!wet.equals(silent), "The fixture must distinguish RNNoise from bypass");
    assert.deepEqual(wet.subarray(0, rate * stride), silent.subarray(0, rate * stride));
    assert.deepEqual(wet.subarray(rate * 2.5 * stride), silent.subarray(rate * 2.5 * stride));
    const preparedAsset = await call("asset.get", { assetId: prepared.published.output.assetId });
    assert.deepEqual(
      await audio("noise-prepared", {
        assetId: preparedAsset.id,
        streamId: preparedAsset.streams.find((v) => v.kind === "audio").id,
      }),
      wet,
    );
    assert.deepEqual(
      await audio("noise-dry", { projectId, revisionId, tap: { target, point: { kind: "dry" } } }),
      silent,
    );
    const stack = await call("processing.get", { projectId, revisionId, target });
    assert.deepEqual(
      stack.steps.map(({ processor, window, enabled }) => ({ processor, window, enabled })),
      [{ processor: { type: "rnnoise", mix: 1 }, window, enabled: true }],
    );
    await edit("noise-half", [
      {
        operation: "processing.set",
        target,
        steps: stack.steps.map((step) => ({ ...step, processor: { type: "rnnoise", mix: 0.5 } })),
      },
    ]);
    const half = await audio("noise-half");
    const expected = Buffer.alloc(silent.length);
    for (let at = 0; at < expected.length; at += 4)
      expected.writeFloatLE(
        Math.fround(0.5 * silent.readFloatLE(at) + 0.5 * wet.readFloatLE(at)),
        at,
      );
    assert.deepEqual(half, expected);
    const noisePreview = await poll(
      () => call("preview.get", { projectId, revisionId }),
      (v) => v.state === "ready",
      "noise preview",
    );
    assert.equal(noisePreview.published.output.durationUs, 3500000);
    await call("preview.get", { projectId, revisionId }, { output: join(out, "noise-half.mp4") });
    await edit(
      "noise-bypass",
      [
        {
          operation: "processing.set",
          target,
          steps: stack.steps.map((step) => ({ ...step, enabled: false })),
        },
      ],
      "mcp",
    );
    assert.deepEqual(await audio("noise-bypass"), silent);
    for (let n = 0; n < 3; n++)
      revisionId = (
        await call("edit.undo", {
          projectId,
          expectedRevisionId: revisionId,
          requestId: `undo-noise-${n}`,
        })
      ).id;
    assert.deepEqual(await audio("undo-noise"), silent);
    assert.deepEqual(
      await audio("source-after-noise", { assetId: asset.id, streamId: asset.streams[0].id }),
      sourcePCM,
    );
    Object.assign(report.checks.rnnoise, {
      verified: true,
      target,
      window,
      fullWetDiffersFromDry: true,
      preparedEqualsOrdinary: true,
      halfMixExact: true,
      protectedNeighborsExact: true,
      bypassAndUndoExact: true,
      noAddedLayers: true,
      immutableSourcePCM: true,
      durationUs: 3500000,
      oracle:
        "Declared frozen adapter identity and independently calculated public dry/wet mix contract; not independent RNNoise inference parity or acoustic quality",
    });
  }

  revisionId = (
    await call("edit.undo", { projectId, expectedRevisionId: revisionId, requestId: "undo-gap" })
  ).id;
  assert.deepEqual(await audio("undo-gap"), baseline);
  assert.equal(hash(await readFile(sourcePath)), asset.id);
  report.checks.undoAndRender = {
    roomUndoExact: true,
    gapUndoExact: true,
    immutableSource: true,
    movieDurationUs: 3500000,
    exportMatchesPreview: true,
  };
  report.limits =
    "Synthetic mechanical journey only. Real voice listening and independent picture scope remain unverified. RNNoise status is reported separately; inference parity and acoustic quality are not claimed. No policy preference selected.";
  report.passed = true;
} finally {
  await service.stop();
  const { exchanges, ...summary } = report;
  await writeFile(join(out, "exchanges.json"), JSON.stringify(exchanges, null, 2));
  await writeFile(
    join(out, "report.json"),
    JSON.stringify({ ...summary, exchangesArtifact: "exchanges.json" }, null, 2),
  );
  await writeFile(join(out, "service.log"), service.logs.join(""));
  await rm(home, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed: report.passed, checks: report.checks, out }));
