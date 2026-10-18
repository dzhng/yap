import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rm,
  realpath,
  rename,
  readdir,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { raster } from "../../../apps/macos/tests/fixtures/generated-capture.mjs";
import { sourceFrame, width, height, fps, sourceEvents } from "./retiming-fixture.mjs";
import { JourneyService, hash, poll, run } from "./source-evidence-fixture.mjs";
import { waveHeader } from "./audio-project-fixture.mjs";
import { tonePitch } from "./stretch-measurements.mjs";

const { values } = parseArgs({ options: { case: { type: "string" }, out: { type: "string" } } });
assert.equal(values.case, "linked-and-independent");
assert(values.out && process.env.YAP_NATIVE, "Use --out and a frozen YAP_NATIVE");
const out = resolve(values.out);
await mkdir(out);
const home = await realpath(await mkdtemp("/tmp/yap-retiming-"));
const receiverHome = await realpath(await mkdtemp("/tmp/yap-retiming-receiver-"));
const rate = 48000;
const full = { startUs: 0, endUs: 4000000 };
const report = {
  passed: false,
  trace: [],
  exchanges: [],
  checks: {},
  receipts: {},
  frames: [],
  failures: [],
  nativeSha256: hash(await readFile(process.env.YAP_NATIVE)),
  harnessSha256: hash(await readFile(new URL(import.meta.url))),
  runtime: process.version,
  scope:
    "Synthetic public linked/independent retiming, delivered PCM/video and retained lifecycle; no listening claim",
  synchronization: {
    authoredBurstWidthUs: 24000,
    frameIntervalUs: 1000000 / fps,
    audioMappingTolerance:
      "rendered burst half-support (12000 / playback rate) plus one 48k sample",
    encodedLandmarkTolerance:
      "one 30fps frame interval plus rendered burst half-support plus one 48k sample",
    detector:
      "Independent 1ms energy bins, one contiguous above-threshold event in each 400ms search interval; energy centroid",
    videoCounterOracle:
      "At exact project time i/30: source counter i before frame30, 30+floor(4*(i-30)/5) before frame105, i-15 thereafter. Integer microsecond labels do not choose pictures.",
    rmsThreshold: 0.08,
  },
};
const save = () => writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
let service = new JourneyService(home, report, join(out, "native"));
const call = async (...args) => {
  const first = report.exchanges.length;
  try {
    return await service.call(...args);
  } finally {
    // Transport evidence binds delivered media without copying base64 PCM into JSON.
    for (const exchange of report.exchanges.slice(first))
      for (const content of exchange.response.content ?? [])
        if (["audio", "image"].includes(content.type) && typeof content.data === "string") {
          const bytes = Buffer.from(content.data, "base64");
          content.deliveredBytes = bytes.length;
          content.deliveredSha256 = hash(bytes);
          content.omission = "Binary content omitted; complete delivery identity retained";
          delete content.data;
        }
  }
};
const samples = (r) => ({
  start: Math.floor((r.startUs * rate) / 1000000),
  end: Math.floor((r.endUs * rate) / 1000000),
});
async function ff(args, binary = false) {
  return (
    await run("ffmpeg", ["-v", "error", "-nostdin", ...args], {
      encoding: binary ? "buffer" : "utf8",
      timeout: 60000,
      maxBuffer: 128 * 1024 ** 2,
    })
  ).stdout;
}
async function fixture() {
  const pcm = Buffer.alloc(4 * rate * 8);
  for (let i = 0; i < 4 * rate; i++) {
    const t = i / rate;
    let envelope = 0;
    for (const us of sourceEvents) {
      const phase = (t - us / 1000000) / 0.012;
      if (Math.abs(phase) <= 1) envelope += (0.55 * (1 + Math.cos(Math.PI * phase))) / 2;
    }
    for (let c = 0; c < 2; c++)
      pcm.writeFloatLE(
        0.018 * Math.sin(2 * Math.PI * (c ? 659 : 431) * t) +
          envelope * Math.sin(2 * Math.PI * (c ? 1703 : 1301) * t),
        i * 8 + c * 4,
      );
  }
  const header = Buffer.alloc(44);
  header.write("RIFF");
  header.writeUInt32LE(pcm.length + 36, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(3, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 8, 28);
  header.writeUInt16LE(8, 32);
  header.writeUInt16LE(32, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  const wave = join(out, "source.wav");
  await writeFile(wave, Buffer.concat([header, pcm]));
  for (const alternate of [false, true]) {
    const name = alternate ? "replacement" : "source";
    const raw = join(home, name + ".rgb");
    await writeFile(
      raw,
      Buffer.concat(Array.from({ length: 4 * fps }, (_, i) => sourceFrame(i, alternate))),
    );
    await ff([
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-s",
      `${width}x${height}`,
      "-r",
      String(fps),
      "-i",
      raw,
      "-i",
      wave,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "12",
      "-bf",
      "0",
      "-pix_fmt",
      "yuv420p",
      "-threads",
      "1",
      "-c:a",
      "pcm_f32le",
      join(out, name + ".mov"),
    ]);
  }
  const markers = [];
  for (const [name, color] of [
    ["CONTENT", [25, 150, 85]],
    ["CLIP", [175, 75, 170]],
    ["PROJECT", [55, 105, 195]],
  ]) {
    const { rgb, rect, text } = raster(180, 40);
    rect(0, 0, 180, 40, color);
    text(name, 10, 9, 3, [255, 255, 255]);
    const raw = join(home, name + ".rgb"),
      path = join(out, name + ".png");
    await writeFile(raw, rgb);
    await ff([
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-s",
      "180x40",
      "-i",
      raw,
      "-frames:v",
      "1",
      path,
    ]);
    markers.push(path);
  }
  report.inputs = await Promise.all(
    [wave, join(out, "source.mov"), join(out, "replacement.mov"), ...markers].map(async (path) => ({
      path,
      sha256: hash(await readFile(path)),
    })),
  );
  return { pcm, markers };
}
async function admit(path) {
  const pending = await call("asset.import", { path, requestId: randomUUID() });
  const ready = await poll(
    () => call("job.get", { jobId: pending.jobId }),
    (v) => v.state === "ready",
    "import",
  );
  return call("asset.get", { assetId: ready.published.output.assetId });
}
async function audio(selection, name, range) {
  const params = { ...selection, ...(range ? { range } : {}) };
  const ready = await poll(
    () => call("audio.get", params, { transport: "mcp" }),
    (v) => v.state === "ready",
    name,
  );
  const path = join(out, name + ".wav");
  const delivered = await call("audio.get", params, { output: path });
  const receipt = delivered.published.output,
    bytes = await readFile(path),
    h = waveHeader(bytes, bytes.length),
    pcm = bytes.subarray(h.offset, h.offset + h.bytes);
  if (range && selection.projectId) assert.deepEqual(receipt.sampleRange, samples(range));
  assert.equal(pcm.length, receipt.frames * 8);
  assert.equal(ready.published.generation, delivered.published.generation);
  report.receipts[name] = { ...receipt, pcmSha256: hash(pcm), file: path };
  await save();
  return { pcm, path, receipt, ready };
}
function readCounter(rgb) {
  let counter = 0;
  for (let bit = 0; bit < 8; bit++)
    if (rgb[(324 * width + 46 + bit * 48) * 3] > 125) counter |= 1 << bit;
  return counter;
}
async function frame(selection, name, atUs, expected, markerPresence = []) {
  const params = { ...selection, atUs, maxLongEdge: width };
  await poll(
    () => call("frame.get", params),
    (v) => v.state === "ready",
    name,
  );
  const path = join(out, name + ".png"),
    result = await call("frame.get", params, { output: path });
  const rgb = await ff(["-i", path, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], true);
  assert.equal(rgb.length, width * height * 3);
  const counter = readCounter(rgb);
  if (counter !== expected)
    report.failures.push({
      name,
      expectedCounter: expected,
      measuredCounter: counter,
      receipt: result.published.output,
    });
  const marks = [20, 220, 420].map((x) =>
    Array.from(rgb.subarray((250 * width + x + 5) * 3, (250 * width + x + 5) * 3 + 3)),
  );
  for (const [index, present] of markerPresence.entries()) {
    const colors = [
        [25, 150, 85],
        [175, 75, 170],
        [55, 105, 195],
      ],
      distance = marks[index].reduce((sum, v, c) => sum + Math.abs(v - colors[index][c]), 0);
    assert.equal(
      distance < 35,
      present,
      `${name}: ${["content", "clip", "project"][index]} marker`,
    );
  }
  const row = {
    name,
    atUs,
    expectedCounter: expected,
    measuredCounter: counter,
    path,
    rgbSha256: hash(rgb),
    sourceMarker: Array.from(rgb.subarray((324 * width + 575) * 3, (324 * width + 575) * 3 + 3)),
    receipt: result.published.output,
    markerPixels: marks,
  };
  report.frames.push(row);
  await save();
  return row;
}
function events(pcm, centersUs, speeds) {
  const rows = [];
  for (const [index, expectedUs] of centersUs.entries()) {
    const bins = [];
    for (
      let frame = Math.max(0, Math.round(((expectedUs - 200000) * rate) / 1000000));
      frame + 48 <= Math.min(pcm.length / 8, ((expectedUs + 200000) * rate) / 1000000);
      frame += 48
    ) {
      let energy = 0;
      for (let i = 0; i < 48; i++)
        for (let c = 0; c < 2; c++) energy += pcm.readFloatLE((frame + i) * 8 + c * 4) ** 2;
      bins.push({ at: frame + 24, energy: energy / 96 });
    }
    const active = bins.filter((v) => Math.sqrt(v.energy) > report.synchronization.rmsThreshold);
    assert(active.length >= 3, `Missing audio event ${index}`);
    assert(
      active.every((v, i) => !i || v.at - active[i - 1].at <= 48 * 3),
      `Ambiguous audio event ${index}`,
    );
    const center =
      (active.reduce((n, v) => n + v.at * v.energy, 0) /
        active.reduce((n, v) => n + v.energy, 0) /
        rate) *
      1000000;
    const tolerance = 12000 / speeds[index] + 1000000 / rate;
    assert(
      Math.abs(center - expectedUs) <= tolerance,
      `Audio event ${index} mapping error ${center - expectedUs}us exceeds ${tolerance}us`,
    );
    rows.push({
      expectedUs,
      measuredUs: center,
      mappingErrorUs: center - expectedUs,
      activeStartUs: ((active[0].at - 24) / rate) * 1000000,
      activeEndUs: ((active.at(-1).at + 24) / rate) * 1000000,
      toleranceUs: tolerance,
    });
  }
  return rows;
}
async function preview(selection, name, range) {
  const path = join(out, name + ".mp4");
  const result = await poll(
    () => call("preview.get", { ...selection, range }, { output: path }),
    (v) => v.state === "ready",
    name,
  );
  report.receipts[name] = result.published.output;
  await save();
  return path;
}
async function videoPixels(path) {
  return ff(["-i", path, "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], true);
}
async function videoDigest(path) {
  const rgb = await videoPixels(path);
  assert.equal(rgb.length, 135 * width * height * 3);
  return { frames: 135, rgbSha256: hash(rgb) };
}
async function measureVideo(path, centers, speeds, losslessEvents, durationUs) {
  const metadata = JSON.parse(
    (await run("ffprobe", ["-v", "error", "-show_streams", "-of", "json", path])).stdout,
  );
  const track = metadata.streams.find((s) => s.codec_type === "audio");
  assert.equal(track.sample_rate, "48000");
  assert.equal(track.channels, 2);
  assert.equal(track.duration_ts, Math.floor((durationUs * rate) / 1000000));
  const rgb = await ff(
    ["-i", path, "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    true,
  );
  const stride = width * height * 3,
    count = rgb.length / stride;
  assert(Number.isInteger(count));
  assert.equal(count, Math.ceil((durationUs * fps) / 1000000));
  const observed = [],
    counters = [];
  for (let i = 0; i < count; i++) {
    const frame = rgb.subarray(i * stride, (i + 1) * stride),
      at = (160 * width + 570) * 3;
    counters.push(readCounter(frame));
    if (frame[at] > 180 && frame[at + 1] > 180)
      observed.push({ frame: i, atUs: (i * 1000000) / fps, counter: readCounter(frame) });
  }
  const encodedAudio = await ff(["-i", path, "-map", "0:a:0", "-f", "f32le", "-"], true);
  const audioEvents = events(encodedAudio, centers, speeds);
  const result = centers.map((expectedUs, i) => {
    const hits = observed.filter((v) => Math.abs(v.atUs - expectedUs) < 200000);
    assert(hits.length, `Missing encoded landmark ${i}`);
    assert(
      hits.every((v) => v.counter === (sourceEvents[i] * fps) / 1000000),
      `Wrong source counter at event ${i}`,
    );
    const offset = hits[0].atUs - audioEvents[i].measuredUs,
      tolerance = 1000000 / fps + 12000 / speeds[i] + 1000000 / rate;
    assert(Math.abs(offset) <= tolerance, `AV event ${i}: ${offset}us exceeds ${tolerance}us`);
    return {
      expectedUs,
      displayedFrames: hits,
      encodedAudio: audioEvents[i],
      encodedMinusLosslessAudioUs: audioEvents[i].measuredUs - losslessEvents[i].measuredUs,
      videoMinusAudioUs: offset,
      toleranceUs: tolerance,
    };
  });
  const expectedCounters = Array.from({ length: count }, (_, i) =>
    i < 30 ? i : i < 105 ? 30 + Math.floor(((i - 30) * 4) / 5) : i - 15,
  );
  if (!counters.every((v, i) => v === expectedCounters[i]))
    report.failures.push({ name: "linked-encoded-counters", counters, expectedCounters });
  return { audioTrack: track, frames: count, counters, expectedCounters, events: result };
}
async function prepare(selected) {
  const result = await poll(
    () => call("audio.prepare", selected),
    (v) => v.state === "ready",
    "retained preparation",
  );
  assert.deepEqual(await call("audio.prepare", selected, { transport: "mcp" }), result);
  assert.deepEqual(await call("audio.prepare", selected), result);
  return result;
}
async function eventRows(params) {
  let page = await poll(
    () => call("timeline.events", { ...params, limit: 500 }),
    (v) => v.state === "ready",
    "timeline evidence",
  );
  const rows = [...page.page.rows],
    coverage = page.page.coverage;
  for (let n = 0; page.page.nextCursor; n++) {
    assert(n < 20, "Evidence pagination must make bounded progress");
    page = await call(
      "timeline.events",
      { ...params, limit: 500, cursor: page.page.nextCursor },
      { transport: "mcp" },
    );
    assert.equal(page.state, "ready");
    rows.push(...page.page.rows);
  }
  return { rows, coverage };
}
async function tinyAdmission(source) {
  const made = await call("project.create", {
    requestId: "tiny",
    canvas: { width, height, fps: { numerator: fps, denominator: 1 }, background: "#000000ff" },
  });
  const id = made.project.projectId;
  const edited = await call("edit.apply", {
    projectId: id,
    expectedRevisionId: made.revision.revisionId,
    requestId: "tiny-run",
    operations: [
      { operation: "track.add", label: "a", track: { kind: "audio", order: 0 } },
      {
        operation: "place",
        clip: {
          assetId: source.id,
          streamId: source.streams.find((v) => v.kind === "audio").streamId,
          trackId: { label: "a" },
          source: { kind: "range", range: { startUs: 0, endUs: 2000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 2500 } },
          pitch: "preserve",
        },
      },
    ],
  });
  const selected = { projectId: id, revisionId: edited.revision.revisionId };
  const db = new DatabaseSync(join(home, "library/catalog.sqlite"), { readOnly: true });
  try {
    const count = () =>
      db
        .prepare("SELECT count(*) AS count FROM jobs WHERE targetKind='project' AND targetId=?")
        .get(id).count;
    assert.equal(count(), 0);
    const refusals = [];
    for (const [operation, extra] of [
      ["audio.prepare", {}],
      ["audio.get", { range: { startUs: 0, endUs: 2500 } }],
      ["preview.get", { range: { startUs: 0, endUs: 2500 } }],
      [
        "export.create",
        { requestId: randomUUID(), kind: "video", directory: out, leaf: "must-not-render.mp4" },
      ],
    ]) {
      const error = await call(operation, { ...selected, ...extra }, { error: true });
      assert.equal(error.code, "NOT_READY", JSON.stringify(error));
      assert.equal(count(), 0, `${operation} admitted unsupported preparation`);
      refusals.push({ operation, error });
    }
    await assert.rejects(readFile(join(out, "must-not-render.mp4")), { code: "ENOENT" });
    report.checks.tinyActualNativeAdmission = {
      refusals,
      admittedJobs: count(),
      observation: "Read-only isolated catalog; all mutations used public transports",
    };
  } finally {
    db.close();
  }
}
let projectId, revisionId;
const selection = () => ({ projectId, revisionId });
async function edit(operations, name) {
  const result = await call(
    "edit.apply",
    { projectId, expectedRevisionId: revisionId, requestId: name, operations },
    { transport: "mcp" },
  );
  revisionId = result.revision.revisionId;
  return result;
}
try {
  const input = await fixture();
  await service.start();
  const source = await admit(join(out, "source.mov")),
    replacement = await admit(join(out, "replacement.mov"));
  const markerAssets = await Promise.all(input.markers.map(admit));
  const media = (asset, kind, range) => ({
    assetId: asset.id,
    streamId: asset.streams.find((s) => s.kind === kind).streamId,
    source: { kind: "range", range },
  });
  const created = await call("project.create", {
    requestId: "retiming",
    canvas: { width, height, fps: { numerator: fps, denominator: 1 }, background: "#000000ff" },
  });
  projectId = created.project.projectId;
  revisionId = created.revision.revisionId;
  const placed = await edit(
    [
      { operation: "track.add", label: "v", track: { kind: "video", order: 0 } },
      { operation: "track.add", label: "a", track: { kind: "audio", order: 0 } },
      ...[0, 1, 2].map((i) => ({
        operation: "track.add",
        label: `markers${i}`,
        track: { kind: "video", order: i + 1 },
      })),
      ...["video", "audio"].map((kind) => ({
        operation: "place",
        label: kind,
        clip: {
          trackId: { label: kind === "video" ? "v" : "a" },
          ...media(source, kind, full),
          placement: { kind: "project", range: full },
        },
      })),
      { operation: "link", clipIds: [{ label: "video" }, { label: "audio" }] },
    ],
    "place",
  );
  const base = selection();
  const raw = await audio(
    { assetId: source.id, streamId: source.streams.find((s) => s.kind === "audio").streamId },
    "source-raw",
    full,
  );
  assert.deepEqual(raw.pcm, input.pcm);
  report.rawEvents = events(raw.pcm, sourceEvents, [1, 1, 1, 1]);
  const before = await audio(base, "baseline-full", full);
  assert.deepEqual(before.pcm, input.pcm);
  const first = await edit(
    [
      {
        operation: "split",
        clipIds: [placed.edit.labels.video],
        atUs: 1000000,
        rightLabels: [
          { clipId: placed.edit.labels.video, label: "middleV" },
          { clipId: placed.edit.labels.audio, label: "middleA" },
        ],
      },
    ],
    "split-at-one",
  );
  await edit(
    [
      {
        operation: "split",
        clipIds: [first.edit.labels.middleV],
        atUs: 3000000,
        rightLabels: [
          { clipId: first.edit.labels.middleV, label: "tailV" },
          { clipId: first.edit.labels.middleA, label: "tailA" },
        ],
      },
    ],
    "split-at-three",
  );
  const middleV = first.edit.labels.middleV,
    middleA = first.edit.labels.middleA;
  await edit(
    markerAssets.flatMap((asset, i) => [
      {
        operation: "place",
        label: `marker${i}`,
        clip: {
          trackId: placed.edit.labels[`markers${i}`],
          assetId: asset.id,
          streamId: asset.streams[0].streamId,
          source: { kind: "hold", atUs: 0 },
          placement:
            i === 0
              ? {
                  kind: "content",
                  clipId: middleV,
                  sourceRange: { startUs: 1400000, endUs: 1700000 },
                }
              : i === 1
                ? {
                    kind: "clip",
                    clipId: middleV,
                    start: { numerator: 1, denominator: 5 },
                    end: { numerator: 7, denominator: 20 },
                  }
                : { kind: "project", range: { startUs: 1400000, endUs: 1700000 } },
        },
      },
      {
        operation: "processing.set",
        target: { kind: "clip", id: { label: `marker${i}` } },
        steps: [
          {
            processor: {
              type: "geometry",
              crop: { x: 0, y: 0, width: 180, height: 40 },
              rect: { x: 20 + i * 200, y: 230, width: 180, height: 40 },
              fit: "stretch",
            },
          },
        ],
      },
    ]),
    "attach-markers",
  );
  await edit(
    [
      {
        operation: "retime",
        clipIds: [middleV],
        durationUs: 2500000,
        scope: "linked",
        pitch: "preserve",
        ripple: {
          trackIds: [
            placed.edit.labels.v,
            placed.edit.labels.a,
            placed.edit.labels.markers0,
            placed.edit.labels.markers1,
            placed.edit.labels.markers2,
          ],
        },
      },
    ],
    "linked-slow",
  );
  const linkedSelection = selection(),
    linkedRange = { startUs: 0, endUs: 4500000 };
  const linkedAudio = await audio(linkedSelection, "linked-full", linkedRange);
  assert.deepEqual(linkedAudio.pcm.subarray(0, 48000 * 8), before.pcm.subarray(0, 48000 * 8));
  assert.deepEqual(linkedAudio.pcm.subarray(168000 * 8), before.pcm.subarray(144000 * 8));
  const linkedEvents = events(
    linkedAudio.pcm,
    [500000, 1625000, 2875000, 4000000],
    [1, 0.8, 0.8, 1],
  );
  report.linkedEvents = linkedEvents;
  for (const [name, at, counter, markers] of [
    ["before", 999999, 29, [false, false, false]],
    ["start", 1000000, 30, [false, false, false]],
    ["project-only", 1450000, 40, [false, false, true]],
    ["all-markers", 1600000, 44, [true, true, true]],
    ["attached-only", 1750000, 47, [true, true, false]],
    ["end", 3500000, 90, [false, false, false]],
    ["event-one", 1633334, 45, [true, true, true]],
    ["event-two", 2900000, 75, [false, false, false]],
    ["tail-event", 4000000, 105, [false, false, false]],
  ]) {
    await frame(linkedSelection, "linked-" + name, at, counter, markers);
  }
  const movie = await preview(linkedSelection, "linked-preview", linkedRange);
  report.linkedVideo = await measureVideo(
    movie,
    [500000, 1625000, 2875000, 4000000],
    [1, 0.8, 0.8, 1],
    linkedEvents,
    linkedRange.endUs,
  );
  const linkedVideoDigest = await videoDigest(movie);
  const shortMovie = await preview(linkedSelection, "fractional-short-preview", {
    startUs: 1600011,
    endUs: 1680037,
  });
  const shortRgb = await videoPixels(shortMovie),
    shortStride = width * height * 3;
  assert.equal(shortRgb.length, 3 * shortStride);
  const shortCounters = [];
  for (let i = 0; i < 3; i++) {
    const pixels = shortRgb.subarray(i * shortStride, (i + 1) * shortStride);
    shortCounters.push(readCounter(pixels));
    for (const [j, x] of [20, 220, 420].entries()) {
      const colors = [
        [25, 150, 85],
        [175, 75, 170],
        [55, 105, 195],
      ][j];
      const at = (250 * width + x + 5) * 3;
      assert(colors.reduce((sum, v, c) => sum + Math.abs(pixels[at + c] - v), 0) < 35);
    }
  }
  assert.deepEqual(shortCounters, report.linkedVideo.counters.slice(48, 51));
  report.fractionalShortPreview = {
    range: { startUs: 1600011, endUs: 1680037 },
    projectFrames: [48, 49, 50],
    counters: shortCounters,
    allAttachmentMarkersPresent: true,
  };
  const retainedLinked = await prepare(linkedSelection);
  const linkedEvidence = await eventRows(linkedSelection);
  const sourceEvidence = await eventRows({
    assetId: source.id,
    streamId: source.streams.find((v) => v.kind === "video").streamId,
  });
  assert(
    sourceEvidence.rows.some((r) => r.kind === "scene"),
    "Authored background transitions need measured source evidence",
  );
  report.sourceEvidence = sourceEvidence;
  report.linkedEvidence = linkedEvidence;
  const mainCuts = (evidence) =>
    evidence.rows
      .filter((r) => r.kind === "cut" && r.trackId === placed.edit.labels.v)
      .map((r) => r.projectAtUs);
  assert.deepEqual(mainCuts(linkedEvidence), [1000000, 3500000]);
  for (const row of linkedEvidence.rows.filter(
    (r) => r.kind === "scene" && r.trackId === placed.edit.labels.v,
  )) {
    const t = row.sourceAtUs,
      mapped = t < 1000000 ? t : t < 3000000 ? 1000000 + ((t - 1000000) * 5) / 4 : t + 500000;
    assert.equal(row.projectAtUs, mapped);
  }
  const leftRange = { startUs: 0, endUs: 2000000 },
    rightRange = { startUs: 2000000, endUs: 4500000 };
  const left = await audio(linkedSelection, "linked-left", leftRange),
    right = await audio(linkedSelection, "linked-right", rightRange);
  assert.deepEqual(Buffer.concat([left.pcm, right.pcm]), linkedAudio.pcm);
  const shortRange = { startUs: 1600011, endUs: 1680037 },
    short = await audio(linkedSelection, "linked-short", shortRange),
    shortSamples = samples(shortRange);
  assert.deepEqual(
    short.pcm,
    linkedAudio.pcm.subarray(shortSamples.start * 8, shortSamples.end * 8),
  );
  const split = await edit(
    [
      {
        operation: "split",
        clipIds: [middleV],
        atUs: 2250000,
        rightLabels: [
          { clipId: middleV, label: "rightV" },
          { clipId: middleA, label: "rightA" },
        ],
      },
    ],
    "pure-linked-split",
  );
  const splitSelection = selection(),
    splitAudio = await audio(splitSelection, "pure-split-full", linkedRange);
  assert.deepEqual(splitAudio.pcm, linkedAudio.pcm);
  assert.deepEqual(mainCuts(await eventRows(splitSelection)), mainCuts(linkedEvidence));
  const copied = await edit(
    [
      {
        operation: "duplicate",
        clipIds: [middleV, split.edit.labels.rightV],
        scope: "linked",
        atUs: 5000000,
        copyLabels: [
          { clipId: middleV, label: "copyLeftV" },
          { clipId: middleA, label: "copyLeftA" },
          { clipId: split.edit.labels.rightV, label: "copyRightV" },
          { clipId: split.edit.labels.rightA, label: "copyRightA" },
        ],
      },
    ],
    "repeat-middle",
  );
  const repeatSelection = selection(),
    repeatedRange = { startUs: 0, endUs: 7500000 },
    repeated = await audio(repeatSelection, "repeated-full", repeatedRange);
  assert.deepEqual(
    repeated.pcm.subarray(((5000000 * rate) / 1000000) * 8),
    linkedAudio.pcm.subarray(48000 * 8, 168000 * 8),
  );
  assert(repeated.pcm.subarray(216000 * 8, 240000 * 8).every((v) => v === 0));
  report.repeatEvents = events(
    repeated.pcm,
    [500000, 1625000, 2875000, 4000000, 5625000, 6875000],
    [1, 0.8, 0.8, 1, 0.8, 0.8],
  );
  const repeatEvidence = await eventRows(repeatSelection);
  report.repeatEvidence = repeatEvidence;
  assert(
    repeatEvidence.rows.some((r) => r.kind === "scene" && r.projectAtUs >= 5000000),
    "Repeated source scenes must retain another occurrence",
  );
  const retainedRepeat = await prepare(repeatSelection);
  await edit(
    [
      {
        operation: "retime",
        clipIds: [copied.edit.labels.copyLeftV],
        durationUs: 800000,
        scope: "linked",
        pitch: "preserve",
        ripple: {
          trackIds: [
            placed.edit.labels.v,
            placed.edit.labels.a,
            placed.edit.labels.markers0,
            placed.edit.labels.markers1,
            placed.edit.labels.markers2,
          ],
        },
      },
    ],
    "piecewise-rate-change",
  );
  const changedSelection = selection(),
    changedRange = { startUs: 0, endUs: 7050000 },
    changed = await audio(changedSelection, "rate-changed-full", changedRange);
  assert.deepEqual(changed.pcm.subarray(0, 216000 * 8), linkedAudio.pcm);
  report.rateChangedEvents = events(
    changed.pcm,
    [500000, 1625000, 2875000, 4000000, 5400000, 6425000],
    [1, 0.8, 0.8, 1, 1.25, 0.8],
  );
  const retainedChanged = await prepare(changedSelection);
  assert.notEqual(retainedChanged.jobId, retainedRepeat.jobId);
  assert.notEqual(
    retainedChanged.published.output.assetId,
    retainedRepeat.published.output.assetId,
  );
  const restored = await call("edit.restore", {
    projectId,
    expectedRevisionId: revisionId,
    targetRevisionId: linkedSelection.revisionId,
    requestId: "restore-linked",
  });
  revisionId = restored.id;
  await edit(
    [
      { operation: "unlink", clipIds: [middleA] },
      {
        operation: "retime",
        clipIds: [middleA],
        durationUs: 2000000,
        scope: "selected",
        pitch: "preserve",
        ripple: "none",
      },
    ],
    "audio-only-after-unlink",
  );
  const independentSelection = selection(),
    independent = await audio(independentSelection, "independent-audio", linkedRange);
  assert.deepEqual(independent.pcm.subarray(0, 144000 * 8), input.pcm.subarray(0, 144000 * 8));
  assert(independent.pcm.subarray(144000 * 8, 168000 * 8).every((v) => v === 0));
  assert.deepEqual(independent.pcm.subarray(168000 * 8), input.pcm.subarray(144000 * 8));
  report.independentEvents = events(
    independent.pcm,
    [500000, 1500000, 2500000, 4000000],
    [1, 1, 1, 1],
  );
  const independentFrame = await frame(
    independentSelection,
    "independent-video-unchanged",
    1600000,
    44,
    [true, true, true],
  );
  assert.equal(
    independentFrame.rgbSha256,
    report.frames.find((f) => f.name === "linked-all-markers").rgbSha256,
  );
  const independentVideoDigest = await videoDigest(
    await preview(independentSelection, "independent-video-preview", linkedRange),
  );
  assert.deepEqual(independentVideoDigest, linkedVideoDigest);
  report.independentVideo = { before: linkedVideoDigest, after: independentVideoDigest };
  await edit(
    [
      {
        operation: "replace",
        clipId: middleV,
        kind: "video",
        media: media(replacement, "video", { startUs: 0, endUs: 2000000 }),
        fit: "stretch",
      },
    ],
    "independent-picture-replacement",
  );
  const replacedSelection = selection(),
    replacedAudio = await audio(replacedSelection, "replaced-picture-audio", linkedRange);
  assert.deepEqual(replacedAudio.pcm, independent.pcm);
  const replacementFrame = await frame(replacedSelection, "replacement-picture", 1600000, 14);
  assert(
    replacementFrame.sourceMarker[2] > 180 && replacementFrame.sourceMarker[0] < 100,
    "Replacement source B pixel marker missing",
  );
  assert.notEqual(replacementFrame.rgbSha256, independentFrame.rgbSha256);
  const replacementVideoDigest = await videoDigest(
    await preview(replacedSelection, "replacement-video-preview", linkedRange),
  );
  await edit(
    [
      {
        operation: "retime",
        clipIds: [middleA],
        durationUs: 2500000,
        scope: "selected",
        pitch: "follow",
        ripple: "none",
      },
    ],
    "independent-follow-slowdown",
  );
  const followSelection = selection(),
    followed = await audio(followSelection, "independent-follow-audio", linkedRange);
  const followFrame = await frame(followSelection, "follow-video-unchanged", 1600000, 14);
  assert.equal(followFrame.rgbSha256, replacementFrame.rgbSha256);
  const followVideoDigest = await videoDigest(
    await preview(followSelection, "follow-video-preview", linkedRange),
  );
  assert.deepEqual(followVideoDigest, replacementVideoDigest);
  const pitch = [];
  for (let channel = 0; channel < 2; channel++) {
    const first = 52800,
      end = 67200,
      lane = Buffer.alloc((end - first) * 4);
    for (let i = first; i < end; i++)
      lane.writeFloatLE(followed.pcm.readFloatLE(i * 8 + channel * 4), (i - first) * 4);
    const expected = [431, 659][channel] * 0.8,
      measured = tonePitch(lane, expected, 10);
    assert.equal(measured.status, "measured");
    assert(
      Math.abs(measured.hz - expected) < 0.1,
      "Explicit follow did not change the tone frequency",
    );
    pitch.push({
      channel,
      projectSamples: { start: first, end },
      ...measured,
      absoluteToleranceHz: 0.1,
    });
  }
  report.independentFollow = {
    events: events(followed.pcm, [500000, 1625000, 2875000, 4000000], [1, 0.8, 0.8, 1]),
    pitch,
    videoPixelsUnchanged: true,
    videoBefore: replacementVideoDigest,
    videoAfter: followVideoDigest,
  };
  const retimedRestore = await call("edit.restore", {
    projectId,
    expectedRevisionId: revisionId,
    targetRevisionId: linkedSelection.revisionId,
    requestId: "restore-retimed-before-gain",
  });
  revisionId = retimedRestore.id;
  const beforeGain = await prepare(selection());
  assert.deepEqual(
    (await audio(selection(), "retimed-before-gain", linkedRange)).pcm,
    linkedAudio.pcm,
  );
  await edit(
    [
      {
        operation: "processing.set",
        target: { kind: "output" },
        steps: [{ processor: { type: "gain", gain: 0.5 } }],
      },
    ],
    "post-retime-gain",
  );
  const gainSelection = selection();
  const barrier = await service.arm("media.mixCompositionAudio"),
    pending = await call("audio.prepare", gainSelection);
  await barrier();
  await call("job.cancel", { jobId: pending.jobId });
  const canceled = await poll(
    () => call("job.get", { jobId: pending.jobId }),
    (v) => v.state === "canceled",
    "canceled retained output",
  );
  assert.equal(canceled.published, null);
  await call("job.retry", { jobId: pending.jobId });
  const gainedPrepared = await prepare(gainSelection);
  assert.equal(gainedPrepared.jobId, pending.jobId);
  assert.notEqual(gainedPrepared.published.output.assetId, beforeGain.published.output.assetId);
  const gained = await audio(gainSelection, "gain-after-retime", linkedRange),
    expectedGain = Buffer.from(linkedAudio.pcm);
  for (let i = 0; i < expectedGain.length; i += 4)
    expectedGain.writeFloatLE(Math.fround(expectedGain.readFloatLE(i) * 0.5), i);
  assert.deepEqual(gained.pcm, expectedGain);
  report.preparation = {
    linked: retainedLinked,
    repeated: retainedRepeat,
    changed: retainedChanged,
    gained: gainedPrepared,
    cancellation: canceled,
  };
  report.cancellationScope =
    "Real native work completes behind the existing reply barrier; public cancellation prevents publication and explicit retry succeeds. Native in-preparation cancellation belongs to retained native evidence.";
  assert.deepEqual(await prepare(linkedSelection), retainedLinked);
  const sourceAgain = await audio(
    { assetId: source.id, streamId: source.streams.find((v) => v.kind === "audio").streamId },
    "source-raw-after",
    full,
  );
  assert.deepEqual(sourceAgain.pcm, input.pcm);
  assert.deepEqual(
    await eventRows({
      assetId: source.id,
      streamId: source.streams.find((v) => v.kind === "video").streamId,
    }),
    sourceEvidence,
  );
  const waveform = await poll(
    () =>
      call("waveform.get", {
        assetId: source.id,
        streamId: source.streams.find((v) => v.kind === "audio").streamId,
        range: full,
        bucketFrames: 480,
      }),
    (v) => v.state === "ready",
    "raw source waveform",
  );
  report.rawWaveform = waveform;
  for (const [name, atUs, counter] of [
    ["event-one", 1500000, 45],
    ["event-two", 2500000, 75],
    ["tail-event", 3500000, 105],
    ["before", 983333, 29],
    ["start", 1016666, 30],
    ["end", 3016666, 90],
  ])
    await frame(
      { assetId: source.id, streamId: source.streams.find((v) => v.kind === "video").streamId },
      "source-reference-" + name,
      atUs,
      counter,
    );
  await tinyAdmission(source);
  const exportId = randomUUID();
  await call(
    "export.create",
    { ...linkedSelection, exportId, kind: "video", directory: out, leaf: "linked-export.mp4" },
    { transport: "mcp" },
  );
  const exported = await poll(
    () => call("export.status", { exportId }),
    (v) => v.state === "ready",
    "linked export",
  );
  // A later export may use a prepared operand and a new container creation time.
  // Compare complete decoded media rather than pinning incidental MP4 metadata.
  report.export = {
    previewFileSha256: hash(await readFile(movie)),
    exportFileSha256: hash(await readFile(exported.output)),
    streams: [],
  };
  for (const [kind, args] of [
    ["video", ["-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]],
    ["audio", ["-map", "0:a:0", "-f", "f32le", "-"]],
  ]) {
    const previewBytes = await ff(["-i", movie, ...args], true),
      exportBytes = await ff(["-i", exported.output, ...args], true);
    assert(previewBytes.equals(exportBytes), `Export changed decoded ${kind}`);
    report.export.streams.push({
      kind,
      bytes: previewBytes.length,
      sha256: hash(previewBytes),
      completeByteEquality: true,
    });
  }
  const packageId = randomUUID();
  await call("export.create", {
    projectId,
    requestId: packageId,
    kind: "processed-package",
    directory: out,
    leaf: "retimed-package.zip",
  });
  const packaged = await poll(
    () => call("export.status", { exportId: packageId }),
    (v) => v.state === "ready",
    "retained package",
  );
  for (const asset of report.inputs) assert.equal(hash(await readFile(asset.path)), asset.sha256);
  report.donorSelection = gainSelection;
  await service.stop();
  await writeFile(join(out, "donor-service.log"), service.logs.join(""));
  await rm(home, { recursive: true });
  await mkdir(join(out, "frozen-sources"));
  for (const asset of report.inputs) {
    asset.retainedPath = join(out, "frozen-sources", asset.path.split("/").at(-1));
    await rename(asset.path, asset.retainedPath);
  }
  const previous = process.env.YAP_TEST_UNAVAILABLE_OPERATIONS;
  process.env.YAP_TEST_UNAVAILABLE_OPERATIONS = JSON.stringify([
    "media.audioCapabilities",
    "media.validateCompositionAudio",
  ]);
  service = new JourneyService(receiverHome, report, join(out, "receiver-native"));
  try {
    await service.start();
  } finally {
    if (previous === undefined) delete process.env.YAP_TEST_UNAVAILABLE_OPERATIONS;
    else process.env.YAP_TEST_UNAVAILABLE_OPERATIONS = previous;
  }
  const opened = await call("package.open", { path: packaged.output });
  const ready = await poll(
    () => call("package.status", { admissionId: opened.id }),
    (v) => v.state === "ready",
    "package open",
  );
  const adopted = await poll(
    () => call("package.adopt", { packageHandle: ready.packageHandle, requestId: "retimed-adopt" }),
    (v) => v.state === "ready",
    "package adopt",
  );
  const portable = {
    projectId: adopted.published.output.projectId,
    revisionId: adopted.published.output.revisionId,
  };
  await call("package.close", { admissionId: opened.id });
  const portableAudio = await audio(portable, "portable-retained-audio", linkedRange);
  assert.deepEqual(portableAudio.pcm, gained.pcm);
  const portablePrepared = await prepare(portable);
  assert.equal(portablePrepared.published.output.assetId, gainedPrepared.published.output.assetId);
  await preview(portable, "portable-retained-preview", linkedRange);
  const receiverCalls = [];
  for (const file of await readdir(join(out, "receiver-native"))) {
    if (!file.endsWith(".json")) continue;
    const observed = JSON.parse(await readFile(join(out, "receiver-native", file), "utf8"));
    if (file.startsWith("mix-")) {
      assert(observed.request.retained, "Portable audio attempted ordinary DSP");
      assert.equal(observed.request.retimeImplementationId, undefined);
      assert.equal(observed.request.state, undefined);
      assert.deepEqual(observed.response.data.sourceWork.decoded, []);
      receiverCalls.push({ operation: "media.mixCompositionAudio", retained: true, decoded: [] });
    } else if (observed.operation === "media.renderCompositionMovie") {
      assert(observed.request.audio.retained, "Portable movie attempted ordinary DSP");
      assert.equal(observed.request.audio.retimeImplementationId, undefined);
      assert.equal(observed.request.audio.state, undefined);
      assert.deepEqual(observed.response.data.audio.sourceWork.decoded, []);
      receiverCalls.push({ operation: observed.operation, retained: true, decoded: [] });
    }
  }
  assert(
    receiverCalls.some((r) => r.operation === "media.mixCompositionAudio") &&
      receiverCalls.some((r) => r.operation === "media.renderCompositionMovie"),
  );
  report.portable = {
    adopted,
    prepared: portablePrepared,
    receiverCalls,
    refusedOperations: ["media.audioCapabilities", "media.validateCompositionAudio"],
    donorHomeDeleted: true,
    originalPathsRemoved: true,
  };
  report.checks = {
    ...report.checks,
    linkedPcmCountsAndEventTiming: true,
    exactVideoCounterSequence: report.failures.length === 0,
    fullSplitSubrangePcm: true,
    pureSplitPcmAndCutEvidence: true,
    repeatedOccurrence: true,
    piecewiseRateChange: true,
    explicitUnlinkAndIndependentPlaneReplacement: true,
    postRetimeGain: true,
    explicitIndependentFollow: true,
    preparedReuseInvalidation: true,
    sourceBytesAndEvidenceUnchanged: true,
    publicCancellationRetry: true,
    retainedPackagePlaybackWithoutRetimeProcessing: true,
  };
  assert.deepEqual(report.failures, [], "Frame timing failures remain");
  report.passed = true;
} finally {
  await save();
  await service.stop();
  await writeFile(join(out, "service.log"), service.logs.join(""));
  await rm(home, { recursive: true, force: true });
  await rm(receiverHome, { recursive: true, force: true });
}
