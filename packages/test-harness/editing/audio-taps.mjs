import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { JourneyService, hash, poll, root } from "./source-evidence-fixture.mjs";

const { values } = parseArgs({ options: { out: { type: "string" } } });
assert.ok(process.env.YAP_NATIVE, "Use an explicitly frozen native worker");
const out = values.out
  ? resolve(values.out)
  : await mkdtemp(join(tmpdir(), "audio-taps-evidence-"));
await mkdir(out, { recursive: true });
const home = await mkdtemp(join(tmpdir(), "sr-audio-taps-"));
const report = {
  passed: false,
  trace: [],
  checks: {},
  pending: ["Unavailable video processor: none is authorable in the current registry"],
};
const service = new JourneyService(home, report);
const call = service.call.bind(service);
const sample = (frame, channel) => (((frame * (channel ? 13 : 7)) % 127) - 63) / 4096;
function wave() {
  const bytes = Buffer.alloc(44 + 48000 * 8);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(3, 20);
  bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(48000, 24);
  bytes.writeUInt32LE(384000, 28);
  bytes.writeUInt16LE(8, 32);
  bytes.writeUInt16LE(32, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(48000 * 8, 40);
  for (let frame = 0; frame < 48000; frame++)
    for (let c = 0; c < 2; c++) bytes.writeFloatLE(sample(frame, c), 44 + frame * 8 + c * 4);
  return bytes;
}
function pcm(bytes) {
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
  assert.equal(bytes.toString("ascii", 8, 12), "WAVE");
  assert.equal(bytes.readUInt32LE(4) + 8, bytes.length);
  let format = false;
  for (let at = 12; at + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(at + 4),
      name = bytes.toString("ascii", at, at + 4);
    assert.ok(at + 8 + size <= bytes.length, "Chunk exceeds WAV bounds");
    if (name === "fmt ") {
      assert.ok(size >= 16);
      assert.equal(bytes.readUInt16LE(at + 8), 3, "float PCM encoding");
      assert.equal(bytes.readUInt16LE(at + 10), 2, "stereo layout");
      assert.equal(bytes.readUInt32LE(at + 12), 48000, "absolute sample clock");
      assert.equal(bytes.readUInt32LE(at + 16), 384000);
      assert.equal(bytes.readUInt16LE(at + 20), 8, "block alignment");
      assert.equal(bytes.readUInt16LE(at + 22), 32, "float32 samples");
      format = true;
    }
    if (name === "data") {
      assert.ok(format, "Format precedes samples");
      assert.equal(size % 8, 0);
      return bytes.subarray(at + 8, at + 8 + size);
    }
    at += 8 + size + (size % 2);
  }
  assert.fail("WAV has no data");
}
function verify(bytes, range, gain) {
  const start = Math.floor((range.startUs * 48000) / 1000000),
    end = Math.floor((range.endUs * 48000) / 1000000);
  const expected = Buffer.alloc((end - start) * 8);
  for (let frame = start; frame < end; frame++)
    for (let c = 0; c < 2; c++)
      expected.writeFloatLE(sample(frame, c) * gain, (frame - start) * 8 + c * 4);
  assert.ok(
    pcm(bytes).equals(expected),
    `Exact stereo source phase/gain mismatch ${JSON.stringify({ range, gain })}`,
  );
  return { start, end, pcmSha256: hash(expected), wavSha256: hash(bytes) };
}
let ordinal = 0;
async function delivered(params, transport) {
  const ready = await poll(
    () => call("audio.get", params, { transport: "mcp" }),
    (v) => v.state === "ready",
    "audio ready",
  );
  assert.equal(ready.published.output.sampleRate, 48000);
  assert.equal(ready.published.output.channels, 2);
  const name = `${String(ordinal++).padStart(2, "0")}-${transport}.wav`;
  let bytes, data;
  if (transport === "cli") {
    data = await call("audio.get", params, { output: join(out, name) });
    bytes = await readFile(join(out, name));
  } else {
    const response = await service.mcp.callTool({ name: "audio.get", arguments: params });
    assert.equal(response.structuredContent.ok, true, JSON.stringify(response.structuredContent));
    data = response.structuredContent.data;
    const media = response.content.filter((v) => v.type === "audio");
    assert.equal(media.length, 1);
    assert.equal(media[0].mimeType, "audio/wav");
    bytes = Buffer.from(media[0].data, "base64");
    await writeFile(join(out, name), bytes);
    report.trace.push({
      operation: "audio.get",
      transport: "mcp",
      state: data.state,
      inlineAudio: true,
    });
  }
  assert.equal(data.published.output.revisionId, ready.revisionId);
  assert.equal(data.published.output.frameCount, pcm(bytes).length / 8);
  return { bytes, data, name };
}
async function waveform(params, range, gain, requestedBucketFrames = 479) {
  const input = {
    ...params,
    ...(requestedBucketFrames === null ? {} : { bucketFrames: requestedBucketFrames }),
  };
  const ready = await poll(
    () => call("waveform.get", input, { transport: "mcp" }),
    (value) => value.state === "ready",
    "waveform ready",
  );
  const name = `${String(ordinal++).padStart(2, "0")}-waveform.json`;
  const cli = await call("waveform.get", input, { output: join(out, name) });
  const bytes = await readFile(join(out, name));
  const mcp = await service.mcp.callTool({ name: "waveform.get", arguments: input });
  assert.equal(mcp.structuredContent.ok, true);
  assert.equal(mcp.content.length, 2);
  assert.equal(mcp.content[1].type, "text");
  assert.equal(mcp.content[1].text, bytes.toString("utf8"));
  assert.equal(cli.published.output.sizeBytes, bytes.length);
  assert.equal(cli.published.generation, ready.published.generation);
  const document = JSON.parse(bytes);
  const start = Math.floor((range.startUs * 48000) / 1000000);
  const end = Math.floor((range.endUs * 48000) / 1000000);
  assert.deepEqual(document.sampleRange, { start, end });
  assert.equal(document.channels, 2);
  assert.equal(document.sampleRate, 48000);
  const bucketFrames = document.bucketFrames;
  assert.ok(Number.isSafeInteger(bucketFrames) && bucketFrames > 0);
  if (requestedBucketFrames !== null) assert.equal(bucketFrames, requestedBucketFrames);
  assert.ok(document.buckets.length <= 4096);
  assert.equal(document.domain, "projectId" in params ? "project" : "source");
  if ("projectId" in params) {
    assert.equal(document.projectId, params.projectId);
    assert.equal(document.revisionId, cli.revisionId);
  } else {
    assert.equal(document.assetId, params.assetId);
    assert.equal(document.streamId, params.streamId);
    assert.equal("revisionId" in document, false);
  }
  const expected = [];
  for (
    let gridStart = Math.floor(start / bucketFrames) * bucketFrames;
    gridStart < end;
    gridStart += bucketFrames
  ) {
    const left = Math.max(start, gridStart),
      right = Math.min(end, gridStart + bucketFrames);
    expected.push({
      gridStart,
      sampleRange: { start: left, end: right },
      partial: right - left !== bucketFrames,
      channels: [0, 1].map((channel) => {
        const values = Array.from({ length: right - left }, (_, i) =>
          Math.fround(sample(left + i, channel) * gain),
        );
        return {
          min: Math.min(...values),
          max: Math.max(...values),
          rms: Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length),
        };
      }),
    });
  }
  assert.deepEqual(document.buckets, expected);
  return {
    name,
    sha256: hash(bytes),
    buckets: expected.length,
    domain: document.domain,
    sampleRange: document.sampleRange,
    gain,
    audio: document.audio,
  };
}

