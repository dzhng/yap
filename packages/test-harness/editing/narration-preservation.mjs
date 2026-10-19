import { verifyNarrationMusic } from "./narration-music-overlap.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { JourneyService, hash, poll, run, root } from "./source-evidence-fixture.mjs";

const { values } = parseArgs({ options: { out: { type: "string" } } });
assert(values.out && process.env.YAP_NATIVE, "Use --out and a frozen YAP_NATIVE");
const out = resolve(values.out),
  home = await mkdtemp("/tmp/sr-narration-");
await mkdir(out);
const report = {
  passed: false,
  trace: [],
  checks: {},
  receipts: {},
  scope:
    "12 seconds of recorded narration; visual-only edits; exact lossless PCM preservation, separate encoded clocks/observations; no listening acceptance",
  nativeSha256: hash(await readFile(process.env.YAP_NATIVE)),
  runtime: process.version,
  harnessSha256: hash(await readFile(new URL(import.meta.url))),
};
const service = new JourneyService(home, report),
  call = service.call.bind(service);
const full = { startUs: 0, endUs: 12000000 },
  sourceRange = { startUs: 1000000, endUs: 13000000 };
const range = { startUs: 1000011, endUs: 5000037 };
const bounds = (r) => ({
  start: Math.floor((r.startUs * 48000) / 1000000),
  end: Math.floor((r.endUs * 48000) / 1000000),
});
const sourcePaths = [
  join(root, "fixtures/narrated-workbench/narration.mov"),
  join(root, "fixtures/narrated-workbench/video.mov"),
  join(root, "specs/done/agent-editing/assets/00-corpus/b.mov"),
];
function samePCM(actual, expected) {
  assert.equal(Buffer.compare(actual, expected), 0, "Complete lossless PCM must match exactly");
}
async function ff(args) {
  return (
    await run("ffmpeg", ["-v", "error", "-nostdin", ...args], {
      encoding: "buffer",
      timeout: 60000,
      maxBuffer: 16 * 1024 ** 2,
    })
  ).stdout;
}
async function probe(file) {
  return JSON.parse(
    (
      await run("ffprobe", ["-v", "error", "-show_streams", "-of", "json", file], {
        timeout: 30000,
      })
    ).stdout,
  );
}
async function audio(selection, name, requested = full) {
  const params = { ...selection, range: requested };
  const ready = await poll(
    () => call("audio.get", params, { transport: "mcp" }),
    (v) => v.state === "ready",
    name,
  );
  const path = join(out, name + ".wav");
  const delivered = await call("audio.get", params, { output: path });
  const receipt = delivered.published.output,
    sampleRange = bounds(requested);
  assert.deepEqual(receipt.sampleRange, {
    startSamples: sampleRange.start,
    endSamples: sampleRange.end,
  });
  assert.equal(receipt.sampleRate, 48000);
  assert.equal(receipt.channels, 2);
  assert.equal(receipt.frameCount, sampleRange.end - sampleRange.start);
  assert.equal(delivered.revisionId, selection.revisionId);
  assert.equal(ready.published.generation, delivered.published.generation);
  const pcm = await ff(["-i", path, "-map", "0:a:0", "-f", "f32le", "-"]);
  assert.equal(pcm.length, receipt.frameCount * 8);
  for (let i = 0; i < pcm.length; i += 4) assert(Number.isFinite(pcm.readFloatLE(i)));
  report.receipts[name] = { ...receipt, file: name + ".wav", pcmSha256: hash(pcm) };
  return { pcm, path };
}
async function frame(selection, name) {
  const params = { ...selection, atUs: 5000000, maxLongEdge: 320 };
  await poll(
    () => call("frame.get", params),
    (v) => v.state === "ready",
    name,
  );
  const path = join(out, name + ".png");
  await call("frame.get", params, { output: path });
  return hash(await ff(["-i", path, "-f", "rawvideo", "-pix_fmt", "rgba", "-"]));
}
async function preview(selection, name, requested = full) {
  const path = join(out, name + ".mp4");
  const result = await poll(
    () => call("preview.get", { ...selection, range: requested }, { output: path }),
    (v) => v.state === "ready",
    name,
  );
  assert.deepEqual(result.range, requested);
  report.receipts[name] = result.published.output;
  return path;
}
async function encoded(file, requested, referencePCM) {
  const metadata = await probe(file),
    track = metadata.streams.find((s) => s.codec_type === "audio");
  const n = bounds(requested);
  assert(track);
  assert.equal(track.sample_rate, "48000");
  assert.equal(track.channels, 2);
  assert.equal(track.time_base, "1/48000");
  assert.equal(track.start_time, "0.000000");
  assert.equal(track.duration_ts, n.end - n.start);
  const decoded = await ff(["-i", file, "-map", "0:a:0", "-f", "f32le", "-"]);
  let squares = 0,
    max = 0;
  const count = Math.min(decoded.length, referencePCM.length) / 4;
  for (let i = 0; i < count; i++) {
    const delta = decoded.readFloatLE(i * 4) - referencePCM.readFloatLE(i * 4);
    assert(Number.isFinite(delta));
    squares += delta * delta;
    max = Math.max(max, Math.abs(delta));
  }
  return {
    codec: track.codec_name,
    declaredFrames: track.duration_ts,
    decodedFrames: decoded.length / 8,
    decodedMinusDeclaredFrames: decoded.length / 8 - track.duration_ts,
    startTime: track.start_time,
    timeBase: track.time_base,
    comparedSamples: count,
    decodedVsLosslessRms: Math.sqrt(squares / count),
    decodedVsLosslessMax: max,
    decodedPCMHash: hash(decoded),
    comparison: "observed only; no lossy-sample tolerance or listening verdict",
  };
}
try {
  report.inputs = await Promise.all(
    sourcePaths.map(async (path) => ({ path, sha256: hash(await readFile(path)) })),
  );
  await service.start();
  const assets = [];
  for (const [i, path] of sourcePaths.entries()) {
    const pending = await call("asset.import", { path, requestId: `source-${i}` });
    const job = await poll(
      () => call("job.get", { jobId: pending.jobId }),
      (v) => v.state === "ready",
      "source import",
    );
    assets.push(
      await call("asset.get", { assetId: job.published.output.assetId }, { transport: "mcp" }),
    );
  }
  const [narration, footage, alternate] = assets;
  const media = (asset, kind, selected) => ({
    assetId: asset.assetId,
    streamId: asset.streams.find((s) => s.kind === kind).streamId,
    source: { kind: "range", range: selected },
  });
  const made = await call("project.create", {
    requestId: "narrated",
    canvas: {
      width: 320,
      height: 180,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  const projectId = made.project.projectId;
  const placed = await call(
    "edit.apply",
    {
      projectId,
      requestId: "place",
      expectedRevisionId: made.revision.revisionId,
      operations: [
        { operation: "track.add", label: "audio", track: { kind: "audio", order: 0 } },
        { operation: "track.add", label: "video", track: { kind: "video", order: 0 } },
        ...[
          [narration, "audio"],
          [footage, "video"],
        ].map(([asset, kind]) => ({
          operation: "place",
          label: kind + "Clip",
          clip: {
            trackId: { label: kind },
            ...media(asset, kind, sourceRange),
            placement: { kind: "project", range: full },
            ...(kind === "audio" ? { pitch: "preserve" } : {}),
          },
        })),
      ],
    },
    { transport: "mcp" },
  );
  const original = { projectId, revisionId: placed.revision.revisionId },
    audioClip = placed.revision.document.clips.find((c) => c.id === placed.edit.labels.audioClip);
  const before = await audio(original, "original-full");
  assert(
    before.pcm.some((_, offset) => offset % 4 === 0 && before.pcm.readFloatLE(offset) !== 0),
    "Narration must contain real nonzero PCM",
  );
  const originalPicture = await frame(original, "original-frame");
  const originalMovie = await preview(original, "original-preview");
  const replacementRange = { startUs: 0, endUs: 1000000 };
  const replaced = await call("edit.apply", {
    projectId,
    requestId: "replace-picture",
    expectedRevisionId: original.revisionId,
    operations: [
      {
        operation: "replace",
        kind: "video",
        clipId: placed.edit.labels.videoClip,
        media: media(alternate, "video", replacementRange),
        fit: "stretch",
      },
    ],
  });
  const replacement = { projectId, revisionId: replaced.revision.revisionId };
  samePCM((await audio(replacement, "replaced-full")).pcm, before.pcm);
  assert.notEqual(await frame(replacement, "replaced-frame"), originalPicture);
  const edited = await call(
    "edit.apply",
    {
      projectId,
      requestId: "overlay-crop",
      expectedRevisionId: replacement.revisionId,
      operations: [
        { operation: "track.add", label: "overlay", track: { kind: "video", order: 1 } },
        {
          operation: "place",
          label: "overlayClip",
          clip: {
            trackId: { label: "overlay" },
            ...media(footage, "video", sourceRange),
            placement: { kind: "project", range: full },
          },
        },
        {
          operation: "processing.set",
          target: { kind: "clip", id: { label: "overlayClip" } },
          steps: [
            {
              processor: {
                type: "geometry",
                crop: { x: 40, y: 40, width: 320, height: 180 },
                rect: { x: 160, y: 90, width: 160, height: 90 },
                fit: "stretch",
              },
            },
          ],
        },
      ],
    },
    { transport: "mcp" },
  );
  const selection = { projectId, revisionId: edited.revision.revisionId };
  const after = await audio(selection, "edited-full");
  samePCM(after.pcm, before.pcm);
  assert.notEqual(
    await frame(selection, "edited-frame"),
    await frame(replacement, "replacement-frame-control"),
  );
  for (const revision of [replaced.revision, edited.revision])
    assert.deepEqual(
      revision.document.clips.find((c) => c.id === audioClip.id),
      audioClip,
    );
  const late = await audio(selection, "edited-range", range),
    n = bounds(range);
  samePCM(late.pcm, before.pcm.subarray(n.start * 8, n.end * 8));
  const editedMovie = await preview(selection, "edited-preview");
  const rangeMovie = await preview(selection, "edited-range-preview", range);
  const directory = await realpath(out);
  const { exportId } = await call(
    "export.create",
    {
      projectId,
      revisionId: selection.revisionId,
      requestId: randomUUID(),
      kind: "video",
      directory,
      leaf: "edited-export.mp4",
    },
    { transport: "mcp" },
  );
  const exported = await poll(
    () => call("export.status", { exportId }),
    (v) => v.state === "ready",
    "narrated export",
  );
  assert.equal(hash(await readFile(exported.output)), hash(await readFile(editedMovie)));
  report.encoded = {
    original: await encoded(originalMovie, full, before.pcm),
    edited: await encoded(editedMovie, full, after.pcm),
    range: await encoded(rangeMovie, range, late.pcm),
    export: await encoded(exported.output, full, after.pcm),
  };
  assert.equal(
    report.encoded.original.decodedPCMHash,
    report.encoded.edited.decodedPCMHash,
    "Visual edits must not change encoded audio",
  );
  await service.stop();
  await service.start();
  samePCM((await audio(original, "historical-after-restart")).pcm, before.pcm);
  assert.deepEqual((await call("revision.get", original)).revision, placed.revision);
  assert.deepEqual(
    (await call("revision.history", { projectId })).revisions.map((r) => r.revisionId),
    [
      made.revision.revisionId,
      placed.revision.revisionId,
      replaced.revision.revisionId,
      edited.revision.revisionId,
    ],
  );
  const undo = await call("edit.undo", {
    projectId,
    requestId: "undo-crop",
    expectedRevisionId: selection.revisionId,
  });
  assert.deepEqual(undo.document, replaced.revision.document);
  samePCM((await audio({ projectId, revisionId: undo.revisionId }, "undo-full")).pcm, before.pcm);
  for (const input of report.inputs) assert.equal(hash(await readFile(input.path)), input.sha256);
  for (const asset of assets)
    assert.deepEqual(await call("asset.get", { assetId: asset.assetId }), asset);
  for (const [name, file] of [
    ["original-listening", before.path],
    ["edited-listening", after.path],
  ])
    await ff(["-i", file, "-t", "4", "-c:a", "pcm_f32le", join(out, name + ".wav")]);
  report.checks = {
    fullLosslessPCMUnchanged: true,
    fractionalRangeMatchesFull: true,
    visualPixelsChanged: true,
    audioClipUnchanged: true,
    originalAssetsAndFilesUnchanged: true,
    historicalRevisionAndRestart: true,
    undo: true,
    fullRangeExportClocks: true,
    exportMatchesPreviewBytes: true,
  };
  report.listening =
    "Optional original/edited excerpts prepared; no listening assessment performed";
  if (process.env.YAP_NARRATION_MUSIC)
    report.musicOverlap = await verifyNarrationMusic({
      out,
      call,
      audio,
      frame,
      selection: { projectId, revisionId: undo.revisionId },
      document: undo.document,
      before,
      inputs: report.inputs,
    });
  report.passed = true;
} finally {
  await service.stop();
  await rm(home, { recursive: true, force: true });
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ out, passed: report.passed, checks: report.checks }, null, 2));
