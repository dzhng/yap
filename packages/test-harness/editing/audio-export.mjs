import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { JourneyService, hash, poll, run } from "./source-evidence-fixture.mjs";
import { exportJourney } from "./first-export.mjs";
const priorAudioBitrate = process.env.YAP_TEST_AUDIO_DEFAULT_BITRATE;
const priorUnavailableOperations = process.env.YAP_TEST_UNAVAILABLE_OPERATIONS;
const { values } = parseArgs({
  options: { out: { type: "string" }, formats: { type: "string", default: "all" } },
});
assert.ok(process.env.YAP_NATIVE, "Pin the native worker before running");
assert.ok(["wav", "all"].includes(values.formats));
const out = resolve(values.out ?? "/tmp/yap-audio-export"),
  home = await mkdtemp(join(tmpdir(), "sr-audio-export-"));
await mkdir(out, { recursive: true });
const report = {
  passed: false,
  trace: [],
  exchanges: [],
  checks: {},
  nativeSha256: hash(await readFile(process.env.YAP_NATIVE)),
  performance: "unmeasured",
};
const forbidden = [
  "media.renderCompositionFrame",
  "media.renderCompositionMovie",
  "media.presentationEvidence",
  "media.outputCapabilities",
];
process.env.YAP_TEST_UNAVAILABLE_OPERATIONS = JSON.stringify(forbidden);
const service = new JourneyService(
  home,
  report,
  join(out, "native"),
  new URL("./first-preview-service.mjs", import.meta.url),
);
const call = service.call.bind(service);
const frames = 144000,
  raw = Buffer.alloc(frames * 8);