try {
  const source = join(out, "phase-stereo.wav");
  await writeFile(source, wave());
  report.sourceSha256 = hash(await readFile(source));
  report.nativeSha256 = hash(await readFile(process.env.YAP_NATIVE));
  await service.start();
  async function admit(path, requestId) {
    const status = await call("asset.import", { requestId, path });
    await poll(
      () => call("job.get", { jobId: status.jobId }),
      (v) => v.state === "ready",
      "asset admission",
    );
    return call("asset.get", { assetId: hash(await readFile(path)) });
  }
  const audio = await admit(source, "phase-stereo"),
    video = await admit(join(root, "fixtures/narrated-workbench/video.mov"), "picture");
  const audioStream = audio.streams.find((s) => s.kind === "audio"),
    videoStream = video.streams.find((s) => s.kind === "video");
  assert.ok(audioStream && videoStream);
  report.admitted = { audio, video };
  const created = await call("project.create", {
    requestId: "tap-project",
    title: "Public audio tap journey",
    canvas: {
      width: 32,
      height: 32,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  const projectId = created.project.projectId,
    ref = (label) => ({ label });
  const scopes = [
    ["clip", "voice-clip", 3],
    ["track", "voice", 5],
    ["group", "inner", 7],
    ["group", "outer", 11],
    ["output", "output", 13],
  ];
  const placed = await call("edit.apply", {
    projectId,
    requestId: "nested-routing",
    expectedRevisionId: created.revision.revisionId,
    operations: [
      { operation: "group.add", label: "outer", group: { kind: "audio", order: 0 } },
      {
        operation: "group.add",
        label: "inner",
        group: { kind: "audio", order: 0, parentId: ref("outer") },
      },
      {
        operation: "track.add",
        label: "voice",
        track: { kind: "audio", order: 0, parentId: ref("inner") },
      },
      { operation: "track.add", label: "picture", track: { kind: "video", order: 0 } },
      ...[
        ["voice", audio, audioStream],
        ["picture", video, videoStream],
      ].map(([label, asset, stream]) => ({
        operation: "place",
        label: `${label}-clip`,
        clip: {
          trackId: ref(label),
          assetId: asset.assetId,
          streamId: stream.streamId,
          source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
        },
      })),
      ...scopes.map(([kind, label, gain]) => ({
        operation: "processing.set",
        target: kind === "output" ? { kind } : { kind, id: ref(label) },
        steps: [
          { label: `step-${label}`, processor: { type: "gain", gain } },
          { label: `disabled-${label}`, enabled: false, processor: { type: "gain", gain: 99 } },
          { label: `half-${label}`, processor: { type: "gain", gain: 0.5 } },
        ],
      })),
    ],
  });
  const revisionId = placed.revision.revisionId,
    range = { startUs: 333, endUs: 999000 };
  report.project = { projectId, revisionId };
  report.checks.taps = [];
  report.checks.waveforms = [];
  report.checks.sourceWaveform = await waveform(
    { assetId: audio.assetId, streamId: audioStream.streamId, sourceRange: range },
    range,
    1,
  );
  for (const [index, [kind, label, factor]] of scopes.entries()) {
    const target = kind === "output" ? { kind } : { kind, id: placed.edit.labels[label] };
    for (const mode of ["dry", "after-step", "processed"]) {
      const point =
        mode === "after-step"
          ? { kind: mode, stepId: placed.edit.labels[`step-${label}`] }
          : { kind: mode };
      const gain =
        scopes.slice(0, index).reduce((v, entry) => v * entry[2] * 0.5, 1) *
        (mode === "dry" ? 1 : factor * (mode === "processed" ? 0.5 : 1));
      const params = { projectId, revisionId, range, tap: { target, point } };
      const cli = await delivered(params, "cli"),
        mcp = await delivered(params, "mcp");
      assert.deepEqual(cli.bytes, mcp.bytes);
      const result = verify(cli.bytes, range, gain);
      assert.deepEqual(cli.data.published.output.sampleRange, {
        startSamples: result.start,
        endSamples: result.end,
      });
      report.checks.waveforms.push(await waveform(params, range, gain));
      report.checks.taps.push({
        target: label,
        mode,
        gain,
        ...result,
        cli: cli.name,
        mcp: mcp.name,
      });
    }
  }
  const full = await delivered({ projectId, revisionId }, "mcp");
  report.checks.full = verify(full.bytes, { startUs: 0, endUs: 1000000 }, 469.21875);
  const ranged = await delivered({ projectId, revisionId, range }, "cli");
  assert.deepEqual(pcm(ranged.bytes), pcm(full.bytes).subarray(15 * 8, 47952 * 8));
  report.checks.autoWaveform = await waveform(
    { assetId: audio.assetId, streamId: audioStream.streamId },
    { startUs: 0, endUs: 1000000 },
    1,
    null,
  );
  assert.equal(
    (
      await call(
        "waveform.get",
        { assetId: audio.assetId, streamId: audioStream.streamId, bucketFrames: 1 },
        { error: true },
      )
    ).code,
    "LIMIT_EXCEEDED",
  );
  const changed = await call("edit.apply", {
    projectId,
    requestId: "reorder-bypass-settings",
    expectedRevisionId: revisionId,
    operations: [
      {
        operation: "processing.set",
        target: { kind: "output" },
        steps: [
          { id: placed.edit.labels["half-output"], processor: { type: "gain", gain: 0.25 } },
          { id: placed.edit.labels["step-output"], processor: { type: "gain", gain: 4 } },
          {
            id: placed.edit.labels["disabled-output"],
            enabled: false,
            processor: { type: "gain", gain: 11 },
          },
        ],
      },
    ],
  });
  assert.notEqual(changed.revision.revisionId, revisionId);
  const changedAudio = await delivered(
    {
      projectId,
      range,
      tap: {
        target: { kind: "output" },
        point: { kind: "after-step", stepId: placed.edit.labels["half-output"] },
      },
    },
    "mcp",
  );
  report.checks.changed = verify(changedAudio.bytes, range, 18.046875);
  await service.stop();
  await service.start();
  assert.equal(
    (await call("project.get", { projectId })).currentRevisionId,
    changed.revision.revisionId,
  );
  const historical = await delivered({ projectId, revisionId, range }, "mcp");
  assert.deepEqual(historical.bytes, ranged.bytes);
  report.checks.historyRestart = true;
  report.checks.historicalWaveform = await waveform(
    { projectId, revisionId, range },
    range,
    469.21875,
  );
  const head = await delivered({ projectId, range }, "cli");
  report.checks.head = verify(head.bytes, range, 72.1875);
  const waveformRange = { startUs: 666, endUs: 777777 };
  const waveformRequest = {
    projectId,
    revisionId: changed.revision.revisionId,
    range: waveformRange,
    bucketFrames: 479,
  };
  const waveformHeld = await service.arm("media.mixCompositionAudio");
  const preparingWaveform = await call("waveform.get", waveformRequest);
  await waveformHeld();
  await call("job.cancel", { jobId: preparingWaveform.jobId });
  await poll(
    () => call("job.get", { jobId: preparingWaveform.jobId }),
    (v) => v.state === "canceled",
    "waveform audio dependency canceled",
  );
  await call("job.retry", { jobId: preparingWaveform.jobId }, { transport: "mcp" });
  report.checks.waveformDependencyRetry = await waveform(waveformRequest, waveformRange, 72.1875);
  const cancellationRange = { startUs: 777, endUs: 888888 };
  const held = await service.arm("media.mixCompositionAudio");
  const pending = await call("audio.get", { projectId, range: cancellationRange });
  await held();
  const canceled = await call("job.cancel", { jobId: pending.jobId }, { transport: "mcp" });
  assert.equal(canceled.state, "canceled");
  const retry = await call("job.retry", { jobId: pending.jobId });
  assert.equal(retry.jobId, pending.jobId);
  const retried = await delivered({ projectId, range: cancellationRange }, "mcp");
  report.checks.cancelRetry = verify(retried.bytes, cancellationRange, 72.1875);
  assert.equal((await call("project.delete", { projectId }, { transport: "mcp" })).deleted, true);
  assert.equal((await call("audio.get", { projectId }, { error: true })).code, "NOT_FOUND");
  assert.equal((await call("asset.get", { assetId: audio.assetId })).assetId, audio.assetId);
  report.checks.deletionPreservesSource = true;
  assert.equal(hash(await readFile(source)), report.sourceSha256);
  report.passed = true;
} catch (error) {
  report.error = { message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  await service.stop().catch((error) => {
    report.passed = false;
    report.shutdownError = error.message;
    process.exitCode = 1;
  });
  try {
    await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
    await writeFile(join(out, "service.log"), service.logs.join(""));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ passed: report.passed, out, error: report.error?.message }));
