import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm, realpath, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { mediaWorker, nativeResult } from "../../../apps/service/dist/worker.js";
import { writeSourceWave } from "./audio-project-fixture.mjs";
import {
  JourneyService,
  acquisitionDonor,
  hash,
  poll,
  root,
  run,
} from "./source-evidence-fixture.mjs";

const { values } = parseArgs({ options: { out: { type: "string" } } });
assert(values.out && process.env.YAP_NATIVE);
const out = resolve(values.out);
await mkdir(out);
const home = await realpath(await mkdtemp("/tmp/sr-extract-"));
const report = {
  passed: false,
  trace: [],
  receipts: [],
  checks: {},
  nativeSha256: hash(await readFile(process.env.YAP_NATIVE)),
};
const service = new JourneyService(home, report, join(out, "native"));
const call = service.call.bind(service);
const native = mediaWorker();
async function retainedBytes(excerpt, name) {
  const asset = await call("asset.get", { assetId: excerpt.assetId });
  const bytes = await readFile(join(service.home, "library/assets", asset.fileName));
  assert.equal(hash(bytes), excerpt.assetId);
  await writeFile(join(out, `${name}.wav`), bytes);
  return bytes;
}
async function compareSelection(input, excerpt, name) {
  const { rendition, ...selection } = input;
  await poll(
    () => call("audio.get", selection),
    (v) => v.state === "ready",
    "selected PCM",
  );
  const selected = join(out, `${name}-selected.wav`);
  await call("audio.get", selection, { output: selected });
  const request = { source: selected, output: join(out, `${name}-expected.wav`), ...rendition };
  const response = nativeResult(await native("media.convertSelectedAudio", request));
  report.nativeComparisons ??= [];
  report.nativeComparisons.push({ request, response });
  assert.deepEqual(await retainedBytes(excerpt, name), await readFile(request.output));
}
async function project(asset, name, { offsetUs = 0, durationUs = 1000000 } = {}) {
  const made = await call("project.create", {
    requestId: name,
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
    expectedRevisionId: made.revision.id,
    requestId: "place",
    operations: [
      { operation: "track.add", label: "audio", track: { kind: "audio", order: 0 } },
      {
        operation: "place",
        clip: {
          trackId: { label: "audio" },
          assetId: asset.id,
          streamId: asset.streams[0].id,
          source: { kind: "range", range: { startUs: 0, endUs: durationUs } },
          placement: {
            kind: "project",
            range: { startUs: offsetUs, endUs: offsetUs + durationUs },
          },
          pitch: "preserve",
        },
      },
    ],
  });
  return { projectId, revisionId: placed.revision.id };
}
async function imported(path, requestId) {
  const requested = await call("asset.import", { path, requestId });
  const job = await poll(
    () => call("job.get", { jobId: requested.jobId }),
    (v) => v.state === "ready",
    "import",
  );
  return call("asset.get", { assetId: job.published.output.assetId });
}
async function extract(input) {
  const result = await poll(
    () => call("audio.extract", input),
    (v) => v.state === "ready",
    "extract",
  );
  assert.deepEqual(await call("audio.extract", input, { transport: "mcp" }), result);
  report.receipts.push(result);
  return result.published.output;
}
try {
  await service.start();
  const reference = join(home, "reference.wav");
  await copyFile(join(root, "specs/done/agent-editing/assets/18-voice/reference.wav"), reference);
  const bytes = await readFile(reference);
  const asset = await imported(reference, "reference");
  const selected = {
    assetId: asset.id,
    streamId: asset.streams[0].id,
    rendition: { sampleRate: 24000, channels: 1 },
  };
  const retained = await extract(selected);
  assert.equal(retained.assetId, hash(bytes));
  assert.equal(retained.frames, 120000);
  assert.equal(retained.origin.conversion.implementationId, "verified-wav-copy-v1");
  const origins = await call("asset.origins", { assetId: retained.assetId });
  assert(
    origins.origins.some((origin) => JSON.stringify(origin) === JSON.stringify(retained.origin)),
  );
  const oddPath = join(home, "odd.wav");
  const oddBytes = Buffer.alloc(44 + 17 * 4);
  oddBytes.write("RIFF");
  oddBytes.writeUInt32LE(oddBytes.length - 8, 4);
  oddBytes.write("WAVEfmt ", 8);
  oddBytes.writeUInt32LE(16, 16);
  oddBytes.writeUInt16LE(3, 20);
  oddBytes.writeUInt16LE(1, 22);
  oddBytes.writeUInt32LE(44100, 24);
  oddBytes.writeUInt32LE(44100 * 4, 28);
  oddBytes.writeUInt16LE(4, 32);
  oddBytes.writeUInt16LE(32, 34);
  oddBytes.write("data", 36);
  oddBytes.writeUInt32LE(17 * 4, 40);
  oddBytes.writeFloatLE(1, oddBytes.length - 4);
  await writeFile(oddPath, oddBytes);
  const oddAsset = await imported(oddPath, "odd");
  const odd = await extract({
    assetId: oddAsset.id,
    streamId: oddAsset.streams[0].id,
    rendition: { sampleRate: 24000, channels: 1 },
  });
  assert.equal(
    odd.origin.input.frames,
    17,
    "An implicit whole WAV selection must not round away its final native frame",
  );
  assert.equal(odd.frames, 9);
  const oddRequest = {
    source: oddPath,
    output: join(out, "odd-expected.wav"),
    sampleRate: 24000,
    channels: 1,
  };
  const oddReply = nativeResult(await native("media.convertSelectedAudio", oddRequest));
  report.oddNative = { request: oddRequest, response: oddReply };
  assert.deepEqual(await retainedBytes(odd, "odd-retained"), await readFile(oddRequest.output));
  report.checks.exactWholeSourceFrames = true;
  const raw = {
    ...selected,
    range: { startUs: 0, endUs: 2500000 },
    rendition: { sampleRate: 44100, channels: 2 },
  };
  const dedupSelection = {
    assetId: selected.assetId,
    streamId: selected.streamId,
    range: raw.range,
  };
  await poll(
    () => call("audio.get", dedupSelection),
    (v) => v.state === "ready",
    "dedup donor",
  );
  const dedupSelected = join(out, "dedup-selected.wav");
  await call("audio.get", dedupSelection, { output: dedupSelected });
  const dedupWave = join(out, "dedup-converted.wav");
  nativeResult(
    await native("media.convertSelectedAudio", {
      source: dedupSelected,
      output: dedupWave,
      ...raw.rendition,
    }),
  );
  const dedupPath = join(home, "preexisting.aif");
  await copyFile(dedupWave, dedupPath);
  const preexisting = await imported(dedupPath, "preexisting-conversion");
  const rawExcerpt = await extract(raw);
  assert.equal(rawExcerpt.assetId, preexisting.id);
  assert.equal(
    (await call("asset.get", { assetId: rawExcerpt.assetId })).fileName,
    preexisting.fileName,
  );
  report.checks.convertedDifferentExtensionDedup = true;
  assert.equal(rawExcerpt.frames, 110250);
  await compareSelection(raw, rawExcerpt, "raw-converted");
  const stereoPath = join(home, "stereo.wav");
  await writeSourceWave(stereoPath, { source: 0, seconds: 1 });
  const stereo = await imported(stereoPath, "stereo");
  const stereoInput = {
    assetId: stereo.id,
    streamId: stereo.streams[0].id,
    rendition: { sampleRate: 24000, channels: 1 },
  };
  const stereoExcerpt = await extract(stereoInput);
  await compareSelection(stereoInput, stereoExcerpt, "stereo-mono");
  const aiffPath = join(home, "integer.aiff");
  await run("ffmpeg", ["-v", "error", "-i", stereoPath, "-c:a", "pcm_s16be", aiffPath]);
  const aiff = await imported(aiffPath, "integer-aiff");
  const aiffInput = {
    assetId: aiff.id,
    streamId: aiff.streams[0].id,
    rendition: { sampleRate: 24000, channels: 1 },
  };
  const decodedExcerpt = await extract(aiffInput);
  assert.equal(decodedExcerpt.origin.selectionImplementationId, "native-source-audio-v4");
  await compareSelection(aiffInput, decodedExcerpt, "integer-decoded");
  report.checks.nonFloatContainerSelection = true;
  const first = await project(stereo, "first");
  const tap = { target: { kind: "output" }, point: { kind: "processed" } };
  const input = {
    ...first,
    range: { startUs: 100000, endUs: 800000 },
    tap,
    rendition: { sampleRate: 24000, channels: 1 },
  };
  const original = await extract(input);
  const changed = await call("edit.apply", {
    projectId: first.projectId,
    expectedRevisionId: first.revisionId,
    requestId: "gain",
    operations: [
      {
        operation: "processing.set",
        target: { kind: "output" },
        steps: [{ processor: { type: "gain", gain: 0.5 } }],
      },
    ],
  });
  assert.deepEqual(await extract(input), original);
  const currentInput = { ...input, revisionId: changed.revision.id };
  const current = await extract(currentInput);
  assert.notEqual(current.assetId, original.assetId);
  assert.notEqual(
    current.origin.selection.processingSha256,
    original.origin.selection.processingSha256,
  );
  await compareSelection(input, original, "historical-project");
  await compareSelection(currentInput, current, "current-project");
  const second = await project(stereo, "second");
  const equal = await extract({ ...input, ...second });
  assert.equal(equal.assetId, original.assetId);
  assert.notDeepEqual(equal.origin.selection, original.origin.selection);
  const shifted = await project(stereo, "shifted", { offsetUs: 2000000 });
  const shiftedExcerpt = await extract({
    ...input,
    ...shifted,
    range: { startUs: 2100000, endUs: 2800000 },
  });
  const rawClockExcerpt = await extract({
    ...stereoInput,
    range: { startUs: 100000, endUs: 800000 },
  });
  assert.equal(shiftedExcerpt.assetId, original.assetId);
  assert.equal(rawClockExcerpt.assetId, original.assetId);
  assert.equal(shiftedExcerpt.origin.selection.sampleRange.start, 100800);
  assert.equal(rawClockExcerpt.origin.selection.sampleRange.start, 4800);
  report.checks.sourceAndProjectClocks = true;
  const equalOrigins = await call("asset.origins", { assetId: original.assetId });
  assert(
    equalOrigins.origins.some(
      (o) => o.kind === "extraction" && o.selection.projectId === first.projectId,
    ),
  );
  assert(
    equalOrigins.origins.some(
      (o) => o.kind === "extraction" && o.selection.projectId === second.projectId,
    ),
  );
  await call("project.delete", { projectId: first.projectId });
  await call("project.delete", { projectId: second.projectId });
  await call("project.delete", { projectId: shifted.projectId });
  await retainedBytes(original, "after-donor-deletion");
  const donor = join(home, "acquisition-donor");
  await acquisitionDonor(donor, stereoPath, [{ startUs: 200000, endUs: 800000 }]);
  const acquiring = await call("acquisition.import", { requestId: "gapped", path: donor });
  const acquired = await poll(
    () => call("job.get", { jobId: acquiring.jobId }),
    (v) => v.state === "ready",
    "acquisition",
  );
  const acquisition = await call("acquisition.get", {
    acquisitionId: acquired.target.acquisitionId,
  });
  const binding = acquisition.bindings.find((value) => value.sourceRoles.includes("narration"));
  assert(binding);
  const gapInput = {
    assetId: binding.assetId,
    streamId: binding.streamId,
    acquisitionId: acquisition.id,
    rendition: { sampleRate: 24000, channels: 1 },
  };
  const gapped = await extract(gapInput);
  assert(gapped.origin.selection.unavailable.length > 0);
  assert.equal(gapped.origin.selection.acquisitionId, acquisition.id);
  await compareSelection(gapInput, gapped, "acquisition-gaps");
  await rm(donor, { recursive: true });
  report.checks.acquisitionSupport = true;

  const cancelInput = {
    ...stereoInput,
    range: { startUs: 17001, endUs: 743219 },
    rendition: { sampleRate: 22050, channels: 1 },
  };
  const beforeCancel = await call("asset.list", {});
  const canceledHit = await service.arm("media.convertSelectedAudio");
  const canceled = await call("audio.extract", cancelInput);
  await canceledHit();
  const cancellation = await call("job.cancel", { jobId: canceled.jobId });
  assert.equal(cancellation.state, "canceled");
  assert.equal(cancellation.published, null);
  assert.deepEqual(await call("asset.list", {}), beforeCancel);
  await call("job.retry", { jobId: canceled.jobId });
  const retried = await extract(cancelInput);
  await compareSelection(cancelInput, retried, "canceled-retry");
  report.checks.cancellationFenceAndRetry = true;

  const crashInput = { ...cancelInput, range: { startUs: 21001, endUs: 753219 } };
  const beforeCrash = await call("asset.list", {});
  const crashHit = await service.arm("media.convertSelectedAudio");
  const crashed = await call("audio.extract", crashInput);
  await crashHit();
  await service.stop(true);
  await service.start();
  const recovered = await call("job.get", { jobId: crashed.jobId });
  assert.equal(recovered.state, "failed");
  assert.equal(recovered.published, null);
  assert.deepEqual(await call("asset.list", {}), beforeCrash);
  await call("job.retry", { jobId: crashed.jobId });
  const recoveredExcerpt = await extract(crashInput);
  await compareSelection(crashInput, recoveredExcerpt, "crash-retry");
  report.checks.crashRecoveryFence = true;

  report.checks.rawConversion = true;
  report.checks.currentHistoricalAndMultiOrigin = true;
  report.retained = [retained, rawExcerpt, stereoExcerpt, original, current];
  await rm(reference);
  await rm(stereoPath);
  await service.stop();
  await service.start();
  const stored = await call("asset.get", { assetId: retained.assetId });
  const persisted = await readFile(join(home, "library/assets", stored.fileName));
  assert.deepEqual(persisted, bytes);
  await writeFile(join(out, "canonical.wav"), persisted);
  report.checks.canonicalWholeWavAndRestart = true;
  for (const [index, excerpt] of report.retained.entries())
    await retainedBytes(excerpt, `restart-${index}`);
  const exportedAsset = await call("asset.get", { assetId: original.assetId });
  const carrier = await project(exportedAsset, "carrier", { durationUs: original.durationUs });
  const requestedExport = await call("export.create", {
    projectId: carrier.projectId,
    requestId: randomUUID(),
    kind: "processed-package",
    directory: out,
    leaf: "excerpt.zip",
  });
  const exportId = requestedExport.exportId;
  const exported = await poll(
    () => call("export.status", { exportId }),
    (v) => v.state === "ready",
    "export",
  );
  await service.stop();
  const receiver = await realpath(await mkdtemp("/tmp/sr-extract-receiver-"));
  report.receiver = receiver;
  service.home = receiver;
  await service.start();
  const admitted = await call("package.open", { path: exported.output });
  const opened = await poll(
    () => call("package.status", { admissionId: admitted.id }),
    (v) => v.state === "ready",
    "package",
  );
  await poll(
    () =>
      call("package.adopt", { packageHandle: opened.packageHandle, requestId: "adopt-excerpt" }),
    (v) => v.state === "ready",
    "adopt",
  );
  await call("package.close", { admissionId: admitted.id });
  await rm(home, { recursive: true });
  assert.deepEqual(
    await retainedBytes(original, "relocated-excerpt"),
    await readFile(join(out, "historical-project.wav")),
  );
  const relocatedOrigins = await call("asset.origins", { assetId: original.assetId });
  assert.deepEqual(relocatedOrigins.origins, equalOrigins.origins);
  const playable = { assetId: original.assetId, streamId: original.streamId };
  await poll(
    () => call("audio.get", playable),
    (v) => v.state === "ready",
    "relocated playback artifact",
  );
  await call("audio.get", playable, { output: join(out, "relocated-playable.wav") });
  report.checks.portableWithoutDonors = true;
  report.passed = true;
} finally {
  try {
    await service.stop();
    report.home = home;
    await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
    await writeFile(join(out, "service.log"), service.logs.join(""));
  } finally {
    await rm(home, { recursive: true, force: true });
    if (report.receiver) await rm(report.receiver, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ passed: report.passed, out }));
