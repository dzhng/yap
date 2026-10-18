import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { exportJourney } from "./first-export.mjs";
import { JourneyService } from "./source-evidence-fixture.mjs";
import { mask, classify } from "./render-membership.mjs";
import {
  assertTone,
  assertImpulse,
  rmsDifference,
  duplicatedMono,
  toneLevel,
} from "./preview-audio-evidence.mjs";

const args = process.argv.slice(2);
assert.ok(
  args.join(" ") === "--transport both" ||
    (args.length === 4 && args[0] === "--transport" && args[1] === "both" && args[2] === "--out"),
  "Expected --transport both [--out DIRECTORY]",
);
const out = args[3] ? resolve(args[3]) : await mkdtemp(join(tmpdir(), "yap-first-preview-"));
await mkdir(out, { recursive: true });
const home = await mkdtemp(join(tmpdir(), "sr-pv-"));
const corpus = new URL("../../../specs/done/agent-editing/assets/00-corpus/", import.meta.url)
  .pathname;
const run = promisify(execFile);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const report = {
  transport: "actual CLI child and MCP stdio",
  rendering: "production native worker",
  scope: "public project preview and video export; visual acceptance remains separate",
  passed: false,
  pending: ["fresh visual critique"],
  checks: {},
  trace: [],
};
let head, projectId;
const journey = new JourneyService(
  home,
  report,
  undefined,
  new URL("./first-preview-service.mjs", import.meta.url),
);
const serviceLog = journey.logs;
const rendered = new Map();
const faults = journey.barriers;
const startService = () => journey.start();
async function armFault(point) {
  const id = `${point}-${faults.size}`;
  journey.child.send({ type: "fault.arm", id, point });
  await poll(
    () => faults.get(`${id}/fault.armed`) ?? {},
    (value) => value.type === "fault.armed",
    "arm publication barrier",
  );
  return () =>
    poll(
      () => faults.get(`${id}/fault.hit`) ?? {},
      (value) => value.type === "fault.hit",
      `observe ${point}`,
    );
}
async function crashService() {
  const child = journey.child;
  await journey.stop(true);
  const exit = { code: child.exitCode, signal: child.signalCode };
  await startService();
  return exit;
}
const call = (operation, params, options) => journey.call(operation, params, options);
async function poll(read, done, label) {
  const deadline = performance.now() + 120000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    assert.ok(
      !["failed", "unavailable", "canceled"].includes(value.state),
      `${label}: ${JSON.stringify(value)}`,
    );
    assert.ok(performance.now() < deadline, `${label} made no bounded progress`);
    await delay(50);
  }
}
async function admit(name) {
  const pending = await call("asset.import", { requestId: name, path: join(corpus, name) });
  const job = await poll(
    () => call("job.get", { jobId: pending.jobId }),
    (value) => value.state === "ready",
    "import",
  );
  return call("asset.get", { assetId: job.published.output.assetId }, { transport: "mcp" });
}
async function edit(requestId, operations) {
  const result = await call("edit.apply", {
    projectId,
    requestId,
    expectedRevisionId: head,
    operations,
  });
  head = result.revision.revisionId;
  return result;
}
async function preview(name, revisionId = head, range) {
  const file = join(out, `${name}.mp4`);
  const params = { projectId, revisionId, ...(range ? { range } : {}) };
  const status = await poll(
    () => call("preview.get", params, { output: file }),
    (value) => value.state === "ready",
    name,
  );
  assert.equal(status.revisionId, revisionId);
  const expectedRange = range ?? { startUs: 0, endUs: 3000000 };
  assert.deepEqual(status.range, expectedRange);
  assert.deepEqual(status.published.output.range, expectedRange);
  assert.equal(status.published.output.projectId, projectId);
  assert.equal(status.published.output.revisionId, revisionId);
  assert.equal(status.published.output.mediaType, "video/mp4");
  assert.equal(status.output, file);
  assert.ok((await readFile(file)).length > 0);
  rendered.set(name, { file, range: expectedRange });
  return { file, status };
}
async function mcpPreview(revisionId = head, range) {
  return poll(
    () =>
      call(
        "preview.get",
        { projectId, revisionId, ...(range ? { range } : {}) },
        { transport: "mcp" },
      ),
    (value) => value.state === "ready",
    "MCP preview",
  );
}
async function delivered(status) {
  assert.equal(status.published.output.mediaType, "video/mp4");
  const { token, bytes } = status.delivery;
  assert.ok(bytes > 0);
  const chunks = [];
  let offset = 0;
  while (offset < bytes) {
    const params = { token, offset, maxBytes: Math.min(65536, bytes - offset) };
    const chunk = await call("artifact.read", params, { transport: "mcp" });
    if (offset === 0)
      assert.deepEqual(
        await call("artifact.read", params, { transport: "mcp" }),
        chunk,
        "Chunk retry must be stable",
      );
    const data = Buffer.from(chunk.data, "base64");
    assert.equal(chunk.offset, offset);
    assert.equal(chunk.nextOffset, offset + data.length);
    assert.ok(data.length > 0 && chunk.nextOffset <= bytes);
    chunks.push(data);
    offset = chunk.nextOffset;
    assert.equal(chunk.eof, offset === bytes);
  }
  await call("artifact.close", { token }, { transport: "mcp" });
  assert.equal(
    (await call("artifact.read", { token, offset: 0 }, { transport: "mcp", error: true })).code,
    "ARTIFACT_EXPIRED",
  );
  return Buffer.concat(chunks);
}
async function ff(args) {
  return (
    await run("ffmpeg", ["-v", "error", "-nostdin", ...args], {
      encoding: "buffer",
      timeout: 60000,
      maxBuffer: 32 * 1024 ** 2,
    })
  ).stdout;
}
async function probe(file) {
  return JSON.parse(
    (
      await run(
        "ffprobe",
        ["-v", "error", "-show_streams", "-show_frames", "-show_format", "-of", "json", file],
        { timeout: 30000, maxBuffer: 8 * 1024 ** 2 },
      )
    ).stdout,
  );
}
async function references() {
  const result = [];
  for (const [id, width, height, count] of [
    ["a", 160, 96, 8],
    ["b", 96, 128, 10],
  ]) {
    const raw = await ff([
      "-i",
      join(corpus, `${id}.mov`),
      "-map",
      "0:v:0",
      "-fps_mode",
      "passthrough",
      "-pix_fmt",
      "rgb24",
      "-f",
      "rawvideo",
      "pipe:1",
    ]);
    assert.equal(raw.length, count * width * height * 3);
    for (let frame = 0; frame < count; frame++) {
      const rgb = Buffer.alloc(160 * 128 * 3);
      for (let y = 0; y < height; y++)
        raw.copy(
          rgb,
          ((y + (128 - height) / 2) * 160 + (160 - width) / 2) * 3,
          (frame * height + y) * width * 3,
          (frame * height + y + 1) * width * 3,
        );
      result.push({ id: `${id.toUpperCase()}${frame}`, mask: mask(rgb) });
    }
  }
  return result;
}
const baselineIds = [
  "A0",
  "A0",
  "A0",
  "A1",
  "A1",
  "A2",
  "A2",
  "A2",
  "A3",
  "A3",
  "B0",
  "B0",
  "B1",
  "B1",
  "B2",
  "B2",
  "B3",
  "B3",
  "B4",
  "B4",
  "A4",
  "A4",
  "A4",
  "A5",
  "A5",
  "A6",
  "A6",
  "A6",
  "A7",
  "A7",
];
const replacedIds = [
  "B0",
  "B0",
  "B1",
  "B1",
  "B2",
  "B2",
  "B3",
  "B3",
  "B4",
  "B4",
  ...baselineIds.slice(10),
];
async function inspect(file, expectedIds, refs, range = { startUs: 0, endUs: 3000000 }) {
  const metadata = await probe(file);
  const video = metadata.streams.find((stream) => stream.codec_type === "video");
  const audio = metadata.streams.find((stream) => stream.codec_type === "audio");
  assert.deepEqual(
    [
      video?.width,
      video?.height,
      video?.codec_name,
      audio?.codec_name,
      Number(audio?.sample_rate),
      audio?.channels,
    ],
    [160, 128, "h264", "aac", 48000, 2],
  );
  assert.equal(Math.round(Number(metadata.format.duration) * 1e6), range.endUs - range.startUs);
  const raw = await ff([
    "-i",
    file,
    "-map",
    "0:v:0",
    "-fps_mode",
    "passthrough",
    "-pix_fmt",
    "rgb24",
    "-f",
    "rawvideo",
    "pipe:1",
  ]);
  const frames = metadata.frames.filter((frame) => frame.media_type === "video");
  assert.equal(raw.length, frames.length * 160 * 128 * 3);
  const observed = frames.map((frame, index) => ({
    atUs: Math.round(Number(frame.best_effort_timestamp_time) * 1e6),
    ...classify(raw.subarray(index * 160 * 128 * 3, (index + 1) * 160 * 128 * 3), refs),
  }));
  const wanted = [];
  for (let index = Math.floor(range.startUs / 100000); index * 100000 < range.endUs; index++) {
    const atUs = Math.max(range.startUs, index * 100000) - range.startUs;
    const actual = observed.findLast((frame) => frame.atUs <= atUs);
    assert.equal(actual?.id, expectedIds[index], `Frame at project ${range.startUs + atUs}`);
    assert.ok(actual.differingPixels < 200, `Counter glyph mismatch: ${JSON.stringify(actual)}`);
    wanted.push({
      atUs,
      projectUs: range.startUs + atUs,
      id: actual.id,
      differingPixels: actual.differingPixels,
    });
  }
  assert.equal(frames.length, wanted.length, "No duplicate or missing presentation frames");
  assert.deepEqual(
    observed.map((frame) => frame.atUs),
    wanted.map((frame) => frame.atUs),
    "Local frame PTS preserves exact clipped project phase",
  );
  const pcm = await ff(["-i", file, "-map", "0:a:0", "-f", "f32le", "pipe:1"]);
  const { left: samples, difference: channelDifference } = duplicatedMono(
    new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength)),
  );
  report.channelParity ??= {};
  report.channelParity[basename(file)] = channelDifference;
  const count = Math.floor((range.endUs * 48000) / 1e6) - Math.floor((range.startUs * 48000) / 1e6);
  // MP4 edit lists own playback length; AAC's decoded tail may include the last padded packet.
  assert.ok(
    samples.length >= count && samples.length - count < 1024,
    `AAC sample count ${samples.length}, expected ${count} plus less than one packet`,
  );
  return {
    raw,
    videoHash: hash(raw),
    samples: samples.subarray(0, count),
    frames: wanted,
    durationUs: range.endUs - range.startUs,
  };
}
async function observeRunning(params) {
  const requested = await call("preview.get", params, { transport: "mcp" });
  if (requested.state === "ready") {
    await call("artifact.close", { token: requested.delivery.token }, { transport: "mcp" });
    return null;
  }
  assert.equal(typeof requested.jobId, "string");
  const job = await poll(
    () => call("job.get", { jobId: requested.jobId }, { transport: "mcp" }),
    (value) => ["running", "ready"].includes(value.state),
    "observe native render",
  );
  return job.state === "running" ? job : null;
}
function recoveredAudio(samples, range, full) {
  const start = Math.floor((range.startUs * 48000) / 1e6);
  const expected = full.subarray(start, start + samples.length);
  const difference = rmsDifference(samples, expected, 2048, expected.length - 2048);
  assert.ok(difference < 0.002, `Recovered processed audio RMS ${difference}`);
  const levels = [
    [440, 33600, 43200, (4000 / 32768) * 0.12],
    [880, 97200, 99600, (4000 / 32768) * 0.15],
    [440, 97200, 99600, 0],
  ].map(([hz, begin, end, level]) => {
    const actual = toneLevel(samples, hz, begin - start, end - start);
    assert.ok(
      Math.abs(actual - level) < 0.002,
      `Recovered ${hz}Hz level ${actual}, expected ${level}`,
    );
    return actual;
  });
  const impulses = [
    [24000, 0.12],
    [72000, 0.12],
    [108000, 0.15],
  ]
    .filter(([at]) => at >= start + 144 && at + 144 < start + samples.length)
    .map(([at, gain]) => assertImpulse(samples, at - start, 0.25 * gain));
  return { difference, levels, impulses };
}
async function lifecycle(refs, fullAudio) {
  const range = { startUs: 100003, endUs: 2100003 };
  const params = { projectId, revisionId: head, range };
  const running = await observeRunning(params);
  if (running) {
    await call("job.cancel", { jobId: running.jobId }, { transport: "mcp" });
    const canceled = await poll(
      () => call("job.get", { jobId: running.jobId }),
      (value) => value.state === "canceled",
      "cancel drain",
    );
    assert.equal(canceled.published, null);
    const unpublished = await call("preview.get", params, { transport: "mcp" });
    assert.equal(unpublished.published, null);
    assert.equal(unpublished.delivery, null);
    await call("job.retry", { jobId: canceled.jobId }, { transport: "mcp" });
    const recovered = await preview("cancel-retry", head, range);
    const media = await inspect(recovered.file, baselineIds, refs, range);
    const audio = recoveredAudio(media.samples, range, fullAudio);
    report.checks.cancellation = {
      audio,
      observedState: running.state,
      unpublished: true,
      retryDecoded: true,
    };
  } else
    report.pending.push("render cancellation: job completed before running state was observable");
  const crashRange = { startUs: 300003, endUs: 2300003 };
  const crashParams = { projectId, revisionId: head, range: crashRange };
  const crashing = await observeRunning(crashParams);
  if (!crashing) {
    report.pending.push("render crash/recovery: job completed before running state was observable");
    return;
  }
  await crashService();
  const interrupted = await call("job.get", { jobId: crashing.jobId });
  assert.equal(interrupted.state, "failed");
  assert.equal(interrupted.errorCode, "JOB_INTERRUPTED");
  assert.equal(interrupted.published, null);
  const absent = await call("preview.get", crashParams, { transport: "mcp" });
  assert.equal(absent.published, null);
  assert.equal(absent.delivery, null);
  await call("job.retry", { jobId: interrupted.jobId }, { transport: "mcp" });
  const recovered = await preview("crash-retry", head, crashRange);
  const media = await inspect(recovered.file, baselineIds, refs, crashRange);
  const audio = recoveredAudio(media.samples, crashRange, fullAudio);
  report.checks.crashRecovery = {
    audio,
    observedState: crashing.state,
    signal: "SIGKILL",
    unpublished: true,
    retryDecoded: true,
  };
}
const source = (asset, kind, startUs, endUs) => ({
  assetId: asset.id,
  streamId: asset.streams.find((stream) => stream.kind === kind && stream.decodable).streamId,
  source: { kind: "range", range: { startUs, endUs } },
});
const place = (label, trackId, media, startUs, endUs) => ({
  operation: "place",
  label,
  clip: { trackId, ...media, placement: { kind: "project", range: { startUs, endUs } } },
});
try {
  const originalHashes = Object.fromEntries(
    await Promise.all(
      ["a.mov", "b.mov", "a-audio.wav", "b-audio.wav"].map(async (name) => [
        name,
        hash(await readFile(join(corpus, name))),
      ]),
    ),
  );
  const refs = await references();
  await startService();
  const a = await admit("a.mov"),
    b = await admit("b.mov");
  const created = await call("project.create", {
    requestId: "preview-project",
    title: "Live AV membership",
    canvas: {
      width: 160,
      height: 128,
      fps: { numerator: 10, denominator: 1 },
      background: "#000000ff",
    },
  });
  projectId = created.project.projectId;
  head = created.revision.revisionId;
  const placed = await edit("place-independent-media", [
    { operation: "track.add", label: "video", track: { kind: "video", order: 0 } },
    { operation: "track.add", label: "voice", track: { kind: "audio", order: 0 } },
    place("a-first", { label: "video" }, source(a, "video", 0, 1000000), 0, 1000000),
    place("b-middle", { label: "video" }, source(b, "video", 0, 1000000), 1000000, 2000000),
    place("a-repeat", { label: "video" }, source(a, "video", 1000000, 2000000), 2000000, 3000000),
    place("voice-first", { label: "voice" }, source(a, "audio", 0, 2000000), 0, 2000000),
    place("voice-repeat", { label: "voice" }, source(a, "audio", 0, 1000000), 2000000, 3000000),
  ]);
  const baselineRevision = head,
    ids = placed.edit.labels;
  const baseline = await preview("baseline");
  const base = await inspect(baseline.file, baselineIds, refs);
  const amplitude = 4000 / 32768;
  report.checks.baseline = {
    frames: base.frames,
    tones: [0, 1, 2].map((second) => assertTone(base.samples, 440, amplitude, second)),
    impulses: [24000, 72000, 120000].map((frame) => assertImpulse(base.samples, frame)),
  };
  assert.equal(
    (
      await call(
        "artifact.read",
        { token: baseline.status.delivery.token, offset: 0 },
        { transport: "mcp", error: true },
      )
    ).code,
    "ARTIFACT_EXPIRED",
    "CLI must close its delivered token",
  );
  await edit("video-only-replacement", [
    {
      operation: "replace",
      clipId: ids["a-first"],
      kind: "video",
      media: source(b, "video", 0, 1000000),
    },
  ]);
  const videoRevision = head;
  const videoOnly = await preview("video-replaced");
  const video = await inspect(videoOnly.file, replacedIds, refs);
  assert.notEqual(
    video.videoHash,
    base.videoHash,
    "Video replacement must change actual decoded pictures",
  );
  assert.equal(video.samples.length, base.samples.length);
  assert.ok(
    rmsDifference(video.samples, base.samples) < 1e-6,
    "Video replacement changed decoded A audio",
  );
  report.checks.videoReplacement = {
    frames: video.frames,
    audioRmsDifference: rmsDifference(video.samples, base.samples),
  };
  await edit("audio-only-replacement", [
    {
      operation: "replace",
      clipId: ids["voice-first"],
      kind: "audio",
      media: source(b, "audio", 0, 2000000),
    },
    {
      operation: "replace",
      clipId: ids["voice-repeat"],
      kind: "audio",
      media: source(b, "audio", 0, 1000000),
    },
  ]);
  const audioOnly = await preview("audio-replaced");
  const audio = await inspect(audioOnly.file, replacedIds, refs);
  assert.deepEqual(
    audio.frames.map((frame) => frame.id),
    video.frames.map((frame) => frame.id),
  );
  assert.equal(audio.videoHash, video.videoHash, "Audio replacement changed decoded video pixels");
  const removedA = [0, 1, 2].map((second) => assertTone(audio.samples, 440, 0, second));
  report.checks.audioReplacement = {
    removedA,
    tones: [0, 1, 2].map((second) => assertTone(audio.samples, 880, amplitude, second)),
    frames: audio.frames,
  };
  const undone = await call(
    "edit.undo",
    { projectId, requestId: "undo-audio", expectedRevisionId: head },
    { transport: "mcp" },
  );
  head = undone.id;
  const undoPreview = await preview("undo");
  const undo = await inspect(undoPreview.file, replacedIds, refs);
  assert.ok(rmsDifference(undo.samples, video.samples) < 1e-6);
  const restored = await call("edit.restore", {
    projectId,
    requestId: "restore-baseline",
    expectedRevisionId: head,
    targetRevisionId: baselineRevision,
  });
  head = restored.id;
  await edit("music-explicit-gain", [
    { operation: "track.add", label: "music", track: { kind: "audio", order: 1 } },
    place("music-first", { label: "music" }, source(b, "audio", 0, 2000000), 0, 2000000),
    place("music-repeat", { label: "music" }, source(b, "audio", 0, 1000000), 2000000, 3000000),
    {
      operation: "processing.set",
      target: { kind: "track", id: { label: "music" } },
      steps: [{ processor: { type: "gain", gain: 0.25 } }],
    },
  ]);
  const mixedPreview = await preview("music");
  const mixed = await inspect(mixedPreview.file, baselineIds, refs);
  assert.equal(mixed.videoHash, base.videoHash, "Music changed decoded video pixels");
  report.checks.music = {
    protectedA: [0, 1, 2].map((second) => assertTone(mixed.samples, 440, amplitude, second)),
    explicitB: [0, 1, 2].map((second) => assertTone(mixed.samples, 880, amplitude * 0.25, second)),
  };
  const historic = await mcpPreview(baselineRevision);
  assert.equal(historic.revisionId, baselineRevision);
  assert.equal(
    hash(await delivered(historic)),
    hash(await readFile(baseline.file)),
    "CLI/MCP delivery of one cached revision must match",
  );
  const old = await preview("historical-video", videoRevision);
  assert.ok(
    rmsDifference((await inspect(old.file, replacedIds, refs)).samples, video.samples) < 1e-6,
  );
  report.checks.undoAndHistorical = true;
  const range = { startUs: 50001, endUs: 1700001 };
  const bounded = await preview("range", baselineRevision, range);
  const partial = await inspect(bounded.file, baselineIds, refs, range);
  let rgbError = 0;
  const firstFrame = Math.floor(range.startUs / 100000);
  const expectedPixels = base.raw.subarray(
    firstFrame * 160 * 128 * 3,
    firstFrame * 160 * 128 * 3 + partial.raw.length,
  );
  for (let i = 0; i < partial.raw.length; i++)
    rgbError += Math.abs(partial.raw[i] - expectedPixels[i]);
  const rangeRgbMae = rgbError / partial.raw.length;
  assert.ok(rangeRgbMae < 2.5, `Range/full decoded RGB MAE ${rangeRgbMae}`);
  const start = Math.floor((range.startUs * 48000) / 1e6);
  const wanted = base.samples.subarray(start, start + partial.samples.length);
  // Independent AAC encodes differ near packet edges; compare the stable interior, not bytes.
  const difference = rmsDifference(partial.samples, wanted, 2048, wanted.length - 2048);
  assert.ok(difference < 0.005, `Window AAC interior RMS difference ${difference}`);
  const rangeImpulses = [24000, 72000].map((at) => assertImpulse(partial.samples, at - start));
  report.checks.projectTimeRange = {
    impulses: rangeImpulses,
    frames: partial.frames,
    audioInteriorRmsDifference: difference,
    rangeRgbMae,
  };
  const allScopeBase = await call("edit.restore", {
    projectId,
    requestId: "all-scopes-base",
    expectedRevisionId: head,
    targetRevisionId: baselineRevision,
  });
  head = allScopeBase.id;
  const gain = (target, value) => ({
    operation: "processing.set",
    target,
    steps: [{ processor: { type: "gain", gain: value } }],
  });
  await edit("all-scope-gain-chain", [
    { operation: "group.add", label: "outer", group: { kind: "audio", order: 0 } },
    {
      operation: "group.add",
      label: "inner",
      group: { kind: "audio", order: 0, parentId: { label: "outer" } },
    },
    {
      operation: "routing.set",
      target: { kind: "track", id: ids.voice },
      parentId: { label: "inner" },
      order: 0,
    },
    gain({ kind: "clip", id: ids["voice-first"] }, 0.8),
    gain({ kind: "clip", id: ids["voice-repeat"] }, 0.8),
    gain({ kind: "track", id: ids.voice }, 0.5),
    gain({ kind: "group", id: { label: "inner" } }, 0.75),
    gain({ kind: "group", id: { label: "outer" } }, 0.8),
    gain({ kind: "output" }, 0.5),
  ]);
  const chainPreview = await preview("all-scopes");
  const chain = await inspect(chainPreview.file, baselineIds, refs);
  assert.equal(chain.videoHash, base.videoHash, "Audio processing scopes changed decoded pictures");
  report.checks.allGainScopes = {
    gains: [0.8, 0.5, 0.75, 0.8, 0.5],
    tones: [0, 1, 2].map((second) => assertTone(chain.samples, 440, amplitude * 0.12, second)),
  };
  const inserted = await edit("insert-into-processed-track", [
    { operation: "remove", clipIds: [ids["voice-repeat"]], scope: "selected", ripple: "none" },
    place("new-voice", ids.voice, source(b, "audio", 0, 1000000), 2000000, 3000000),
  ]);
  const ownStack = await call(
    "processing.get",
    {
      projectId,
      revisionId: head,
      target: { kind: "clip", id: inserted.edit.labels["new-voice"] },
    },
    { transport: "mcp" },
  );
  assert.deepEqual(ownStack.steps, []);
  const insertedPreview = await preview("processed-track-insertion");
  const insertion = await inspect(insertedPreview.file, baselineIds, refs);
  assert.equal(insertion.videoHash, base.videoHash, "Inserted audio changed decoded pictures");
  report.checks.processedTrackInsertion = {
    ownStack: [],
    retainedA: [0, 1].map((second) => assertTone(insertion.samples, 440, amplitude * 0.12, second)),
    newB: assertTone(insertion.samples, 880, amplitude * 0.15, 2),
    removedA: assertTone(insertion.samples, 440, 0, 2),
  };
  await lifecycle(refs, insertion.samples);
  report.checks.exports = {};
  const exports = await exportJourney({
    out,
    projectId,
    revisionId: head,
    previewFile: insertedPreview.file,
    armFault,
    crashService,
    evidence: report.checks.exports,
    call,
    poll,
    advance: () => edit("advance-after-export", [gain({ kind: "output" }, 0.25)]),
  });
  const tokenToRevoke = (await mcpPreview()).delivery.token;
  await call("project.delete", { projectId });
  assert.equal(
    (
      await call(
        "artifact.read",
        { token: tokenToRevoke, offset: 0 },
        { transport: "mcp", error: true },
      )
    ).code,
    "ARTIFACT_EXPIRED",
  );
  for (const [name, digest] of Object.entries(originalHashes))
    assert.equal(hash(await readFile(join(corpus, name))), digest, `Original changed: ${name}`);
  report.checks.externalAfterDeletion = await exports.afterDeletion();
  report.checks.deletionAndOriginals = originalHashes;
  for (const [name, result] of rendered) {
    const count =
      Math.ceil(result.range.endUs / 100000) - Math.floor(result.range.startUs / 100000);
    await ff([
      "-i",
      result.file,
      "-vf",
      `tile=10x${Math.ceil(count / 10)}`,
      "-frames:v",
      "1",
      join(out, `${name}-contact.png`),
    ]);
  }
  for (const [name, frame] of [
    ["baseline", 0],
    ["baseline", 10],
    ["baseline", 20],
    ["video-replaced", 0],
    ["audio-replaced", 0],
    ["music", 0],
    ["range", 0],
    ["range", 17],
  ])
    await ff([
      "-i",
      join(out, `${name}.mp4`),
      "-vf",
      `select=eq(n\\,${frame}),scale=640:512:flags=neighbor`,
      "-frames:v",
      "1",
      join(out, `${name}-frame-${frame}-zoom.png`),
    ]);
  report.passed = true;
} catch (error) {
  report.error = { name: error.name, message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  try {
    await journey.stop();
  } catch (error) {
    report.passed = false;
    report.error ??= { message: error.message };
    process.exitCode = 1;
  }
  const service = journey.child;
  report.serviceExit = service ? { code: service.exitCode, signal: service.signalCode } : null;
  if (service && (service.exitCode !== 0 || service.signalCode !== null)) {
    report.passed = false;
    report.error ??= {
      message: `Service exited abnormally: code=${service.exitCode}, signal=${service.signalCode}`,
    };
    process.exitCode = 1;
  }
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await writeFile(join(out, "service.log"), serviceLog.join(""));
  await rm(home, { recursive: true, force: true });
  process.stdout.write(
    JSON.stringify(
      {
        evidence: out,
        passed: report.passed,
        pending: report.pending,
        ...(report.error ? { error: report.error.message } : {}),
      },
      null,
      2,
    ) + "\n",
  );
}