// Independent stereo oracle: exact binary fractions at every known sample boundary.
for (let i = 0; i < frames; i++) {
  raw.writeFloatLE(((i % 256) - 128) / 1024, i * 8);
  raw.writeFloatLE(((i % 128) - 64) / 2048, i * 8 + 4);
}
function wave(bytes) {
  let rate, channels;
  for (let at = 12; at + 8 <= bytes.length;) {
    const tag = bytes.toString("ascii", at, at + 4),
      size = bytes.readUInt32LE(at + 4);
    at += 8;
    if (tag === "fmt ") {
      rate = bytes.readUInt32LE(at + 4);
      channels = bytes.readUInt16LE(at + 2);
    }
    if (tag === "data") return { rate, channels, data: bytes.subarray(at, at + size) };
    at += size + (size % 2);
  }
  throw Error("No WAV data");
}
async function readyAudio(selection, name) {
  const path = join(out, name + ".wav");
  const status = await poll(
    () => call("audio.get", selection, { output: path }),
    (v) => v.state === "ready",
    name,
  );
  return { status, path, pcm: wave(await readFile(path)) };
}
async function exported(selection, name, settings, transport = "cli") {
  const request = {
    ...selection,
    kind: "audio",
    exportId: randomUUID(),
    directory: await realpath(out),
    leaf: name + (settings?.container === "m4a" ? ".m4a" : ".wav"),
    ...(settings ? { settings } : {}),
  };
  const before = await call("project.get", { projectId: selection.projectId });
  const initial = await call("export.create", request, { transport });
  const status = await poll(
    () => call("export.status", { exportId: request.exportId }, { transport }),
    (v) => v.state === "ready",
    name,
  );
  assert.deepEqual(
    await call("project.get", { projectId: selection.projectId }),
    before,
    "Export changed project state",
  );
  assert.equal(status.kind, "audio");
  assert.equal(status.receipt.sha256, hash(await readFile(status.output)));
  return { request, initial, status };
}
async function armFault(point) {
  const id = randomUUID();
  service.child.send({ type: "fault.arm", id, point });
  await poll(
    () => service.barriers.get(`${id}/fault.armed`) ?? {},
    (v) => v.type === "fault.armed",
    "fault armed",
  );
  return () =>
    poll(
      () => service.barriers.get(`${id}/fault.hit`) ?? {},
      (v) => v.type === "fault.hit",
      "fault hit",
    );
}
let projectId, head;
try {
  await writeFile(join(out, "original.f32"), raw);
  const video = join(out, "original.mov");
  await run("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=32x24:r=10:d=3",
    "-f",
    "f32le",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-i",
    join(out, "original.f32"),
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "pcm_f32le",
    "-shortest",
    video,
  ]);
  const originalSha = hash(await readFile(video));
  await service.start();
  report.checks.capabilities = await call(
    "output.capabilities",
    { kind: "audio" },
    { transport: "mcp" },
  );
  const imported = await call("asset.import", { requestId: "video", path: video });
  const loaded = await poll(
    () => call("job.get", { jobId: imported.jobId }),
    (v) => v.state === "ready",
    "import",
  );
  const asset = await call("asset.get", { assetId: loaded.published.output.assetId });
  const source = { assetId: asset.id, streamId: asset.streams.find((v) => v.kind === "audio").id };
  const extracted = await poll(
    () =>
      call(
        "audio.extract",
        { ...source, rendition: { sampleRate: 48000, channels: 2 } },
        { transport: "mcp" },
      ),
    (v) => v.state === "ready",
    "extract",
  );
  const audio = await call("asset.get", { assetId: extracted.published.output.assetId });
  const made = await call("project.create", {
    requestId: "project",
    canvas: {
      width: 32,
      height: 24,
      fps: { numerator: 10, denominator: 1 },
      background: "#000000ff",
    },
  });
  projectId = made.project.projectId;
  head = made.revision.id;
  const placed = await call("edit.apply", {
    projectId,
    expectedRevisionId: head,
    requestId: "place",
    operations: [
      { operation: "track.add", label: "picture", track: { kind: "video", order: 0 } },
      { operation: "track.add", label: "sound", track: { kind: "audio", order: 1 } },
      ...[
        ["picture", asset, asset.streams.find((v) => v.kind === "video").id],
        ["sound", audio, audio.streams[0].id],
      ].map(([track, a, streamId]) => ({
        operation: "place",
        label: track + "-clip",
        clip: {
          trackId: { label: track },
          assetId: a.id,
          streamId,
          source: { kind: "range", range: { startUs: 0, endUs: 3000000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 3000000 } },
          ...(track === "sound" ? { pitch: "preserve" } : {}),
        },
      })),
      {
        operation: "processing.set",
        target: { kind: "output" },
        steps: [
          {
            enabled: true,
            window: { kind: "project", range: { startUs: 0, endUs: 3000000 } },
            processor: { type: "gain", gain: 0.5 },
          },
        ],
      },
    ],
  });
  head = placed.revision.id;
  const split = await call(
    "edit.apply",
    {
      projectId,
      expectedRevisionId: head,
      requestId: "split",
      operations: [
        {
          operation: "split",
          clipIds: [placed.edit.labels["sound-clip"]],
          atUs: 1000000,
          scope: "selected",
          rightLabels: [{ clipId: placed.edit.labels["sound-clip"], label: "right" }],
        },
      ],
    },
    { transport: "mcp" },
  );
  head = split.revision.id;
  const trimmed = await call("edit.apply", {
    projectId,
    expectedRevisionId: head,
    requestId: "trim",
    operations: [
      {
        operation: "trim",
        clipId: placed.edit.labels["sound-clip"],
        range: { startUs: 250000, endUs: 1000000 },
        scope: "selected",
        ripple: "none",
      },
    ],
  });
  head = trimmed.revision.id;
  const selection = { projectId, revisionId: head },
    before = await call("revision.get", selection);
  const baseline = await readyAudio(selection, "processed");
  const expected = Buffer.from(raw);
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < 2; c++)
      expected.writeFloatLE(i < 12000 ? 0 : raw.readFloatLE(i * 8 + c * 4) * 0.5, i * 8 + c * 4);
  assert.equal(baseline.pcm.rate, 48000);
  assert.equal(baseline.pcm.channels, 2);
  assert.deepEqual(baseline.pcm.data, expected, "explicit trim and gain independent oracle");
  assert.equal(baseline.status.published.output.sampleRange.start, 0);
  assert.equal(baseline.status.published.output.sampleRange.end, frames);
  report.checks.oracle = {
    frames,
    channels: 2,
    sampleRate: 48000,
    pcmSha256: hash(expected),
    trimmedSourceFrames: [0, 12000],
    gain: 0.5,
  };
  report.checks.lifecycle = {};
  const kept = await exportJourney({
    out,
    projectId,
    revisionId: head,
    previewFile: baseline.path,
    kind: "audio",
    call,
    poll,
    advance: async () => {
      const later = await call("edit.apply", {
        projectId,
        expectedRevisionId: head,
        requestId: "advance",
        operations: [
          {
            operation: "processing.set",
            target: { kind: "output" },
            steps: [
              {
                enabled: true,
                window: { kind: "project", range: { startUs: 0, endUs: 3000000 } },
                processor: { type: "gain", gain: 0.25 },
              },
            ],
          },
        ],
      });
      head = later.revision.id;
    },
    armFault,
    crashService: async () => {
      await service.stop(true);
      await service.start();
      return { code: null, signal: "SIGKILL" };
    },
    evidence: report.checks.lifecycle,
  });
  assert.deepEqual(await call("revision.get", selection), before);
  const currentExpected = Buffer.from(expected);
  for (let i = 0; i < currentExpected.length; i += 4)
    currentExpected.writeFloatLE(currentExpected.readFloatLE(i) * 0.5, i);
  const withVideo = await exported({ projectId, revisionId: head }, "with-video");
  const removed = await call(
    "edit.apply",
    {
      projectId,
      expectedRevisionId: head,
      requestId: "remove-video",
      operations: [
        {
          operation: "remove",
          clipIds: [placed.edit.labels["picture-clip"]],
          scope: "selected",
          ripple: "none",
        },
        { operation: "track.remove", trackId: placed.edit.labels.picture },
      ],
    },
    { transport: "mcp" },
  );
  head = removed.revision.id;
  const audioOnly = await exported({ projectId, revisionId: head }, "without-video", {}, "mcp");
  assert.deepEqual(wave(await readFile(withVideo.status.output)).data, currentExpected);
  assert.deepEqual(
    await readFile(audioOnly.status.output),
    await readFile(withVideo.status.output),
  );
  const undone = await call("edit.undo", {
    projectId,
    expectedRevisionId: head,
    requestId: "undo-video",
  });
  head = undone.id;
  const undoAudio = await exported({ projectId, revisionId: head }, "undo-video");
  assert.deepEqual(wave(await readFile(undoAudio.status.output)).data, currentExpected);
  report.checks.videoRemoval = {
    withVideo: withVideo.status,
    removed: audioOnly.status,
    undo: undoAudio.status,
    currentPCM: hash(currentExpected),
    historicalPCM: hash(expected),
    laterGain: 0.25,
  };
  const occupied = join(out, "occupied.wav");
  await writeFile(occupied, "existing destination");
  const occupiedRequest = {
    projectId,
    kind: "audio",
    exportId: randomUUID(),
    directory: await realpath(out),
    leaf: "occupied.wav",
  };
  await call("export.create", occupiedRequest);
  const refused = await poll(
    () => call("export.status", { exportId: occupiedRequest.exportId }),
    (v) => v.state === "failed",
    "occupied destination",
  );
  assert.equal(await readFile(occupied, "utf8"), "existing destination");
  report.checks.occupied = refused;
  for (const settings of [
    { container: "mp3" },
    { container: "wav", video: {} },
    { container: "wav", audio: { sampleRate: 44100 } },
  ])
    for (const transport of ["cli", "mcp"]) {
      const error = await call(
        "export.create",
        {
          projectId,
          kind: "audio",
          exportId: randomUUID(),
          directory: out,
          leaf: "unsupported",
          settings,
        },
        { transport, error: true },
      );
      assert.equal(error.code, "INVALID_PARAMS");
    }
  if (values.formats === "all") {
    report.checks.aac = [];
    for (const [sampleRate, layout] of [
      [48000, "stereo"],
      [44100, "stereo"],
      [48000, "mono"],
      [44100, "mono"],
    ]) {
      const settings = { container: "m4a", audio: { sampleRate, layout } };
      const exportedAudio = await exported(
        selection,
        `aac-${sampleRate}-${layout}`,
        settings,
        "mcp",
      );
      const info = JSON.parse(
        (
          await run("ffprobe", [
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
            exportedAudio.status.output,
          ])
        ).stdout,
      );
      assert.equal(info.streams.length, 1);
      const stream = info.streams[0];
      assert.equal(stream.codec_name, "aac");
      assert.equal(stream.codec_type, "audio");
      assert.equal(Number(stream.sample_rate), sampleRate);
      assert.equal(stream.channels, layout === "mono" ? 1 : 2);
      const decoded = (
        await run(
          "ffmpeg",
          ["-v", "error", "-i", exportedAudio.status.output, "-f", "f32le", "-"],
          { encoding: "buffer", maxBuffer: 4 * 1024 ** 2 },
        )
      ).stdout;
      let reference = expected;
      if (layout === "mono") {
        reference = Buffer.alloc(frames * 4);
        for (let i = 0; i < frames; i++)
          reference.writeFloatLE(
            (expected.readFloatLE(i * 8) + expected.readFloatLE(i * 8 + 4)) / 2,
            i * 4,
          );
      }
      if (sampleRate !== 48000) {
        const referencePath = join(out, `reference-${layout}.f32`);
        await writeFile(referencePath, reference);
        reference = (
          await run(
            "ffmpeg",
            [
              "-v",
              "error",
              "-f",
              "f32le",
              "-ar",
              "48000",
              "-ac",
              String(stream.channels),
              "-i",
              referencePath,
              "-ar",
              String(sampleRate),
              "-f",
              "f32le",
              "-",
            ],
            { encoding: "buffer", maxBuffer: 4 * 1024 ** 2 },
          )
        ).stdout;
      }
      const errorOver = (start, end) => {
        let energy = 0,
          count = 0;
        for (let i = start; i < end; i++) {
          const error = decoded.readFloatLE(i * 4) - reference.readFloatLE(i * 4);
          assert.ok(Number.isFinite(error));
          energy += error * error;
          count++;
        }
        return Math.sqrt(energy / count);
      };
      const count = reference.length / 4;
      const errors = {
        whole: errorOver(0, count),
        trimOnset: errorOver(
          Math.floor(sampleRate / 4) * stream.channels,
          Math.floor(sampleRate / 4) * stream.channels + 2048 * stream.channels,
        ),
        first: errorOver(0, Math.min(count, 4096)),
        last: errorOver(Math.max(0, count - 4096), count),
      };
      assert.ok(
        Object.values(errors).every((v) => v < 0.02),
        "AAC changed channel mapping, zero origin or protected endpoint audio",
      );
      const decodedFrames = decoded.length / (stream.channels * 4);
      assert.ok(
        decodedFrames >= sampleRate * 3 && decodedFrames <= sampleRate * 3 + 2048,
        "AAC packet padding exceeds bounds",
      );
      report.checks.aac.push({
        settings,
        receipt: exportedAudio.status,
        stream,
        decodedFrames,
        decodedSha256: hash(decoded),
        referenceSha256: hash(reference),
        errors,
        tolerance: 0.02,
      });
      const replay = await call("export.create", exportedAudio.request);
      assert.deepEqual(replay.snapshot, exportedAudio.status.snapshot);
      assert.deepEqual(replay.receipt, exportedAudio.status.receipt);
    }
  }
  if (values.formats === "all") {
    const originalAAC = report.checks.aac[0];
    const nativeOperations = async () =>
      (await readFile(join(out, "native", "operations.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse);
    const beforeEncodes = (await nativeOperations()).filter(
      (v) => v.operation === "media.encodeAudioFile",
    ).length;
    const equivalent = await exported(
      selection,
      "aac-equivalent",
      originalAAC.receipt.snapshot.settings,
    );
    assert.equal(equivalent.status.receipt.sha256, originalAAC.receipt.receipt.sha256);
    assert.equal(
      (await nativeOperations()).filter((v) => v.operation === "media.encodeAudioFile").length,
      beforeEncodes,
      "Equivalent settings failed to reuse encoded PCM work",
    );
    await service.stop();
    process.env.YAP_TEST_AUDIO_DEFAULT_BITRATE = "128000";
    await service.start();
    const replay = await call(
      "export.create",
      {
        ...selection,
        kind: "audio",
        exportId: originalAAC.receipt.exportId,
        directory: originalAAC.receipt.destination.directory,
        leaf: originalAAC.receipt.destination.leaf,
        settings: originalAAC.settings,
      },
      { transport: "mcp" },
    );
    assert.deepEqual(
      replay.snapshot,
      originalAAC.receipt.snapshot,
      "Replay expanded changed defaults",
    );
    assert.deepEqual(replay.receipt, originalAAC.receipt.receipt);
    const newDefaults = await exported(selection, "aac-new-defaults", { container: "m4a" });
    assert.equal(newDefaults.status.snapshot.settings.audio.rateControl.bitrate, 128000);
    assert.notEqual(newDefaults.status.receipt.sha256, replay.receipt.sha256);
    report.checks.frozenDefaults = {
      equivalent: equivalent.status,
      replay,
      newDefaults: newDefaults.status,
      reusedEncoding: true,
    };
    const cancelSettings = {
      container: "m4a",
      audio: { rateControl: { mode: "variable", quality: "min" } },
    };
    const cancelRequest = {
      ...selection,
      kind: "audio",
      settings: cancelSettings,
      exportId: randomUUID(),
      directory: await realpath(out),
      leaf: "aac-canceled-retried.m4a",
    };
    const hit = await armFault("after-encode");
    const pending = await call("export.create", cancelRequest, { transport: "mcp" });
    const observed = await hit();
    // The fixture locates the real shared job; all actions/observations still use public controls.
    const database = new DatabaseSync(join(home, "library/catalog.sqlite"), { readOnly: true });
    let encodedJob;
    try {
      encodedJob = database
        .prepare(
          "SELECT jobId FROM jobs WHERE artifact='audio-file' AND targetKind='project' AND targetId=? AND revisionId=? AND json_extract(input,'$.settings.audio.rateControl.mode')='variable' AND json_extract(input,'$.settings.audio.rateControl.quality')='min'",
        )
        .get(selection.projectId, selection.revisionId);
    } finally {
      database.close();
    }
    assert.ok(encodedJob?.jobId);
    await call("export.cancel", { exportId: pending.exportId });
    const canceled = await call("job.cancel", { jobId: encodedJob.jobId }, { transport: "mcp" });
    assert.equal(canceled.state, "canceled");
    assert.equal(canceled.published, null);
    await assert.rejects(readFile(join(out, cancelRequest.leaf)), { code: "ENOENT" });
    const cancelStatus = await call("export.status", { exportId: pending.exportId });
    assert.equal(cancelStatus.state, "canceled");
    assert.equal(cancelStatus.receipt, null);
    await call("job.retry", { jobId: encodedJob.jobId }, { transport: "mcp" });
    const retry = await poll(
      () => call("export.status", { exportId: pending.exportId }),
      (v) => v.state === "ready",
      "AAC explicit retry",
    );
    const encodedReady = await call("job.get", { jobId: encodedJob.jobId });
    assert.equal(encodedReady.state, "ready");
    assert.ok(encodedReady.generation > canceled.generation);
    assert.ok(encodedReady.published.output.contentFrames > 0);
    assert.equal(retry.receipt.sha256, hash(await readFile(retry.output)));
    report.checks.aacDependencyCancellation = {
      request: cancelRequest,
      observed,
      canceled,
      cancelStatus,
      retry,
      encodedReady,
    };
    delete process.env.YAP_TEST_AUDIO_DEFAULT_BITRATE;
  }
  assert.equal(hash(await readFile(video)), originalSha);
  const operations = (await readFile(join(out, "native", "operations.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.ok(
    !operations.some((v) => forbidden.includes(v.operation)),
    "Audio export invoked a visual operation",
  );
  report.checks.noVideo = {
    forbidden,
    observedOperations: [...new Set(operations.map((v) => v.operation))],
  };
  await kept.afterDeletion();
  report.passed = true;
} finally {
  if (priorUnavailableOperations === undefined) delete process.env.YAP_TEST_UNAVAILABLE_OPERATIONS;
  else process.env.YAP_TEST_UNAVAILABLE_OPERATIONS = priorUnavailableOperations;
  if (priorAudioBitrate === undefined) delete process.env.YAP_TEST_AUDIO_DEFAULT_BITRATE;
  else process.env.YAP_TEST_AUDIO_DEFAULT_BITRATE = priorAudioBitrate;
  try {
    await service.stop();
    await writeFile(join(out, "service.log"), service.logs.join(""));
    await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ passed: report.passed, report: join(out, "report.json") }));
