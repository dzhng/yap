import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm, realpath, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { JourneyService, hash, poll, run } from "./source-evidence-fixture.mjs";
import { mediaWorker, nativeResult } from "../../../apps/service/dist/worker.js";
import { writeSourceWave, sourcePeriod } from "./audio-project-fixture.mjs";

const { values } = parseArgs({ options: { out: { type: "string" }, retime: { type: "boolean" } } });
const retime = Boolean(values.retime),
  durationUs = retime ? 1250000 : 1000000;
const frames = (durationUs * 48000) / 1000000;
assert(values.out && process.env.YAP_NATIVE);
const out = resolve(values.out),
  home = await realpath(await mkdtemp("/tmp/sr-prepared-public-"));
await mkdir(out);
const report = {
  passed: false,
  trace: [],
  ...(retime ? { exchanges: [] } : {}),
  checks: {},
  receipts: [],
  nativeSha256: hash(await readFile(process.env.YAP_NATIVE)),
  scope: retime
    ? "Public preserve-pitch preparation lifecycle: post-native-reply cancellation, pinned retry and restart; PCM compared with public baseline for storage/gain only, no quality or in-flight DSP cancellation claim."
    : "public full-output unit-rate/gain preparation; no stretch, denoise or speech-quality claim",
};
const nativeEvidence = retime ? join(out, "native") : undefined;
const service = new JourneyService(home, report, nativeEvidence),
  call = service.call.bind(service);
