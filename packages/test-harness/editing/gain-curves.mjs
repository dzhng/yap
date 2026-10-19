import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { JourneyService, hash, poll, run } from "./source-evidence-fixture.mjs";
import { writeSourceWave, sample, waveHeader } from "./audio-project-fixture.mjs";
const { values } = parseArgs({ options: { out: { type: "string" }, case: { type: "string" } } });
if (values.case === "retimed") {
  const { runRetimedGain } = await import("./retimed-gain.mjs");
  await runRetimedGain(values.out);
  process.exit(0);
}
assert.equal(values.case, undefined);
assert.ok(values.out && process.env.YAP_NATIVE);
const out = resolve(values.out),
  home = await mkdtemp(join(tmpdir(), "yap-gain-"));
await mkdir(out);
const report = { passed: false, trace: [], checks: [], costs: [] };
const service = new JourneyService(home, report),
  call = service.call.bind(service);
const f = Math.fround,
  ref = (label) => ({ label });
const normalized = (a, b, interpolation = "linear") => ({
  keys: [
    { at: { numerator: 0, denominator: 1 }, value: a, interpolation },
    { at: { numerator: 1, denominator: 1 }, value: b, interpolation: "linear" },
  ],
});
const data = (bytes) => {
  const header = waveHeader(bytes, bytes.length);
  return bytes.subarray(header.offset);
};
let sequence = 0;
async function audio(params, name) {
  const started = performance.now();
  const ready = await poll(
    () => call("audio.get", params),
    (v) => v.state === "ready",
    name,
  );
  const path = join(out, `${name}.wav`);
  const cli = await call("audio.get", params, { output: path });
  const bytes = await readFile(path),
    pcm = data(bytes);
  const mcp = await service.mcp.callTool({ name: "audio.get", arguments: params });
  assert.equal(mcp.structuredContent.ok, true);
  assert.deepEqual(Buffer.from(mcp.content.find((v) => v.type === "audio").data, "base64"), bytes);
  assert.equal(ready.published.output.frameCount, pcm.length / 8);
  assert.equal(cli.published.output.sampleRate, 48000);
  assert.equal(cli.published.output.channels, 2);
  report.costs.push({
    name,
    frames: pcm.length / 8,
    wallMsIncludingReadinessAndBothTransports: performance.now() - started,
  });
  report.checks.push({ name, frames: pcm.length / 8, sha256: hash(pcm) });
  return pcm;
}
function verify(pcm, start, end, expected, tolerance = 0) {
  assert.equal(pcm.length, (end - start) * 8);
  let maximum = 0;
  for (let frame = start; frame < end; frame++)
    for (let channel = 0; channel < 2; channel++) {
      const actual = pcm.readFloatLE((frame - start) * 8 + channel * 4),
        wanted = expected(frame, channel);
      maximum = Math.max(maximum, Math.abs(actual - wanted));
      assert.ok(
        Math.abs(actual - wanted) <= tolerance,
        `frame${frame}/channel${channel}: ${actual} vs ${wanted}`,
      );
    }
  return maximum;
}
try {
  const source = join(out, "source.wav");
  await writeSourceWave(source, { source: 0, seconds: 1 });
  report.workerSha256 = hash(await readFile(process.env.YAP_NATIVE));
  await service.start();
  const admitted = await call("asset.import", { requestId: "gain-source", path: source });
  await poll(
    () => call("job.get", { jobId: admitted.jobId }),
    (v) => v.state === "ready",
    "source admission",
  );
  const asset = await call("asset.get", { assetId: hash(await readFile(source)) });
  const streamId = asset.streams.find((v) => v.kind === "audio").streamId;
  const created = await call("project.create", {
    requestId: "gain-project",
    title: "Gain curve journey",
    canvas: {
      width: 64,
      height: 48,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  const projectId = created.project.projectId;
  let revisionId = created.revision.revisionId;
  async function edit(operations) {
    const result = await call("edit.apply", {
      projectId,
      expectedRevisionId: revisionId,
      requestId: `gain-edit-${sequence++}`,
      operations,
    });
    revisionId = result.revision.revisionId;
    return result;
  }
  const placed = await edit([
    { operation: "group.add", label: "group", group: { kind: "audio", order: 0 } },
    {
      operation: "track.add",
      label: "track",
      track: { kind: "audio", order: 0, parentId: ref("group") },
    },
    {
      operation: "place",
      label: "clip",
      clip: {
        trackId: ref("track"),
        assetId: asset.assetId,
        streamId,
        source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
        placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
      },
    },
    {
      operation: "processing.set",
      target: { kind: "clip", id: ref("clip") },
      steps: [
        { label: "curve", processor: { type: "gain", gain: normalized(0.25, 1.25) } },
        { label: "post", processor: { type: "gain", gain: 0.7 } },
        { label: "disabled", enabled: false, processor: { type: "gain", gain: normalized(5, 10) } },
      ],
    },
    {
      operation: "processing.set",
      target: { kind: "group", id: ref("group") },
      steps: [{ processor: { type: "gain", gain: 0.8 } }],
    },
    {
      operation: "processing.set",
      target: { kind: "output" },
      steps: [{ processor: { type: "gain", gain: 0.6 } }],
    },
  ]);
  const clipId = placed.edit.labels.clip,
    curveId = placed.edit.labels.curve,
    postId = placed.edit.labels.post;
  const selection = () => ({ projectId, revisionId });
  const tap = (kind, id, point = { kind: "processed" }) => ({
    target: kind === "output" ? { kind } : { kind, id },
    point,
  });
  const sourceSample = (frame, channel) => sample(0, frame, channel) / 32768;
  const after = (frame, channel) => f(sourceSample(frame, channel) * f(0.25 + frame / 48000));
  const processed = (frame, channel) => f(after(frame, channel) * f(0.7));
  const output = (frame, channel) => f(f(processed(frame, channel) * f(0.8)) * f(0.6));
  const dry = await audio({ ...selection(), tap: tap("clip", clipId, { kind: "dry" }) }, "dry");
  verify(dry, 0, 48000, sourceSample);
  const one = await audio(
    { ...selection(), tap: tap("clip", clipId, { kind: "after-step", stepId: curveId }) },
    "after-curve",
  );
  verify(one, 0, 48000, after);
  const clip = await audio({ ...selection(), tap: tap("clip", clipId) }, "clip-processed");
  verify(clip, 0, 48000, processed);
  const full = await audio(selection(), "full");
  verify(full, 0, 48000, output);
  const moviePath = join(out, "gain.mp4");
  await poll(
    () => call("preview.get", selection(), { output: moviePath }),
    (v) => v.state === "ready",
    "gain movie",
  );
  const { exportId } = await call("export.create", {
    ...selection(),
    kind: "video",
    requestId: randomUUID(),
    directory: out,
    leaf: "gain-export.mp4",
  });
  const exported = await poll(
    () => call("export.status", { exportId }),
    (v) => v.state === "ready",
    "gain export",
  );
  assert.deepEqual(await readFile(moviePath), await readFile(exported.output));
  const probe = JSON.parse(
    (
      await run("/opt/homebrew/bin/ffprobe", [
        "-v",
        "error",
        "-show_streams",
        "-of",
        "json",
        moviePath,
      ])
    ).stdout,
  );
  const soundtrack = probe.streams.find((v) => v.codec_type === "audio");
  assert.equal(soundtrack.codec_name, "aac");
  assert.equal(soundtrack.sample_rate, "48000");
  assert.equal(soundtrack.channels, 2);
  report.movie = {
    previewExportByteIdentity: true,
    sampleRate: 48000,
    channels: 2,
    quality: "PCM envelope verified separately; AAC quality not judged from this synthetic fixture",
  };
  const range = { startUs: 333333, endUs: 666667 };
  const ranged = await audio({ ...selection(), range }, "range");
  assert.deepEqual(ranged, full.subarray(15999 * 8, 32000 * 8));
  const projectCurve = (a, b) => ({
    keys: [
      { at: 0, value: a, interpolation: "linear" },
      { at: 1000000, value: b, interpolation: "linear" },
    ],
  });
  await edit([
    {
      operation: "processing.set",
      target: { kind: "track", id: placed.edit.labels.track },
      steps: [{ processor: { type: "gain", gain: projectCurve(0.5, 1.5) } }],
    },
    {
      operation: "processing.set",
      target: { kind: "group", id: placed.edit.labels.group },
      steps: [{ processor: { type: "gain", gain: projectCurve(0.8, 1.3) } }],
    },
    {
      operation: "processing.set",
      target: { kind: "output" },
      steps: [{ processor: { type: "gain", gain: projectCurve(0.6, 0.1) } }],
    },
  ]);
  const ordered = await audio(selection(), "all-scope-curves");
  verify(ordered, 0, 48000, (frame, c) => {
    const t = frame / 48000;
    return f(f(f(processed(frame, c) * f(0.5 + t)) * f(0.8 + 0.5 * t)) * f(0.6 - 0.5 * t));
  });
  await edit([
    {
      operation: "processing.set",
      target: { kind: "track", id: placed.edit.labels.track },
      steps: [],
    },
    {
      operation: "processing.set",
      target: { kind: "group", id: placed.edit.labels.group },
      steps: [{ processor: { type: "gain", gain: 0.8 } }],
    },
    {
      operation: "processing.set",
      target: { kind: "output" },
      steps: [{ processor: { type: "gain", gain: 0.6 } }],
    },
  ]);
  for (const [index, bad] of [
    normalized(0, 1, { cubic: [0.5, -1, 0.5, -1] }),
    normalized(1e38, 1e38 * 2, { cubic: [0.5, 10, 0.5, 10] }),
  ].entries()) {
    const before = await call("processing.get", {
      ...selection(),
      target: { kind: "clip", id: clipId },
    });
    const error = await call(
      "edit.apply",
      {
        projectId,
        expectedRevisionId: revisionId,
        requestId: `invalid-gain-${index}`,
        operations: [
          {
            operation: "processing.set",
            target: { kind: "clip", id: clipId },
            steps: [{ id: curveId, processor: { type: "gain", gain: bad } }],
          },
        ],
      },
      { error: true, transport: index ? "mcp" : "cli" },
    );
    assert.equal(error.code, "INVALID_EDIT");
    assert.deepEqual(
      await call("processing.get", { ...selection(), target: { kind: "clip", id: clipId } }),
      before,
    );
  }
  async function setCurve(gain, extra = {}) {
    return edit([
      {
        operation: "processing.set",
        target: { kind: "clip", id: clipId },
        steps: [
          { id: curveId, processor: { type: "gain", gain }, ...extra },
          { id: postId, processor: { type: "gain", gain: 0.7 } },
        ],
      },
    ]);
  }
  await setCurve(normalized(0.25, 1.25), { enabled: false });
  const bypass = await audio({ ...selection(), tap: tap("clip", clipId) }, "bypass");
  verify(bypass, 0, 48000, (frame, c) => f(sourceSample(frame, c) * f(0.7)));
  await setCurve(
    {
      keys: [
        { at: 0, value: 0.25, interpolation: "linear" },
        { at: 1000000, value: 1.25, interpolation: "linear" },
      ],
    },
    {
      window: {
        kind: "project",
        range: { startUs: { numerator: 1000001, denominator: 3 }, endUs: 666667 },
      },
    },
  );
  const windowed = await audio(
    { ...selection(), tap: tap("clip", clipId, { kind: "after-step", stepId: curveId }) },
    "fractional-window",
  );
  verify(windowed, 0, 48000, (frame, c) =>
    f(sourceSample(frame, c) * f(frame >= 16000 && frame < 32000 ? 0.25 + frame / 48000 : 1)),
  );
  await setCurve(normalized(0.25, 1.25, { cubic: [0, 1, 0, 1] }));
  const cubic = await audio(
    { ...selection(), tap: tap("clip", clipId, { kind: "after-step", stepId: curveId }) },
    "cubic",
  );
  report.cubicMaximumPcmError = verify(
    cubic,
    0,
    48000,
    (frame, c) => f(sourceSample(frame, c) * f(0.25 + 1 - (1 - Math.cbrt(frame / 48000)) ** 3)),
    1e-7,
  );
  await setCurve({
    keys: [
      { at: { numerator: 0, denominator: 1 }, value: 0.25, interpolation: "hold" },
      { at: { numerator: 333333, denominator: 1000000 }, value: 1.25, interpolation: "hold" },
      { at: { numerator: 666667, denominator: 1000000 }, value: 0.5, interpolation: "hold" },
      { at: { numerator: 1, denominator: 1 }, value: 0.75, interpolation: "linear" },
    ],
  });
  const held = await audio(
    { ...selection(), tap: tap("clip", clipId, { kind: "after-step", stepId: curveId }) },
    "hold-key-ownership",
  );
  verify(held, 0, 48000, (frame, c) =>
    f(sourceSample(frame, c) * f(frame < 16000 ? 0.25 : frame < 32001 ? 1.25 : 0.5)),
  );
  await setCurve(normalized(0.25, 1.25));
  await edit([{ operation: "move", clipIds: [clipId], atUs: 333333, ripple: "none" }]);
  const fractionalSelection = { ...selection(), range: { startUs: 333333, endUs: 1333333 } };
  const fractionalDry = await audio(
    { ...fractionalSelection, tap: tap("clip", clipId, { kind: "dry" }) },
    "fractional-move-dry",
  );
  const fractionalMoved = await audio(
    { ...fractionalSelection, tap: tap("clip", clipId) },
    "fractional-move",
  );
  verify(fractionalMoved, 15999, 63999, (frame, c) => {
    const phase = Math.max(0, (frame * 1000000 - 333333 * 48000) / 48000000000);
    return f(f(fractionalDry.readFloatLE((frame - 15999) * 8 + c * 4) * f(0.25 + phase)) * f(0.7));
  });
  await edit([{ operation: "move", clipIds: [clipId], atUs: 2000000, ripple: "none" }]);
  const moved = await audio(
    { ...selection(), range: { startUs: 2000000, endUs: 3000000 } },
    "moved",
  );
  assert.deepEqual(moved, full);
  const split = await edit([{ operation: "split", clipIds: [clipId], atUs: 2375001 }]);
  const splitPcm = await audio(
    { ...selection(), range: { startUs: 2000000, endUs: 3000000 } },
    "split",
  );
  assert.deepEqual(splitPcm, moved);
  const right = split.edit.clipLineage
    .find((v) => v.originalId === clipId)
    .clipIds.find((id) => id !== clipId);
  await edit([
    {
      operation: "trim",
      clipId: right,
      range: { startUs: 2500000, endUs: 2900000 },
      ripple: "none",
    },
  ]);
  const trimmed = await audio(
    { ...selection(), range: { startUs: 2500000, endUs: 2900000 }, tap: tap("clip", right) },
    "trimmed",
  );
  assert.deepEqual(trimmed, clip.subarray(24000 * 8, 43200 * 8));
  report.retimedDeliveryCase = "gain-curves.mjs --case retimed";
  report.passed = true;
} finally {
  await service.stop();
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  await rm(home, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, out }));
