import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { JourneyService, hash, poll, run, root } from "./source-evidence-fixture.mjs";
const { values } = parseArgs({
  options: { out: { type: "string" }, case: { type: "string", default: "explicit-and-preset" } },
});
assert.equal(values.case, "explicit-and-preset");
assert.ok(process.env.YAP_NATIVE);
const out = resolve(values.out ?? "/tmp/yap-output-settings"),
  home = await mkdtemp(join(tmpdir(), "sr-output-"));
await mkdir(out, { recursive: true });
const report = {
  passed: false,
  trace: [],
  checks: [],
  variants: [],
  nativeSha256: hash(await readFile(process.env.YAP_NATIVE)),
};
const service = new JourneyService(home, report),
  call = service.call.bind(service);
const probe = async (path) =>
  JSON.parse(
    (
      await run(
        "ffprobe",
        ["-v", "error", "-show_streams", "-show_format", "-show_frames", "-of", "json", path],
        { maxBuffer: 20 * 1024 ** 2 },
      )
    ).stdout,
  );
async function preview(projectId, settings, name, extra = {}) {
  const path = join(out, name + ".mp4");
  const ready = await poll(
    () => call("preview.get", { projectId, settings, ...extra }, { output: path }),
    (v) => v.state === "ready",
    name,
  );
  const info = await probe(path);
  const video = info.streams.find((v) => v.codec_type === "video"),
    audio = info.streams.find((v) => v.codec_type === "audio");
  assert.equal(video.codec_name, "h264");
  assert.equal(video.color_primaries, "bt709");
  assert.equal(audio.codec_name, "aac");
  const effective = ready.published.output.settings;
  assert.equal(ready.published.output.encodedVideo.profile, effective.video.profile);
  assert.equal(Number(ready.published.output.encodedVideo.level) * 10, video.level);
  const profiles = {
    baseline: ["Baseline", "Constrained Baseline"],
    main: ["Main"],
    high: ["High"],
    "constrained-baseline": ["Constrained Baseline"],
    "constrained-high": ["High", "Constrained High"],
  };
  assert.ok(
    profiles[effective.video.profile].includes(video.profile),
    "Encoder changed requested H.264 profile",
  );
  if (effective.video.level !== "auto")
    assert.equal(video.level, Number(effective.video.level) * 10);

  assert.equal(Number(audio.sample_rate), effective.audio.sampleRate);
  assert.equal(audio.channels, effective.audio.layout === "mono" ? 1 : 2);
  assert.ok(
    Math.abs(Number(video.duration) - Number(audio.duration)) <=
      1 / effective.audio.sampleRate + 0.001,
    "A/V track drift",
  );
  const frames = info.frames.filter((v) => v.media_type === "video");
  assert.equal(frames.length, ready.published.output.frameCount);
  const times = frames.map((v) => Number(v.best_effort_timestamp_time));
  assert.ok(times.every((v, i) => i === 0 || v > times[i - 1]));
  const entry = {
    name,
    settings: effective,
    bytes: (await readFile(path)).length,
    video: {
      profile: video.profile,
      level: video.level,
      bitrate: video.bit_rate,
      frames: frames.length,
      keyframes: frames.map((v, i) => (v.key_frame ? i : null)).filter((v) => v !== null),
      bFrames: frames.filter((v) => v.pict_type === "B").length,
    },
    audio: { rate: audio.sample_rate, channels: audio.channels, duration: audio.duration },
    generation: ready.published.generation,
    cacheId: ready.published.output.cacheId,
  };
  report.variants.push(entry);
  return { ready, path, entry };
}
try {
  await service.start();
  report.capabilities = await call("output.capabilities", {}, { transport: "mcp" });
  const tools = await service.mcp.listTools();
  assert.ok(tools.tools.some((v) => v.name === "output.capabilities"));
  const source = join(root, "fixtures/narrated-workbench/video.mov");
  async function importAsset(path) {
    const admitted = await call("asset.import", { requestId: randomUUID(), path });
    await poll(
      () => call("job.get", { jobId: admitted.jobId }),
      (v) => v.state === "ready",
      "asset import",
    );
    return call("asset.get", { assetId: hash(await readFile(path)) });
  }
  const asset = await importAsset(source);
  const video = asset.streams.find((v) => v.kind === "video");
  const sound = join(out, "source.wav");
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=997:sample_rate=48000:duration=3",
    "-ac",
    "2",
    "-c:a",
    "pcm_f32le",
    "-y",
    sound,
  ]);
  const narration = await importAsset(sound);
  const created = await call("project.create", {
    requestId: randomUUID(),
    title: "Output encoding controls",
    canvas: {
      width: 1280,
      height: 720,
      fps: { numerator: 30, denominator: 1 },
      background: "#181818ff",
    },
  });
  const projectId = created.project.projectId;
  const edited = await call("edit.apply", {
    projectId,
    requestId: randomUUID(),
    expectedRevisionId: created.revision.revisionId,
    operations: [
      { operation: "track.add", track: { kind: "video", order: 0 }, label: "video" },
      { operation: "track.add", track: { kind: "audio", order: 1 }, label: "audio" },
      {
        operation: "place",
        clip: {
          trackId: { label: "video" },
          assetId: asset.id,
          streamId: video.id,
          source: { kind: "range", range: { startUs: 0, endUs: 3000000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 3000000 } },
        },
      },
      {
        operation: "place",
        clip: {
          trackId: { label: "audio" },
          assetId: narration.id,
          streamId: narration.streams.find((v) => v.kind === "audio").streamId,
          source: { kind: "range", range: { startUs: 0, endUs: 3000000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 3000000 } },
        },
      },
    ],
  });
  report.project = edited;
  const balanced = await preview(projectId, undefined, "balanced");
  const equivalent = await call(
    "preview.get",
    { projectId, settings: balanced.entry.settings },
    { transport: "mcp" },
  );
  assert.equal(equivalent.published.output.cacheId, balanced.entry.cacheId);
  const override = await preview(
    projectId,
    {
      preset: "balanced",
      video: { keyframeInterval: 15, keyframeIntervalSeconds: 0.5 },
      audio: {
        sampleRate: 44100,
        layout: "mono",
        rateControl: { mode: "constant", bitrate: 96000 },
      },
    },
    "override",
  );
  assert.notEqual(override.entry.cacheId, balanced.entry.cacheId);
  assert.equal(override.entry.video.keyframes[0], 0);
  assert.ok(override.entry.video.keyframes.every((v, i, a) => !i || v - a[i - 1] <= 15));
  await preview(projectId, { video: { frameReordering: true } }, "reordering");
  await preview(
    projectId,
    { video: { frameReordering: true }, audio: { sampleRate: 32000 } },
    "range",
    { range: { startUs: 333333, endUs: 1666667 } },
  );
  for (const preset of ["compact", "sharp"]) await preview(projectId, { preset }, preset);
  for (const [name, settings] of [
    ["constant-rate", { video: { rateControl: { mode: "constant", bitrate: 8000000 } } }],
    ["quality-rate", { video: { rateControl: { mode: "quality", quality: 0.7 } } }],
    [
      "variable-rate",
      { video: { rateControl: { mode: "variable", bitrate: 8000000, maximumBitrate: 12000000 } } },
    ],
    ["baseline-profile", { video: { profile: "baseline", entropy: "cavlc" } }],
    ["main-profile", { video: { profile: "main" } }],
    ["required-hardware", { video: { encoder: { hardware: "required" } } }],
    [
      "preferred-gpu-fallback",
      { video: { encoder: { gpu: { policy: "preferred", registryId: "18446744073709551615" } } } },
    ],
    [
      "software",
      {
        video: {
          encoder: { hardware: "disabled" },
          openGop: null,
          prioritizeSpeed: null,
          spatialAdaptiveQuantization: null,
        },
      },
    ],
    [
      "specific-encoder",
      { video: { encoder: { id: report.capabilities.encoderSelection.encoders[0].id } } },
    ],
    ["constrained-baseline", { video: { profile: "constrained-baseline", entropy: "cavlc" } }],
    ["constrained-high", { video: { profile: "constrained-high" } }],
    [
      "automatic-guidance",
      {
        video: {
          keyframeInterval: 0,
          keyframeIntervalSeconds: 0,
          lookAheadFrames: 8,
          rateControl: { mode: "average", bitrate: 0 },
        },
      },
    ],
    [
      "low-rate-audio",
      {
        audio: {
          sampleRate: 16000,
          layout: "mono",
          rateControl: { mode: "constant", bitrate: 48000 },
        },
      },
    ],
    [
      "high-rate-mono",
      { audio: { layout: "mono", rateControl: { mode: "constant", bitrate: 192000 } } },
    ],
    ["variable-audio", { audio: { rateControl: { mode: "variable", quality: "high" } } }],
  ])
    await preview(projectId, settings, name);
  await preview(projectId, { video: { level: "4.0" } }, "explicit-level");
  const impossible = await poll(
    () =>
      call("preview.get", {
        projectId,
        settings: {
          video: { encoder: { gpu: { policy: "required", registryId: "18446744073709551615" } } },
        },
      }),
    (value) => value.state === "failed",
    "impossible GPU refusal",
  );
  assert.match(impossible.reason, /encoder unavailable/i);
  report.impossibleSelection = impossible;
  const cancellationSettings = { video: { keyframeInterval: 29 } };
  const hit = await service.arm("media.renderCompositionMovie");
  const pending = await call("preview.get", { projectId, settings: cancellationSettings });
  await hit();
  await call("job.cancel", { jobId: pending.jobId });
  await call("job.retry", { jobId: pending.jobId });
  await preview(projectId, cancellationSettings, "retry");
  await call("edit.apply", {
    projectId,
    requestId: randomUUID(),
    expectedRevisionId: edited.revision.revisionId,
    operations: [{ operation: "canvas.set", canvas: { background: "#080808ff" } }],
  });
  const historical = await call("preview.get", {
    projectId,
    revisionId: edited.revision.revisionId,
    settings: balanced.entry.settings,
  });
  assert.equal(historical.published.output.cacheId, balanced.entry.cacheId);
  const invalid = await call(
    "preview.get",
    { projectId, settings: { video: { profile: "baseline" } } },
    { error: true },
  );
  assert.equal(invalid.code, "INVALID_PARAMS");
  assert.match(invalid.message, /Baseline profile/);
  const invalidExport = await call(
    "export.create",
    {
      projectId,
      requestId: randomUUID(),
      kind: "video",
      directory: out,
      leaf: "invalid.mp4",
      settings: { video: { profile: "baseline" } },
    },
    { error: true, transport: "mcp" },
  );
  assert.equal(invalidExport.code, "INVALID_PARAMS");
  assert.match(invalidExport.message, /Baseline profile/);
  report.invalid = { preview: invalid, export: invalidExport };
  const exportId = randomUUID(),
    request = {
      projectId,
      revisionId: edited.revision.revisionId,
      exportId,
      kind: "video",
      directory: out,
      leaf: "export.mp4",
      settings: override.entry.settings,
    };
  await call("export.create", request);
  const exported = await poll(
    () => call("export.status", { exportId }),
    (v) => v.state === "ready",
    "export",
  );
  assert.equal(hash(await readFile(exported.output)), hash(await readFile(override.path)));
  await service.stop();
  await service.start();
  const replay = await call("export.create", request, { transport: "mcp" });
  assert.deepEqual(replay.snapshot.settings, override.entry.settings);
  report.checks.push(
    "CLI/MCP discover controls",
    "preset and explicit expansion reuse cache",
    "meaningful override changes work",
    "AAC output rate/layout conversion preserves A/V duration",
    "full/range reordered output completes bounded writer",
    "retained export replay preserves resolved settings",
  );
  report.passed = true;
} finally {
  try {
    await service.stop();
    report.logs = service.logs;
    await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ passed: report.passed, checks: report.checks }));