let baselinePCM = sourcePeriod(0);
let retimeImplementationId;
async function prepare(selection) {
  const result = await poll(
    () => call("audio.prepare", selection),
    (value) => value.state === "ready",
    "prepared audio",
  );
  assert.deepEqual(await call("audio.prepare", selection, { transport: "mcp" }), result);
  assert.deepEqual(await call("audio.prepare", selection), result);
  report.receipts.push(result);
  return result;
}
async function inspect(prepared, gain, name) {
  const audio = prepared.published.output;
  const asset = await call("asset.get", { assetId: audio.assetId });
  const stream = asset.streams.find((value) => value.kind === "audio");
  assert(stream);
  assert.equal(audio.frameCount, frames);
  assert.deepEqual(audio.sampleRange, { startSamples: 0, endSamples: frames });
  const startUs = name === "historical-after-restart" ? durationUs - 250000 : 0;
  const selection = {
    assetId: asset.assetId,
    streamId: stream.streamId,
    sourceRange: { startUs, endUs: durationUs },
  };
  await poll(
    () => call("audio.get", selection),
    (value) => value.state === "ready",
    "prepared asset audio",
  );
  const path = join(out, name + ".wav");
  await call("audio.get", selection, { output: path });
  const decoded = await run("ffmpeg", ["-v", "error", "-i", path, "-f", "f32le", "-"], {
    encoding: "buffer",
    maxBuffer: 1024 * 1024,
  });
  const expected = Buffer.from(baselinePCM.subarray(((startUs * 48000) / 1000000) * 8));
  for (let at = 0; at < expected.length; at += 4)
    expected.writeFloatLE(Math.fround(expected.readFloatLE(at) * gain), at);
  assert.deepEqual(decoded.stdout, expected);
  const wave = await poll(
    () => call("waveform.get", { ...selection, bucketFrames: 6000 }),
    (value) => value.state === "ready",
    "prepared waveform",
  );
  assert(wave.published);
  report.checks[name] = {
    exactPCM: true,
    pcmSha256: hash(decoded.stdout),
    frames: expected.length / 8,
    waveformReady: true,
    assetId: asset.assetId,
  };
}
try {
  if (retime) {
    const capabilities = nativeResult(await mediaWorker()("media.audioCapabilities", {}));
    assert.equal(typeof capabilities.retime, "string");
    retimeImplementationId = capabilities.retime;
    report.retimeImplementationId = retimeImplementationId;
  }
  await service.start();
  const source = join(home, "source.wav");
  await writeSourceWave(source, { source: 0, seconds: 1 });
  const imported = await call("asset.import", { requestId: "source", path: source });
  const job = await poll(
    () => call("job.get", { jobId: imported.jobId }),
    (value) => value.state === "ready",
    "import",
  );
  const sourceAsset = await call("asset.get", { assetId: job.published.output.assetId });
  const made = await call("project.create", {
    requestId: "project",
    canvas: {
      width: 16,
      height: 16,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  const projectId = made.project.projectId;
  const placed = await call("edit.apply", {
    projectId,
    expectedRevisionId: made.revision.revisionId,
    requestId: "place",
    operations: [
      { operation: "track.add", label: "audio", track: { kind: "audio", order: 0 } },
      {
        operation: "place",
        label: "clip",
        clip: {
          trackId: { label: "audio" },
          assetId: sourceAsset.assetId,
          streamId: sourceAsset.streams[0].streamId,
          source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 1000000 } },
          pitch: "preserve",
        },
      },
    ],
  });
  const authored = retime
    ? await call(
        "edit.apply",
        {
          projectId,
          expectedRevisionId: placed.revision.revisionId,
          requestId: "stretch",
          operations: [
            {
              operation: "retime",
              clipIds: [placed.edit.labels.clip],
              durationUs,
              scope: "selected",
              ripple: "none",
              pitch: "preserve",
            },
          ],
        },
        { transport: "mcp" },
      )
    : placed;
  const original = { projectId, revisionId: authored.revision.revisionId };
  if (retime) {
    const baseline = await poll(
      () => call("audio.get", original, { transport: "mcp" }),
      (value) => value.state === "ready",
      "public retimed baseline",
    );
    assert.equal(baseline.published.output.frameCount, frames);
    assert.equal(baseline.published.output.retimeImplementationId, retimeImplementationId);
    const path = join(out, "baseline.wav");
    await call("audio.get", original, { output: path });
    baselinePCM = (
      await run("ffmpeg", ["-v", "error", "-i", path, "-f", "f32le", "-"], {
        encoding: "buffer",
        maxBuffer: 1024 * 1024,
      })
    ).stdout;
    assert.equal(baselinePCM.length, frames * 8);
    report.checks.baseline = { receipt: baseline, pcmSha256: hash(baselinePCM), frames };
  }
  const ordinaryMovie = await poll(
    () => call("preview.get", original, { output: join(out, "ordinary-movie.mp4") }),
    (value) => value.state === "ready",
    "ordinary movie with no state prerequisites",
  );
  assert.equal(ordinaryMovie.published.output.durationUs, durationUs);
  report.checks.ordinaryMovie = ordinaryMovie.published.output;
  const first = await prepare(original);
  await inspect(first, 1, "original");
  const gained = await call("edit.apply", {
    projectId,
    expectedRevisionId: original.revisionId,
    requestId: "gain",
    operations: [
      {
        operation: "processing.set",
        target: { kind: "output" },
        steps: [
          {
            enabled: true,
            window: { kind: "project", range: { startUs: 0, endUs: durationUs } },
            processor: { type: "gain", gain: 0.5 },
          },
        ],
      },
    ],
  });
  const selection = { projectId, revisionId: gained.revision.revisionId };
  const blocked = await service.arm("media.mixCompositionAudio");
  const pending = await call("audio.prepare", selection);
  await blocked();
  const beforeCancel = await call("job.get", { jobId: pending.jobId });
  await call("job.cancel", { jobId: pending.jobId });
  const canceled = await call("job.get", { jobId: pending.jobId });
  assert.equal(canceled.state, "canceled");
  assert.equal(canceled.published, null);
  const canceledPreparation = await call("audio.prepare", selection);
  assert.equal(canceledPreparation.published, null);
  assert.deepEqual(await call("job.get", { jobId: pending.jobId }), canceled);
  const later = retime
    ? await call(
        "edit.apply",
        {
          projectId,
          expectedRevisionId: selection.revisionId,
          requestId: "advance-head",
          operations: [{ operation: "canvas.set", canvas: { width: 32 } }],
        },
        { transport: "mcp" },
      )
    : gained;
  await call("job.retry", { jobId: pending.jobId }, retime ? { transport: "mcp" } : {});
  const second = await prepare(selection);
  assert.equal(second.jobId, pending.jobId);
  const retried = await call("job.get", { jobId: pending.jobId });
  assert.deepEqual(retried.target, beforeCancel.target);
  assert.equal(retried.inputSha256, beforeCancel.inputSha256);
  assert.notEqual(retried.attemptId, beforeCancel.attemptId);
  assert.equal(retried.attemptGeneration, beforeCancel.attemptGeneration + 1);
  report.checks.retryIdentity = { beforeCancel, canceled, retried };
  assert.notEqual(second.published.output.assetId, first.published.output.assetId);
  await inspect(second, 0.5, "gain");
  assert.deepEqual(await call("revision.get", selection), { projectId, revision: gained.revision });
  assert.equal(
    (await call("project.get", { projectId })).currentRevisionId,
    later.revision.revisionId,
  );
  assert.deepEqual(await prepare(original), first);
  await service.stop();
  await service.start();
  assert.deepEqual(await prepare(selection), second);
  assert.deepEqual(await prepare(original), first);
  await inspect(first, 1, "historical-after-restart");
  if (!retime) {
    const shortened = await call("edit.apply", {
      projectId,
      expectedRevisionId: selection.revisionId,
      requestId: "retime",
      operations: [
        {
          operation: "retime",
          clipIds: [placed.edit.labels.clip],
          durationUs: 500000,
          scope: "selected",
          ripple: "none",
        },
      ],
    });
    const prepared = await prepare({ projectId, revisionId: shortened.revision.revisionId });
    assert.equal(prepared.published.output.frameCount, 24000);
    assert.deepEqual(prepared.published.output.sampleRange, { startSamples: 0, endSamples: 24000 });
    assert.equal(shortened.revision.document.clips[0].pitch, "preserve");
    report.checks.defaultPreserveRetime = prepared.published.output;
  } else {
    const mixes = [];
    for (const file of (await readdir(nativeEvidence))
      .filter((name) => name.startsWith("mix-"))
      .sort()) {
      const mix = JSON.parse(await readFile(join(nativeEvidence, file), "utf8"));
      assert.equal(mix.request.retimeImplementationId, retimeImplementationId);
      assert.equal(mix.response.ok, true);
      mixes.push({
        file,
        retimeImplementationId,
        range: mix.request.range,
        processing: mix.request.processing,
        frames: mix.response.data.frames,
      });
    }
    assert.equal(mixes.length, 4);
    report.checks.nativeRecipes = mixes;
  }
  report.checks.lifecycle = {
    repeatCLIAndMCP: true,
    canceledReplyNotPublished: true,
    noImplicitRetry: true,
    explicitRetry: true,
    exactHistoricalRestart: true,
    unchangedPinnedRevision: true,
    headPreservedAcrossRetry: true,
    ...(retime
      ? { retryAfterHeadAdvance: true, recipeBoundToNativeReceipts: true }
      : { unchangedRevisionAndHead: true, defaultPreserveRetimePrepared: true }),
  };
  report.passed = true;
} finally {
  await service.stop();
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
  await rm(home, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed: report.passed, checks: report.checks, out }));
