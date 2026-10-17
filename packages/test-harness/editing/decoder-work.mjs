import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createCompiler, validateComposition } from "../../composition/dist/index.js";

const worker = process.env.YAP_NATIVE;
assert(worker, "Set YAP_NATIVE to the native worker");
assert(
  process.env.YAP_LONG_AAC,
  "Set YAP_LONG_AAC to the retained3000s marker; no fixture download or generation",
);
const enforceReadAhead = process.argv[3] === "--enforce-read-ahead";
assert(
  process.argv.length === 3 || (process.argv.length === 4 && enforceReadAhead),
  "Unknown argument",
);
const out = resolve(process.argv[2]);
mkdirSync(out, { recursive: true });
let sequence = 0;
const evidence = {
  accountingPassed: false,
  scope: "Native source decode/descriptor work; not scratch IO or physical disk bytes",
  workerSHA256: hash(worker),
  cases: [],
};
function hash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function call(operation, params, descriptor) {
  const fd = descriptor ? openSync(descriptor, "r") : undefined;
  try {
    const reply = spawnSync(worker, [], {
      input: JSON.stringify({ id: String(++sequence), operation, params }) + "\n",
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 1024 ** 2,
      stdio: fd === undefined ? undefined : ["pipe", "pipe", "pipe", fd],
    });
    assert.equal(reply.status, 0, reply.stderr || String(reply.error));
    const response = JSON.parse(reply.stdout);
    assert.equal(response.ok, true, JSON.stringify(response));
    return response.data;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
function pcm(path) {
  const bytes = readFileSync(path);
  for (let i = 12; i + 8 <= bytes.length;) {
    const length = bytes.readUInt32LE(i + 4);
    if (bytes.toString("ascii", i, i + 4) === "data") return bytes.subarray(i + 8, i + 8 + length);
    i += 8 + length + (length % 2);
  }
  assert.fail("Missing WAV PCM");
}
const rate = 48000,
  seconds = 60;
const source = join(out, "source.wav"),
  frames = rate * seconds;
const bytes = Buffer.alloc(44 + frames * 4);
bytes.write("RIFF");
bytes.writeUInt32LE(bytes.length - 8, 4);
bytes.write("WAVEfmt ", 8);
bytes.writeUInt32LE(16, 16);
bytes.writeUInt16LE(1, 20);
bytes.writeUInt16LE(2, 22);
bytes.writeUInt32LE(rate, 24);
bytes.writeUInt32LE(rate * 4, 28);
bytes.writeUInt16LE(4, 32);
bytes.writeUInt16LE(16, 34);
bytes.write("data", 36);
bytes.writeUInt32LE(frames * 4, 40);
for (let i = 0; i < frames; i++) {
  bytes.writeInt16LE(((i * 13) % 16384) - 8192, 44 + i * 4);
  bytes.writeInt16LE(((i * 37) % 8192) - 4096, 46 + i * 4);
}
writeFileSync(source, bytes);
const probe = call("media.probe", { path: source });
const stream = probe.streams.find((s) => s.kind === "audio");
const asset = {
  id: "a",
  streams: [
    {
      id: stream.id,
      kind: "audio",
      sampleRate: stream.sampleRate,
      channels: stream.channels,
      bounds: { startUs: 0, endUs: seconds * 1e6 },
      available: [{ startUs: 0, endUs: seconds * 1e6 }],
    },
  ],
};
const document = {
  canvas: {
    width: 640,
    height: 480,
    fps: { numerator: 30, denominator: 1 },
    background: "#000000ff",
  },
  tracks: [{ id: "t", kind: "audio", order: 0 }],
  groups: [],
  processing: [],
  syncGroups: [],
  clips: [
    {
      id: "c",
      assetId: "a",
      streamId: stream.id,
      trackId: "t",
      source: { kind: "range", range: { startUs: 0, endUs: seconds * 1e6 } },
      placement: { kind: "project", range: { startUs: 0, endUs: seconds * 1e6 } },
    },
  ],
};
function render(
  label,
  range,
  descriptor = false,
  doc = document,
  fixture = { source, asset, probe, stream },
) {
  const { source, asset, probe, stream } = fixture;
  const window = createCompiler(validateComposition(doc, [asset]), "fixed-context").audioWindow({
    range,
    rendition: { sampleRate: rate, channels: 2 },
    tap: { target: { kind: "output" }, point: { kind: "processed" } },
  });
  const state = window.audioState();
  const params = {
    ...(state
      ? { state: { ...state, implementationId: call("media.audioCapabilities", {}).rnnoise } }
      : {}),
    output: join(out, `${label}.wav`),
    range: { start: (range.startUs * rate) / 1e6, end: (range.endUs * rate) / 1e6 },
    clips: [...window.audio()],
    processing: window.processing(),
    assets: [
      {
        assetId: "a",
        streamId: stream.id,
        path: descriptor ? "/dev/fd/3" : source,
        originUs: probe.originUs,
      },
    ],
  };
  const receipt = call("media.mixCompositionAudio", params, descriptor ? source : undefined);
  evidence.cases.push({ label, request: params, receipt, sha256: hash(receipt.file) });
  writeFileSync(join(out, "report.json"), JSON.stringify(evidence, null, 2));
  return { receipt, pcm: pcm(receipt.file) };
}
try {
  const late = render("late-url", { startUs: 59e6, endUs: 59.02e6 });
  assert(late.receipt.sourceWork, "Native receipt must expose actual source work");
  assert.equal(late.receipt.sourceWork.unknownReadInputs, 1);
  assert.equal(late.receipt.sourceWork.descriptorInputs, 0);
  const decoded = late.receipt.sourceWork.decoded;
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0].sampleRate, rate);
  assert(
    decoded[0].frames >= 960 && decoded[0].frames <= 48000,
    "Late decode must not read a60s prefix",
  );
  assert.equal(decoded[0].float32Bytes, decoded[0].frames * 8);
  const full = render("full-url", { startUs: 0, endUs: seconds * 1e6 });
  assert.deepEqual(late.pcm, full.pcm.subarray(59 * rate * 8, (59 * rate + 960) * 8));
  assert.equal(full.receipt.sourceWork.decoded[0].frames, frames);
  const inherited = render("late-descriptor", { startUs: 59e6, endUs: 59.02e6 }, true);
  assert.deepEqual(inherited.pcm, late.pcm);
  assert.equal(inherited.receipt.sourceWork.unknownReadInputs, 0);
  assert.equal(inherited.receipt.sourceWork.descriptorInputs, 1);
  assert(inherited.receipt.sourceWork.descriptorDeliveredBytes > 0);
  assert.equal(
    inherited.receipt.sourceWork.descriptorReadBytes,
    inherited.receipt.sourceWork.descriptorDeliveredBytes + 12,
  );
  const omitted = render("omitted", { startUs: 60e6, endUs: 60.02e6 });
  assert.deepEqual(omitted.receipt.sourceWork.decoded, []);
  assert.equal(omitted.receipt.sourceWork.unknownReadInputs, 0);
  assert(omitted.pcm.every((v) => v === 0));
  assert(
    inherited.receipt.sourceWork.descriptorReadBytes <= rate * 4 + 2 * 4 + 64 * 1024,
    "Late20ms WAV reads at most its physical one-second tail plus bounded metadata",
  );
  evidence.metadataPassed = true;
  evidence.descriptorIO = {
    sourceBytes: bytes.length,
    lateReadBytes: inherited.receipt.sourceWork.descriptorReadBytes,
    smallerThanWholeSource: inherited.receipt.sourceWork.descriptorReadBytes < bytes.length,
  };
  // Two separated retained runs replace interval readers; account for both, without decoding the hole.
  const fragmentedDoc = structuredClone(document);
  fragmentedDoc.clips = [0, 1].map((i) => ({
    ...document.clips[0],
    id: `f${i}`,
    source: {
      kind: "range",
      range: { startUs: (i ? 59 : 1) * 1e6, endUs: (i ? 59 : 1) * 1e6 + 20000 },
    },
    placement: { kind: "project", range: { startUs: i * 40000, endUs: i * 40000 + 20000 } },
  }));
  const fragmented = render("fragmented", { startUs: 0, endUs: 60000 }, false, fragmentedDoc);
  const first = render("early", { startUs: 1e6, endUs: 1.02e6 });
  assert.deepEqual(fragmented.pcm, Buffer.concat([first.pcm, Buffer.alloc(960 * 8), late.pcm]));
  assert.equal(
    fragmented.receipt.sourceWork.decoded[0].frames,
    first.receipt.sourceWork.decoded[0].frames + late.receipt.sourceWork.decoded[0].frames,
  );
  assert.equal(fragmented.receipt.sourceWork.unknownReadInputs, 1, "Shared source counted once");
  const gappedAsset = structuredClone(asset);
  gappedAsset.streams[0].available = [
    { startUs: 1e6, endUs: 1.02e6 },
    { startUs: 59e6, endUs: 59.02e6 },
  ];
  const sameInput = render("same-input-gaps", { startUs: 1e6, endUs: 59.02e6 }, false, document, {
    source,
    asset: gappedAsset,
    probe,
    stream,
  });
  assert.deepEqual(sameInput.pcm.subarray(0, 960 * 8), first.pcm);
  assert(sameInput.pcm.subarray(960 * 8, -960 * 8).every((v) => v === 0));
  assert.deepEqual(sameInput.pcm.subarray(-960 * 8), late.pcm);
  assert.equal(
    sameInput.receipt.sourceWork.decoded[0].frames,
    fragmented.receipt.sourceWork.decoded[0].frames,
  );
  const learnedDoc = structuredClone(fragmentedDoc);
  learnedDoc.processing = [
    {
      target: { kind: "track", id: "t" },
      steps: [{ id: "denoise", enabled: true, processor: { type: "rnnoise" } }],
    },
  ];
  const learned = render("prepared", { startUs: 0, endUs: 60000 }, false, learnedDoc);
  assert.equal(
    learned.receipt.sourceWork.decoded[0].frames,
    fragmented.receipt.sourceWork.decoded[0].frames,
    "Preparation decode must be included once, not recursively counted across members",
  );
  const learnedLate = render("prepared-late", { startUs: 40000, endUs: 60000 }, false, learnedDoc);
  assert.deepEqual(learnedLate.pcm, learned.pcm.subarray(1920 * 8));
  assert.equal(
    learnedLate.receipt.sourceWork.decoded[0].frames,
    learned.receipt.sourceWork.decoded[0].frames,
  );
  const resampledSource = join(out, "source-44100.wav");
  const conversion = spawnSync(
    "ffmpeg",
    ["-v", "error", "-nostdin", "-i", source, "-ar", "44100", resampledSource],
    { encoding: "utf8", timeout: 30000 },
  );
  assert.equal(conversion.status, 0, conversion.stderr);
  const resampledProbe = call("media.probe", { path: resampledSource });
  const resampledStream = resampledProbe.streams.find((s) => s.kind === "audio");
  const resampledAsset = structuredClone(asset);
  Object.assign(resampledAsset.streams[0], {
    id: resampledStream.id,
    sampleRate: resampledStream.sampleRate,
  });
  const resampledFixture = {
    source: resampledSource,
    probe: resampledProbe,
    stream: resampledStream,
    asset: resampledAsset,
  };
  const resampledFull = render(
    "resampled-full",
    { startUs: 0, endUs: seconds * 1e6 },
    false,
    document,
    resampledFixture,
  );
  const resampledLate = render(
    "resampled-late",
    { startUs: 59e6, endUs: 59.02e6 },
    false,
    document,
    resampledFixture,
  );
  assert.deepEqual(
    resampledLate.pcm,
    resampledFull.pcm.subarray(59 * rate * 8, (59 * rate + 960) * 8),
  );
  assert.equal(resampledLate.receipt.sourceWork.decoded[0].sampleRate, 44100);
  assert(
    resampledLate.receipt.sourceWork.decoded[0].frames > 882,
    "Conversion context must count as decoded work",
  );
  assert(resampledLate.receipt.sourceWork.decoded[0].frames <= 44100);
  assert(resampledLate.receipt.decoderContext.maximumPrerollFrames > 0);
  // Existing retained marker: no new long encode or full-prefix render is required.
  {
    const retained = process.env.YAP_LONG_AAC;
    const compressed = join(out, "retained-marker.m4a");
    copyFileSync(retained, compressed);
    const p = call("media.probe", { path: compressed });
    const st = p.streams.find((v) => v.kind === "audio");
    const a = {
      id: "a",
      streams: [
        {
          id: st.id,
          kind: "audio",
          bounds: { startUs: st.startUs, endUs: st.endUs },
          available: [{ startUs: st.startUs, endUs: st.endUs }],
        },
      ],
    };
    const compressedDoc = structuredClone(document);
    compressedDoc.clips[0].streamId = st.id;
    compressedDoc.clips[0].source.range.endUs = 3000e6;
    compressedDoc.clips[0].placement.range.endUs = 3000e6;
    const fixture = { source: compressed, asset: a, stream: st, probe: p };
    evidence.retainedAAC = {
      path: retained,
      sha256: hash(compressed),
      sourceBytes: readFileSync(compressed).length,
    };
    const broad = render(
      "aac-tail",
      { startUs: 2998e6, endUs: 3000e6 },
      false,
      compressedDoc,
      fixture,
    );
    const narrow = render(
      "aac-late",
      { startUs: 2999e6, endUs: 2999.02e6 },
      true,
      compressedDoc,
      fixture,
    );
    const expected = broad.pcm.subarray(48000 * 8, 48960 * 8);
    assert.equal(narrow.pcm.length, expected.length);
    let maximum = 0,
      squared = 0;
    for (let i = 0; i < expected.length; i += 4) {
      const difference = Math.abs(expected.readFloatLE(i) - narrow.pcm.readFloatLE(i));
      maximum = Math.max(maximum, difference);
      squared += difference ** 2;
    }
    const rms = Math.sqrt(squared / (expected.length / 4));
    assert(maximum < 1 / 32768 && rms < 1 / 32768, "Inherited AAC numerical conformance");
    evidence.aacComparison = { maximum, rms, comparedSamples: expected.length / 4 };
    assert(
      narrow.receipt.sourceWork.decoded[0].frames <= 48000,
      "AAC late decode read a source prefix",
    );
    assert.equal(narrow.receipt.sourceWork.unknownReadInputs, 0);
  }
  // A two-hour logical file with only header and late marker allocated; never hash/copy its holes.
  const sparse = join(out, "two-hour-sparse.wav");
  const sparseFrames = 7200 * rate;
  const sparseHeader = Buffer.from(bytes.subarray(0, 44));
  sparseHeader.writeUInt32LE(36 + sparseFrames * 8, 4);
  sparseHeader.writeUInt16LE(3, 20);
  sparseHeader.writeUInt32LE(rate * 8, 28);
  sparseHeader.writeUInt16LE(8, 32);
  sparseHeader.writeUInt16LE(32, 34);
  sparseHeader.writeUInt32LE(sparseFrames * 8, 40);
  const marker = Buffer.alloc(960 * 8);
  for (let i = 0; i < 960; i++) {
    marker.writeFloatLE((i % 32) / 128, i * 8);
    marker.writeFloatLE(i % 16 === 0 ? 0 : -(i % 16) / 128, i * 8 + 4);
  }
  const sparseFD = openSync(sparse, "wx+");
  try {
    try {
      ftruncateSync(sparseFD, 44 + sparseFrames * 8);
      writeSync(sparseFD, sparseHeader, 0, sparseHeader.length, 0);
      for (const second of [1, 3600, 7199])
        writeSync(sparseFD, marker, 0, marker.length, 44 + second * rate * 8);
    } finally {
      closeSync(sparseFD);
    }
    const storage = statSync(sparse);
    assert(
      storage.blocks * 512 < 1024 ** 2,
      "Sparse fixture unexpectedly allocated its logical size",
    );
    const sparseProbe = call("media.probe", { path: "/dev/fd/3" }, sparse);
    const sparseStream = sparseProbe.streams.find((s) => s.kind === "audio");
    const sparseAsset = structuredClone(asset);
    Object.assign(sparseAsset.streams[0], {
      bounds: { startUs: 0, endUs: 7200e6 },
      available: [{ startUs: 0, endUs: 7200e6 }],
    });
    const sparseDoc = structuredClone(document);
    sparseDoc.clips[0].source.range.endUs = 7200e6;
    sparseDoc.clips[0].placement.range.endUs = 7200e6;
    evidence.readAhead = {
      passed: true,
      enforced: enforceReadAhead,
      maximumBytes: 4 * rate * 8 + 2 * 8 + 64 * 1024,
      observations: [],
    };
    for (const second of [1, 3600, 7199]) {
      const sparseResult = render(
        `two-hour-${second}`,
        { startUs: second * 1e6, endUs: second * 1e6 + 20000 },
        true,
        sparseDoc,
        { source: sparse, asset: sparseAsset, probe: sparseProbe, stream: sparseStream },
      );
      assert.deepEqual(sparseResult.pcm, marker);
      assert(
        sparseResult.receipt.sourceWork.decoded[0].frames <= 960 + 3,
        "PCM decoding exceeds selected frames, two lookbehind frames and one endpoint cell",
      );
      const readBytes = sparseResult.receipt.sourceWork.descriptorReadBytes;
      const passed = readBytes <= evidence.readAhead.maximumBytes;
      evidence.readAhead.observations.push({ second, readBytes, passed });
      evidence.readAhead.passed &&= passed;
    }
    evidence.sparse = {
      logicalBytes: storage.size,
      allocatedBytes: storage.blocks * 512,
      markerSHA256: createHash("sha256").update(marker).digest("hex"),
      markerStartFrames: [1, 3600, 7199].map((second) => second * rate),
    };
  } finally {
    unlinkSync(sparse);
  }
  evidence.accountingPassed = true;
  if (enforceReadAhead)
    assert(
      evidence.readAhead.passed,
      "Open sparse read-ahead gate exceeded; preserve failure for finite-reader-range owner",
    );
} finally {
  writeFileSync(join(out, "report.json"), JSON.stringify(evidence, null, 2));
}
console.log(JSON.stringify(evidence));
