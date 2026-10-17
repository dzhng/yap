import { createHash } from "node:crypto";
import frozenWorkers from "../../../specs/done/agent-editing/assets/acceptance-maintenance/native-worker-preservation.json" with { type: "json" };
import { verifyMixedCodecRates } from "./audio-mixed-codec-rates.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  readdirSync,
  existsSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyBatch, createCompiler, validateComposition } from "../../composition/dist/index.js";

assert.equal(process.argv.slice(2).join(" "), "--case music-and-replacement");
const worker = process.env.YAP_NATIVE;
assert(worker, "Set YAP_NATIVE to the built native worker");
const baseline = process.env.YAP_BASELINE_NATIVE;
assert(baseline, "Set YAP_BASELINE_NATIVE to the frozen pre-cutover worker");
const pin = frozenWorkers.files.find(
  (entry) => entry.scope === "canonical worker used by retained package/native/archive proofs",
);
assert.equal(
  createHash("sha256").update(readFileSync(baseline)).digest("hex"),
  pin.sha256,
  "Historical PCM reference worker must match the retained provenance manifest",
);
const scratch = mkdtempSync(join(tmpdir(), "sr-mix-"));
let sequence = 0;
function call(operation, params, expectedError, executable = worker) {
  const child = spawnSync(executable, [], {
    input: JSON.stringify({ id: String(++sequence), operation, params }) + "\n",
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(child.status, 0, child.stderr || String(child.error));
  const response = JSON.parse(child.stdout);
  if (expectedError) {
    assert.equal(response.error?.code, expectedError);
    return response;
  }
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.data;
}
function wave(path, decode = true, channels = 2, rate = 48000) {
  const bytes = readFileSync(path);
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
  let format, pcm;
  for (let position = 12; position + 8 <= bytes.length;) {
    const name = bytes.toString("ascii", position, position + 4),
      length = bytes.readUInt32LE(position + 4);
    const chunk = bytes.subarray(position + 8, position + 8 + length);
    if (name === "fmt ")
      format = {
        tag: chunk.readUInt16LE(0),
        channels: chunk.readUInt16LE(2),
        rate: chunk.readUInt32LE(4),
        bits: chunk.readUInt16LE(14),
      };
    if (name === "data") pcm = chunk;
    position += 8 + length + (length % 2);
  }
  assert.deepEqual(format, { tag: 3, channels, rate, bits: 32 });
  assert(pcm);
  if (!decode) return pcm.length / 8;
  return Array.from({ length: pcm.length / 4 }, (_, i) => pcm.readFloatLE(i * 4));
}
function fixture(name, rate, channels, signal) {
  const frames = rate * 2,
    bytes = Buffer.alloc(44 + frames * channels * 2);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * channels * 2, 28);
  bytes.writeUInt16LE(channels * 2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(frames * channels * 2, 40);
  const samples = [];
  for (let i = 0; i < frames; i++)
    for (let channel = 0; channel < channels; channel++) {
      const value = Math.round(signal(i, channel) * 32768);
      bytes.writeInt16LE(value, 44 + (i * channels + channel) * 2);
      samples.push(bytes.readInt16LE(44 + (i * channels + channel) * 2) / 32768);
    }
  const path = join(scratch, `${name}.wav`);
  writeFileSync(path, bytes);
  const probe = call("media.probe", { path });
  const stream = probe.streams.find((value) => value.kind === "audio");
  return {
    samples,
    binding: {
      assetId: name,
      streamId: stream.id,
      path,
      originUs: probe.originUs,
    },
    asset: {
      id: name,
      streams: [
        {
          id: stream.id,
          kind: "audio",
          bounds: { startUs: stream.startUs, endUs: stream.endUs },
          available: [{ startUs: stream.startUs, endUs: stream.endUs }],
        },
      ],
    },
  };
}
const canvas = {
  width: 640,
  height: 480,
  fps: { numerator: 30, denominator: 1 },
  background: "#000000ff",
};
const empty = {
  canvas,
  tracks: [],
  groups: [],
  clips: [],
  processing: [],
  syncGroups: [],
};
function clip(id, source, trackId, startUs, endUs, sourceStartUs = 0) {
  return {
    id,
    assetId: source.binding.assetId,
    streamId: source.binding.streamId,
    trackId,
    source: {
      kind: "range",
      range: { startUs: sourceStartUs, endUs: sourceStartUs + endUs - startUs },
    },
    placement: { kind: "project", range: { startUs, endUs } },
  };
}
function gain(kind, id, values) {
  return {
    target: { kind, ...(id ? { id } : {}) },
    steps: values.map((value, index) => ({
      id: `${kind}-${id ?? "out"}-${index}`,
      enabled: value !== null,
      processor: { type: "gain", gain: value ?? 123 },
    })),
  };
}
const evidence = {
  case: "music-and-replacement",
  nativeProductionEntry: true,
  liveMediaJourney: false,
  checks: [],
};
try {
  const sources = [];
  function render(
    document,
    range = { startUs: 0, endUs: 1000000 },
    expectedError,
    decode = true,
    onRendered,
  ) {
    const model = validateComposition(
      document,
      sources.map((source) => source.asset),
    );
    const window = createCompiler(model, "fixture-revision").window({
      range,
      rendition: { sampleRate: 48000, channels: 2 },
      tap: { target: { kind: "output" }, point: { kind: "processed" } },
    });
    const params = {
      output: join(scratch, `mix-${sequence}.wav`),
      range: {
        start: Math.floor((range.startUs * 48000) / 1000000),
        end: Math.floor((range.endUs * 48000) / 1000000),
      },
      clips: [...window.audio()],
      processing: window.processing(),
      assets: sources.map((source) => source.binding),
    };
    const result = call("media.mixCompositionAudio", params, expectedError);
    if (!expectedError) onRendered?.(result, params);
    return expectedError ? result : { result, samples: wave(result.file, decode), params };
  }
  const silence = render(empty);
  assert.equal(silence.result.frames, 48000);
  assert(silence.samples.every((value) => value === 0));
  evidence.checks.push("empty project produces exactly 48000 stereo silent frames");
  const a = fixture("voice", 48000, 1, (i) =>
    i === 0 || i === 47999 ? 0.75 : 0.125 * Math.sin((2 * Math.PI * 400 * i) / 48000),
  );
  const b = fixture(
    "music",
    48000,
    2,
    (i, channel) => 0.125 * Math.sin((2 * Math.PI * (channel ? 1200 : 800) * i) / 48000),
  );
  sources.push(a, b);
  const document = {
    ...empty,
    tracks: [
      { id: "voice-track", kind: "audio", order: 0, parentId: "voice-group" },
      { id: "music-track", kind: "audio", order: 1 },
    ],
    groups: [{ id: "voice-group", kind: "audio", order: 0 }],
    clips: [
      clip("voice-clip", a, "voice-track", 0, 1000000),
      clip("music-clip", b, "music-track", 250000, 750000),
    ],
    processing: [
      gain("clip", "voice-clip", [2, null]),
      gain("track", "voice-track", [0.5]),
      gain("group", "voice-group", [0.5]),
      gain("output", null, [2]),
    ],
  };
  const mixed = render(document);
  for (let frame = 0; frame < 48000; frame++)
    for (let channel = 0; channel < 2; channel++) {
      const voice = a.samples[frame];
      const music =
        frame >= 12000 && frame < 36000 ? b.samples[(frame - 12000) * 2 + channel] * 2 : 0;
      assert.equal(
        mixed.samples[frame * 2 + channel],
        Math.fround(voice + music),
        `sample ${frame}:${channel}`,
      );
    }
  assert.equal(mixed.samples[0], 0.75);
  assert.equal(mixed.samples[47999 * 2], 0.75);
  assert.equal(mixed.result.clippedSamples, 0);
  evidence.checks.push(
    "mono duplication, stereo identity, overlap and clip/track/group/output gain exact at every sample; no ramps",
  );
  // Lossless container changes must not alter either channel, endpoints or mix arithmetic.
  const losslessSources = [];
  for (const [source, name, extension, codec] of [
    [a, "voice-aiff", "aiff", "pcm_s16be"],
    [b, "music-alac", "m4a", "alac"],
  ]) {
    const path = join(scratch, `${name}.${extension}`);
    const encoded = spawnSync(
      "ffmpeg",
      ["-nostdin", "-v", "error", "-i", source.binding.path, "-c:a", codec, path],
      { encoding: "utf8", timeout: 30000 },
    );
    assert.equal(encoded.status, 0, encoded.stderr || String(encoded.error));
    const probe = call("media.probe", { path });
    const stream = probe.streams.find((value) => value.kind === "audio");
    const converted = {
      binding: { assetId: name, streamId: stream.id, path, originUs: probe.originUs },
      asset: {
        id: name,
        streams: [
          {
            id: stream.id,
            kind: "audio",
            bounds: { startUs: stream.startUs, endUs: stream.endUs },
            available: [{ startUs: stream.startUs, endUs: stream.endUs }],
          },
        ],
      },
    };
    sources.push(converted);
    losslessSources.push(converted);
  }
  const lossless = structuredClone(document);
  for (const [index, source] of losslessSources.entries()) {
    lossless.clips[index].assetId = source.binding.assetId;
    lossless.clips[index].streamId = source.binding.streamId;
  }
  assert.deepEqual(render(lossless).samples, mixed.samples);
  const losslessRange = { startUs: 123457, endUs: 812349 };
  const firstLosslessSample = Math.floor((losslessRange.startUs * 48000) / 1000000);
  const lastLosslessSample = Math.floor((losslessRange.endUs * 48000) / 1000000);
  assert.deepEqual(
    render(lossless, losslessRange).samples,
    mixed.samples.slice(firstLosslessSample * 2, lastLosslessSample * 2),
  );
  const losslessSplit = applyBatch(
    lossless,
    [
      {
        operation: "split",
        clipIds: ["voice-clip", "music-clip"],
        atUs: 333333,
        scope: "selected",
      },
    ],
    { assets: sources.map((source) => source.asset), namespace: "lossless-split" },
  );
  assert.deepEqual(render(losslessSplit.document).samples, mixed.samples);
  evidence.checks.push(
    "AIFF mono and ALAC stereo overlap preserves every WAV reference sample, fractional range and pure split",
  );
  const compressed = [];
  for (const [source, name, extension, codec, channels] of [
    [a, "voice-aac", "m4a", "aac", 1],
    [b, "music-mp3", "mp3", "libmp3lame", 2],
  ]) {
    const path = join(scratch, `${name}.${extension}`);
    const encoded = spawnSync(
      "ffmpeg",
      ["-nostdin", "-v", "error", "-i", source.binding.path, "-c:a", codec, "-b:a", "192k", path],
      { encoding: "utf8", timeout: 30000 },
    );
    assert.equal(encoded.status, 0, encoded.stderr || String(encoded.error));
    const probe = call("media.probe", { path });
    const stream = probe.streams.find((value) => value.kind === "audio");
    const available = [{ startUs: stream.startUs, endUs: stream.endUs }];
    const converted = {
      binding: { assetId: name, streamId: stream.id, path, originUs: probe.originUs },
      asset: {
        id: name,
        streams: [{ id: stream.id, kind: "audio", bounds: available[0], available }],
      },
    };
    sources.push(converted);
    const decoded = call("media.sourceAudio", {
      source: { source: path, streamId: stream.id, sourceOffsetUs: -probe.originUs, available },
      range: { startUs: 0, endUs: 1000000 },
      output: join(scratch, `${name}-decoded.wav`),
    });
    assert.equal(decoded.frames, 48000);
    compressed.push({ source: converted, pcm: wave(decoded.file, true, channels), channels });
  }
  const compressedDoc = {
    ...empty,
    tracks: compressed.map((_, i) => ({ id: `compressed-${i}`, kind: "audio", order: i })),
    clips: compressed.map((value, i) =>
      clip(`compressed-${i}`, value.source, `compressed-${i}`, 0, 1000000),
    ),
  };
  const compressedMix = render(compressedDoc).samples;
  for (let i = 0; i < compressedMix.length; i++)
    assert.equal(
      compressedMix[i],
      Math.fround(compressed[0].pcm[Math.floor(i / 2)] + compressed[1].pcm[i]),
      `compressed overlap sample ${i}`,
    );
  const compressedRange = { startUs: 123457, endUs: 812349 };
  const compressedWindow = render(compressedDoc, compressedRange).samples;
  const compressedExpected = compressedMix.slice(
    Math.floor((compressedRange.startUs * 48000) / 1000000) * 2,
    Math.floor((compressedRange.endUs * 48000) / 1000000) * 2,
  );
  assert.deepEqual(compressedWindow, compressedExpected);
  evidence.checks.push(
    "AAC mono and MP3 stereo mix matches selected-source decode and fractional range",
  );
  evidence.compressedEndpoints = [];
  for (const value of compressed) {
    const endUs = value.source.asset.streams[0].bounds.endUs;
    const endDocument = {
      ...empty,
      tracks: [{ id: "endpoint", kind: "audio", order: 0 }],
      clips: [clip("endpoint", value.source, "endpoint", 0, endUs)],
    };
    const full = render(endDocument, { startUs: 0, endUs });
    assert.equal(full.result.frames, Math.floor((endUs * 48000) / 1000000));
    assert.equal(full.samples.length, full.result.frames * 2);
    const range = { startUs: endUs - 20003, endUs };
    const tail = render(endDocument, range);
    const expected = full.samples.slice(Math.floor((range.startUs * 48000) / 1000000) * 2);
    assert.equal(tail.samples.length, expected.length);
    assert.equal(tail.result.frames, expected.length / 2);
    assert.deepEqual(tail.result.unavailable, [{ clipId: "endpoint", ranges: [] }]);
    let maximumError = 0,
      sumSquaredError = 0;
    for (let i = 0; i < expected.length; i++) {
      const error = Math.abs(tail.samples[i] - expected[i]);
      maximumError = Math.max(maximumError, error);
      sumSquaredError += error * error;
    }
    const rmsError = Math.sqrt(sumSquaredError / expected.length);
    // Only AAC has the independently established one-PCM16-step seek allowance.
    const limit = value.source.binding.assetId === "voice-aac" ? 1 / 32768 : 0;
    assert.ok(
      limit ? maximumError < limit && rmsError < limit : maximumError === 0,
      `${value.source.binding.assetId} tail maximum=${maximumError} rms=${rmsError}`,
    );
    evidence.compressedEndpoints.push({
      asset: value.source.binding.assetId,
      endUs,
      fullFrames: full.result.frames,
      tailFrames: tail.result.frames,
      maximumError,
      rmsError,
    });
  }
  evidence.checks.push(
    "compressed native endpoints retain exact counts and declared full/tail seek parity",
  );
  const withSilence = structuredClone(document);
  withSilence.tracks.push({ id: "silent-track", kind: "audio", order: 2 });
  withSilence.clips.push({
    id: "silence",
    trackId: "silent-track",
    source: { kind: "silence" },
    placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
  });
  assert.deepEqual(render(withSilence).samples, mixed.samples);
  evidence.checks.push("adding authored silence preserves all levels exactly");
  const split = applyBatch(
    document,
    [
      {
        operation: "split",
        clipIds: ["voice-clip"],
        atUs: 123457,
        scope: "selected",
      },
    ],
    { assets: sources.map((s) => s.asset), namespace: "mix-split" },
  );
  assert.deepEqual(render(split.document).samples, mixed.samples);
  const short = render(document, { startUs: 123457, endUs: 812349 });
  assert.deepEqual(short.samples, mixed.samples.slice(5925 * 2, 38992 * 2));
  evidence.checks.push(
    "48k pure split and non-sample-aligned late window preserve full mix samples",
  );
  const videoPath = fileURLToPath(
    new URL("../../../specs/done/agent-editing/assets/00-corpus/a.mov", import.meta.url),
  );
  const videoProbe = call("media.probe", { path: videoPath });
  const videoStream = videoProbe.streams.find((s) => s.kind === "video");
  const video = {
    binding: {
      assetId: "picture",
      streamId: videoStream.id,
      path: videoPath,
      originUs: videoProbe.originUs,
    },
    asset: {
      id: "picture",
      streams: [
        {
          id: videoStream.id,
          kind: "video",
          width: videoStream.orientedWidth,
          height: videoStream.orientedHeight,
          bounds: { startUs: videoStream.startUs, endUs: videoStream.endUs },
          available: [{ startUs: videoStream.startUs, endUs: videoStream.endUs }],
        },
      ],
    },
  };
  sources.push(video);
  const av = structuredClone(document);
  av.tracks.push({ id: "video-track", kind: "video", order: 0 });
  av.clips.push(clip("picture", video, "video-track", 0, 1000000));
  const beforeCompiler = createCompiler(
    validateComposition(
      av,
      sources.map((s) => s.asset),
    ),
    "before",
  );
  const replacement = applyBatch(
    av,
    [
      {
        operation: "replace",
        clipId: "voice-clip",
        kind: "audio",
        media: {
          assetId: b.binding.assetId,
          streamId: b.binding.streamId,
          source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
        },
      },
    ],
    { assets: sources.map((s) => s.asset), namespace: "replace" },
  );
  const afterCompiler = createCompiler(
    validateComposition(
      replacement.document,
      sources.map((s) => s.asset),
    ),
    "after",
  );
  assert.deepEqual(
    [...beforeCompiler.frames({ startUs: 0, endUs: 1000000 })],
    [...afterCompiler.frames({ startUs: 0, endUs: 1000000 })],
  );
  const replaced = render(replacement.document);
  assert.equal(replaced.samples[6000 * 2], b.samples[6000 * 2]);
  assert.notDeepEqual(replaced.samples, mixed.samples);
  evidence.checks.push(
    "audio replacement changes decoded PCM while video compiler schedule is identical",
  );
  const gapAsset = sources[0].asset.streams[0];
  const oldAvailable = gapAsset.available;
  gapAsset.available = [
    { startUs: 0, endUs: 250000 },
    { startUs: 500000, endUs: 2000000 },
  ];
  const gap = render({ ...document, clips: [document.clips[0]] });
  assert(gap.samples.slice(12000 * 2, 24000 * 2).every((value) => value === 0));
  assert.deepEqual(gap.result.unavailable, [
    { clipId: "voice-clip", ranges: [{ start: 12000, end: 24000 }] },
  ]);
  gapAsset.available = oldAvailable;
  evidence.checks.push("acquisition gaps remain silent and explicitly unavailable");
  const resampledSource = fixture(
    "44100",
    44100,
    1,
    (i) => 0.125 * Math.sin((2 * Math.PI * 400 * i) / 44100),
  );
  sources.push(resampledSource);
  const resampledDoc = {
    ...empty,
    tracks: [{ id: "t", kind: "audio", order: 0 }],
    clips: [clip("resampled", resampledSource, "t", 0, 1000000)],
  };
  const resampled = render(resampledDoc);
  let interiorError = 0;
  for (let i = 100; i < 47900; i++)
    interiorError = Math.max(
      interiorError,
      Math.abs(resampled.samples[i * 2] - 0.125 * Math.sin((2 * Math.PI * 400 * i) / 48000)),
    );
  assert.equal(resampled.samples.length, 96000);
  assert(interiorError < 0.002, `44.1k tone error ${interiorError}`);
  const resampledWindow = render(resampledDoc, {
    startUs: 123457,
    endUs: 812349,
  });
  let windowError = 0;
  for (let i = 0; i < resampledWindow.samples.length; i++)
    windowError = Math.max(
      windowError,
      Math.abs(resampledWindow.samples[i] - resampled.samples[5925 * 2 + i]),
    );
  for (const startUs of [1, 333, 20000, 21333, 21334, 666667, 999000]) {
    const window = render(resampledDoc, { startUs, endUs: 1000000 });
    assert.deepEqual(
      window.samples,
      resampled.samples.slice(Math.floor((startUs * 48000) / 1000000) * 2),
    );
  }
  const split441 = applyBatch(
    resampledDoc,
    [
      {
        operation: "split",
        clipIds: ["resampled"],
        atUs: 123457,
        scope: "selected",
      },
    ],
    { assets: sources.map((s) => s.asset), namespace: "split441" },
  );
  assert.deepEqual(render(split441.document).samples, resampled.samples);
  assert.equal(windowError, 0);
  const mixedRates = {
    ...resampledDoc,
    tracks: [...resampledDoc.tracks, { id: "native-rate", kind: "audio", order: 1 }],
    clips: [...resampledDoc.clips, clip("native-rate", b, "native-rate", 0, 1000000)],
  };
  const mixedRatePcm = render(mixedRates).samples;
  for (let i = 0; i < mixedRatePcm.length; i++)
    assert.equal(
      mixedRatePcm[i],
      Math.fround(resampled.samples[i] + b.samples[i]),
      `mixed-rate sample ${i}`,
    );
  const mixedRateRange = { startUs: 123457, endUs: 812349 };
  assert.deepEqual(
    render(mixedRates, mixedRateRange).samples,
    mixedRatePcm.slice(
      Math.floor((mixedRateRange.startUs * 48000) / 1000000) * 2,
      Math.floor((mixedRateRange.endUs * 48000) / 1000000) * 2,
    ),
  );
  const mixedRateSplit = applyBatch(
    mixedRates,
    [
      {
        operation: "split",
        clipIds: ["resampled", "native-rate"],
        atUs: 333333,
        scope: "selected",
      },
    ],
    { assets: sources.map((source) => source.asset), namespace: "mixed-rate-split" },
  );
  assert.deepEqual(render(mixedRateSplit.document).samples, mixedRatePcm);
  evidence.checks.push(
    "simultaneous44.1k mono and48k stereo sum exactly after resampling, retaining fractional window and split phase",
  );
  if (process.env.YAP_RATE_EVIDENCE)
    evidence.mixedCodecRates = verifyMixedCodecRates({
      out: process.env.YAP_RATE_EVIDENCE,
      cohort: process.env.YAP_RATE_COHORT,
      worker,
      fixture,
      sources,
      call,
      render,
      clip,
      empty,
      scratch,
      wave,
      reference48: b,
    });
  const excludedImpulse = fixture("excluded-impulse", 44100, 1, (i) => (i === 22049 ? 0.75 : 0));
  sources.push(excludedImpulse);
  const impulseDoc = {
    ...empty,
    tracks: [{ id: "i", kind: "audio", order: 0 }],
    clips: [clip("i", excludedImpulse, "i", 0, 1000000, 500000)],
  };
  const leakage = render(impulseDoc);
  const excludedImpulsePeak = Math.max(...leakage.samples.slice(0, 2048).map(Math.abs));
  let lastInfluencedFrame = -1;
  for (let i = 0; i < leakage.samples.length; i += 2)
    if (Math.abs(leakage.samples[i]) > 1e-9) lastInfluencedFrame = i / 2;
  assert.equal(
    excludedImpulsePeak,
    0,
    "No excluded source sample may enter retained resampling context",
  );
  evidence.resampling = {
    decoderContext: resampledWindow.result.decoderContext,
    lastInfluencedFrame,
    interiorError,
    lateWindowMaximumDifference: windowError,
    phaseAcceptance: windowError === 0,
    excludedImpulsePeak,
    exclusionAcceptance: excludedImpulsePeak === 0,
  };
  evidence.checks.push(
    "44.1k mono resamples to exact 48k stereo duration with expected interior tone",
  );
  const gapImpulse = fixture("gap-impulse", 44100, 1, (i) => (i === 33074 ? 0.75 : 0));
  sources.push(gapImpulse);
  gapImpulse.asset.streams[0].available = [
    { startUs: 0, endUs: 500000 },
    { startUs: 750000, endUs: 2000000 },
  ];
  const gapPoisonDoc = {
    ...empty,
    tracks: [{ id: "gp", kind: "audio", order: 0 }],
    clips: [clip("gp", gapImpulse, "gp", 0, 1000000)],
  };
  const gapPoison = render(gapPoisonDoc);
  assert(
    gapPoison.samples.every((sample) => sample === 0),
    "Acquisition-excluded impulse must not enter filter context",
  );
  assert.deepEqual(gapPoison.result.unavailable, [
    { clipId: "gp", ranges: [{ start: 24000, end: 36000 }] },
  ]);
  gapImpulse.asset.streams[0].available = [{ startUs: 0, endUs: 2000000 }];
  const anchorDoc = {
    ...gapPoisonDoc,
    tracks: [...gapPoisonDoc.tracks, { id: "anchor", kind: "video", order: 0 }],
    clips: [...gapPoisonDoc.clips, clip("anchor", video, "anchor", 0, 1000000)],
  };
  anchorDoc.clips[0] = {
    ...anchorDoc.clips[0],
    placement: {
      kind: "clip",
      clipId: "anchor",
      start: { numerator: 0, denominator: 1 },
      end: { numerator: 1, denominator: 1 },
    },
  };
  const videoAvailable = video.asset.streams[0].available;
  video.asset.streams[0].available = [
    { startUs: 0, endUs: 500000 },
    { startUs: 750000, endUs: videoStream.endUs },
  ];
  const anchorPoison = render(anchorDoc);
  assert(
    anchorPoison.samples.every((sample) => sample === 0),
    "Anchor-unavailable impulse must not enter filter context",
  );
  assert.deepEqual(anchorPoison.result.unavailable, [
    { clipId: "gp", ranges: [{ start: 24000, end: 36000 }] },
  ]);
  video.asset.streams[0].available = videoAvailable;
  evidence.checks.push(
    "excluded selection, acquisition-gap and anchor-gap impulses cannot influence selected PCM",
  );
  const cutTime = { numerator: 370375, denominator: 3 }; //5926 output samples.
  const cutDoc = {
    ...empty,
    tracks: [{ id: "t", kind: "audio", order: 0 }],
    clips: [clip("resampled", a, "t", 0, 1000000)],
  };
  cutDoc.clips[0].source.range.endUs = cutTime;
  cutDoc.clips[0].placement.range.endUs = cutTime;
  cutDoc.clips.push({
    ...clip("cut-right", a, "t", 0, 750000, 250000),
    placement: {
      kind: "project",
      range: {
        startUs: cutTime,
        endUs: { numerator: 2620375, denominator: 3 },
      },
    },
  });
  const cut = render(cutDoc, { startUs: 0, endUs: 873459 });
  const reference48 = a.samples.slice(0, 48000).flatMap((value) => [value, value]);
  const expectedCut = [...reference48.slice(0, 5926 * 2), ...reference48.slice(12000 * 2)];
  assert.deepEqual(cut.samples, expectedCut);
  evidence.checks.push(
    "rational-time abrupt true cut preserves selected source samples with no extra sample or hidden ramp",
  );
  const fractionalOrigin = {
    ...empty,
    tracks: [{ id: "origin", kind: "audio", order: 0 }],
    clips: [clip("origin", a, "origin", 1, 1000000, 1)],
  };
  const fractional = render(fractionalOrigin);
  assert.deepEqual(fractional.samples, reference48);
  evidence.checks.push("fractional retained-run origin follows nearest native source selection");
  // This comparison attests migration parity against a separately frozen old worker.
  const phaseCases = [];
  for (const sourceStartUs of [500000, 500001, 500010, 500011, 500020, 500021]) {
    const frozen = call(
      "media.audio",
      {
        output: join(scratch, `frozen-${sourceStartUs}.wav`),
        spans: [{ startUs: sourceStartUs, endUs: sourceStartUs + 500000 }],
        tracks: [
          {
            role: "narration",
            source: a.binding.path,
            sourceOffsetUs: 0,
            available: [{ startUs: 0, endUs: 2000000 }],
          },
        ],
      },
      undefined,
      baseline,
    );
    const expected = wave(frozen.file, true, 1).flatMap((value) => [value, value]);
    for (const projectStartUs of [0, 10001]) {
      const phaseDoc = {
        ...empty,
        tracks: [{ id: "phase", kind: "audio", order: 0 }],
        clips: [clip("phase", a, "phase", projectStartUs, projectStartUs + 500000, sourceStartUs)],
      };
      const range = { startUs: projectStartUs, endUs: projectStartUs + 500000 };
      const whole = render(phaseDoc, range);
      assert.deepEqual(whole.samples, expected);
      const split = applyBatch(
        phaseDoc,
        [
          {
            operation: "split",
            clipIds: ["phase"],
            atUs: projectStartUs + 123457,
            scope: "selected",
          },
        ],
        { assets: sources.map((s) => s.asset), namespace: "phase-split" },
      );
      assert.deepEqual(render(split.document, range).samples, expected);
      const late = render(phaseDoc, {
        startUs: projectStartUs + 123457,
        endUs: range.endUs,
      });
      assert.deepEqual(
        late.samples,
        expected.slice(
          (Math.floor((projectStartUs + 123457) * 0.048) - Math.floor(projectStartUs * 0.048)) * 2,
        ),
      );
      phaseCases.push({
        sourceStartUs,
        projectStartUs,
        frames: whole.result.frames,
      });
    }
  }
  const shortage = {
    ...fractionalOrigin,
    clips: [clip("origin", a, "origin", 11, 1000000, 11)],
  };
  assert.deepEqual(render(shortage).samples, [...reference48.slice(2), 0, 0]);
  for (const sourceStartUs of [1, 11, 12, 500001, 500012, 500023]) {
    const phaseDoc = {
      ...empty,
      tracks: [{ id: "rphase", kind: "audio", order: 0 }],
      clips: [clip("rphase", resampledSource, "rphase", 10001, 510001, sourceStartUs)],
    };
    const range = { startUs: 10001, endUs: 510001 };
    const whole = render(phaseDoc, range);
    const split = applyBatch(
      phaseDoc,
      [
        {
          operation: "split",
          clipIds: ["rphase"],
          atUs: 133458,
          scope: "selected",
        },
      ],
      { assets: sources.map((s) => s.asset), namespace: "rphase-split" },
    );
    assert.deepEqual(render(split.document, range).samples, whole.samples);
    assert.deepEqual(
      render(phaseDoc, { startUs: 133458, endUs: 510001 }).samples,
      whole.samples.slice((Math.floor(133458 * 0.048) - 480) * 2),
    );
  }
  for (const sampleRate of [44100, 48000]) {
    const poison = fixture(`discrete-poison-${sampleRate}`, sampleRate, 1, (i) =>
      i === 0 ? 0.75 : 0,
    );
    sources.push(poison);
    const poisoned = {
      ...empty,
      tracks: [{ id: "poison", kind: "audio", order: 0 }],
      clips: [clip("poison", poison, "poison", 0, 500000, 20)],
    };
    assert(render(poisoned, { startUs: 0, endUs: 500000 }).samples.every((value) => value === 0));
  }
  evidence.phaseCases = phaseCases;
  evidence.checks.push(
    "fractional trims match frozen nearest source selection; whole/split/window PCM equality and bounded zero endpoint extension",
  );
  const longDoc = {
    ...empty,
    tracks: [{ id: "long", kind: "audio", order: 0 }],
    clips: Array.from({ length: 128 }, (_, i) =>
      clip(`long-${i}`, a, "long", i * 1000001, (i + 1) * 1000001),
    ),
  };
  // Absolute output origins survive fractional microsecond edits.
  render(longDoc, { startUs: 0, endUs: 128000128 }, undefined, false);
  function frameTime(frame) {
    let numerator = frame * 125,
      denominator = 6,
      a = numerator,
      b = denominator;
    while (b) [a, b] = [b, a % b];
    numerator /= a;
    denominator /= a;
    return denominator === 1 ? numerator : { numerator, denominator };
  }
  for (let i = 0; i < longDoc.clips.length; i++) {
    longDoc.clips[i].source.range.endUs = frameTime(48001);
    longDoc.clips[i].placement.range = {
      startUs: frameTime(i * 48001),
      endUs: frameTime((i + 1) * 48001),
    };
  }
  const started = performance.now();
  const long = render(longDoc, { startUs: 0, endUs: 128002667 }, undefined, false);
  assert.equal(long.samples, 6144128);
  assert.equal(long.result.frames, 6144128);
  evidence.longExecution = {
    frames: long.result.frames,
    elapsedMs: performance.now() - started,
    maximumBlockFrames: long.result.maximumBlockFrames,
    peakResidentBytes: long.result.peakResidentBytes,
    shortPeakResidentBytes: mixed.result.peakResidentBytes,
  };
  assert(long.result.maximumBlockFrames <= 8192);
  evidence.checks.push(
    "128 fractional-microsecond edits produce exactly6144128 frames with bounded block delivery; fractional phase executes with compiler-owned origins",
  );
  const loud = structuredClone(document);
  loud.processing = [gain("output", null, [4])];
  const over = render(loud);
  assert.equal(over.result.peak, 3);
  assert.equal(over.samples[0], 3);
  assert(over.result.clippedSamples > 0);
  evidence.checks.push("out-of-range float samples preserved with explicit peak/clipping report");
  const retimed = structuredClone(document);
  retimed.clips[0].placement.range.endUs = 900000;
  render(retimed, undefined, "NOT_READY");
  call(
    "media.mixCompositionAudio",
    { ...mixed.params, output: join(scratch, "unknown.wav"), unknown: 1 },
    "INVALID_REQUEST",
  );
  const wrongStream = structuredClone(mixed.params);
  wrongStream.output = join(scratch, "missing-stream.wav");
  wrongStream.clips.find((clip) => clip.clipId === "voice-clip").source.streamId =
    "track:2147483647";
  wrongStream.assets.find((asset) => asset.assetId === a.binding.assetId).streamId =
    "track:2147483647";
  call("media.mixCompositionAudio", wrongStream, "NATIVE_DECODE_FAILED");
  evidence.checks.push("retiming and unknown request fields rejected explicitly");
  const cancelledOutput = join(scratch, "cancelled.wav");
  const child = spawn(worker, [], { stdio: ["pipe", "pipe", "pipe"] });
  let terminal = false;
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      terminal = true;
      resolve({ code, signal });
    });
  });
  child.stdin.end(
    JSON.stringify({
      id: "cancel",
      operation: "media.mixCompositionAudio",
      params: {
        ...silence.params,
        output: cancelledOutput,
        range: { start: 0, end: 48000 * 3600 },
      },
    }) + "\n",
  );
  try {
    let began = false;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !terminal) {
      began = readdirSync(scratch)
        .filter((name) => name.startsWith(".yap-output-"))
        .some((name) => {
          const file = join(scratch, name, "mix.wav");
          return existsSync(file) && statSync(file).size > 100000;
        });
      if (began) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert(began, "cancel test must observe actual unfinished file writes");
    child.kill("SIGTERM");
    await exited;
    assert.equal(existsSync(cancelledOutput), false);
  } finally {
    if (!terminal) {
      child.kill("SIGKILL");
      await exited;
    }
  }
  assert.equal(render(empty).result.frames, 48000);
  evidence.checks.push(
    "cancelled native process publishes no partial output; fresh worker can restart",
  );
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
