import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createCompiler, validateComposition, applyBatch } from "../../composition/dist/index.js";

const [fixtureDirectory, outputDirectory] = process.argv.slice(2).map((path) => resolve(path));
assert.ok(
  fixtureDirectory && outputDirectory,
  "Existing native SourceAudio fixture and fresh output directory required",
);
const worker = process.env.YAP_NATIVE;
assert.ok(worker);
mkdirSync(outputDirectory);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
let sequence = 0;
function native(operation, params) {
  const result = spawnSync(worker, [], {
    input: JSON.stringify({ id: String(++sequence), operation, params }) + "\n",
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  const reply = JSON.parse(result.stdout);
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply.data;
}
function pcm(path) {
  const bytes = readFileSync(path);
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
  for (let p = 12; p + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(p + 4);
    if (bytes.toString("ascii", p, p + 4) === "fmt ") {
      assert.equal(bytes.readUInt16LE(p + 8), 3);
      assert.equal(bytes.readUInt16LE(p + 10), 2);
      assert.equal(bytes.readUInt32LE(p + 12), 48000);
      assert.equal(bytes.readUInt16LE(p + 22), 32);
    }
    if (bytes.toString("ascii", p, p + 4) === "data") return bytes.subarray(p + 8, p + 8 + size);
    p += 8 + size + (size % 2);
  }
  assert.fail("Missing PCM");
}
const report = { workerSha256: hash(readFileSync(worker)), cases: [], passed: false };
for (const rate of [44100, 48000]) {
  const request = JSON.parse(readFileSync(join(fixtureDirectory, `request-${rate}.json`)));
  const source = request.source;
  const originalHash = hash(readFileSync(source.source));
  const asset = {
    id: "source",
    streams: [
      { id: source.streamId, kind: "audio", bounds: request.range, available: source.available },
    ],
  };
  const document = {
    canvas: {
      width: 160,
      height: 96,
      fps: { numerator: 10, denominator: 1 },
      background: "#000000ff",
    },
    tracks: [{ id: "audio", kind: "audio", order: 0 }],
    groups: [],
    processing: [],
    syncGroups: [],
    clips: [
      {
        id: "clip",
        assetId: asset.id,
        streamId: source.streamId,
        trackId: "audio",
        source: { kind: "range", range: request.range },
        placement: { kind: "project", range: request.range },
      },
    ],
  };
  function render(doc, range, path = source.source) {
    const model = validateComposition(doc, [asset]);
    const window = createCompiler(model, "segments").window({
      range,
      rendition: { sampleRate: 48000, channels: 2 },
      tap: { target: { kind: "output" }, point: { kind: "processed" } },
    });
    const result = native("media.mixCompositionAudio", {
      output: join(outputDirectory, `${rate}-${sequence}.wav`),
      range: window.manifest.sampleRange,
      clips: [...window.audio()],
      processing: window.processing(),
      assets: [
        { assetId: asset.id, streamId: source.streamId, path, originUs: -source.sourceOffsetUs },
      ],
    });
    const bytes = pcm(result.file);
    assert.equal(
      bytes.length,
      (Math.floor((range.endUs * 48000) / 1000000) -
        Math.floor((range.startUs * 48000) / 1000000)) *
        8,
    );
    return { result, bytes };
  }
  const full = render(document, request.range);
  const missing = [
    { start: 9600, end: 14400 },
    { start: 19200, end: 28800 },
    { start: 47999, end: 48000 },
  ];
  assert.deepEqual(full.result.unavailable, [{ clipId: "clip", ranges: missing }]);
  for (const range of missing) {
    assert.ok(
      full.bytes.subarray(range.start * 8, range.end * 8).every((value) => value === 0),
      "Unavailable samples must be silent",
    );
  }
  if (rate === 48000) assert.ok(full.bytes.equals(pcm(join(fixtureDirectory, "full-48000.wav"))));
  const windows = [];
  for (const range of [
    { startUs: 71, endUs: 199991 },
    { startUs: 199997, endUs: 600013 },
    { startUs: 610013, endUs: 999981 },
  ]) {
    const part = render(document, range);
    assert.ok(
      part.bytes.equals(
        full.bytes.subarray(
          Math.floor((range.startUs * 48000) / 1000000) * 8,
          Math.floor((range.endUs * 48000) / 1000000) * 8,
        ),
      ),
      "Segment query changed PCM",
    );
    windows.push({ range, sha256: hash(part.bytes), frames: part.result.frames });
  }
  const split = applyBatch(
    document,
    [{ operation: "split", clipIds: ["clip"], atUs: 333333, scope: "selected" }],
    { assets: [asset], namespace: `segments-${rate}` },
  );
  assert.ok(render(split.document, request.range).bytes.equals(full.bytes));
  const poison = render(
    document,
    request.range,
    join(fixtureDirectory, `poison-selected-${rate}.mov`),
  );
  assert.ok(poison.bytes.equals(full.bytes), "Excluded source poison leaked into composition");
  assert.equal(hash(readFileSync(source.source)), originalHash);
  report.cases.push({
    rate,
    sourceSha256: originalHash,
    originUs: -source.sourceOffsetUs,
    fullPcmSha256: hash(full.bytes),
    frames: full.result.frames,
    unavailable: full.result.unavailable,
    windows,
    splitExact: true,
    poisonExact: true,
  });
}
report.passed = true;
writeFileSync(join(outputDirectory, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
