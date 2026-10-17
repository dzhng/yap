import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { JourneyService, hash, poll, root, run } from "./source-evidence-fixture.mjs";

const { values } = parseArgs({ options: { out: { type: "string" } } });
assert.ok(process.env.YAP_NATIVE, "Freeze the native source-picture implementation first");
const out = values.out
  ? resolve(values.out)
  : await mkdtemp(join(tmpdir(), "source-frame-evidence-"));
await mkdir(out, { recursive: true });
const home = await mkdtemp(join(tmpdir(), "source-frame-public-"));
const fixture = join(root, "specs/done/agent-editing/assets/10d-source-frames/visual");
const report = { passed: false, trace: [], checks: {}, frames: [], batches: [] };
const service = new JourneyService(home, report);
const call = service.call.bind(service);
const originals = new Map();
const remember = async (file) => {
  originals.set(file, hash(await readFile(file)));
  return file;
};
const imageOracle = join(home, "image-oracle");
let pixelRead = 0;
async function pixels(file) {
  const raw = join(home, `pixels-${pixelRead++}.rgba`);
  const { stdout } = await run(imageOracle, [file, raw], { timeout: 30000 });
  const receipt = JSON.parse(stdout);
  assert.equal(receipt.opaque, true, "Fixture video PNG must remain opaque");
  const bytes = await readFile(raw);
  await rm(raw);
  assert.equal(bytes.length, receipt.width * receipt.height * 4);
  (report.imageProfiles ??= []).push({ file, ...receipt });
  return { bytes, width: receipt.width, height: receipt.height };
}
async function mcpNoImage(operation, params) {
  const reply = await service.mcp.callTool({ name: operation, arguments: params });
  assert.equal(reply.structuredContent.ok, true);
  assert.equal(reply.content.filter((item) => item.type === "image").length, 0);
  assert.equal(reply.structuredContent.data.contentIndex, undefined);
  return reply.structuredContent.data;
}
async function comparePicture(file, reference, kind, frame) {
  const actual = await pixels(file),
    expected = await pixels(reference);
  assert.deepEqual([actual.width, actual.height], [expected.width, expected.height]);
  assert.deepEqual([actual.width, actual.height], [frame.width, frame.height]);
  assert.ok(
    actual.bytes.equals(expected.bytes),
    "Public PNG pixels differ from independent color-managed reference",
  );
  (report.pictureComparisons ??= []).push({
    file,
    reference,
    kind,
    width: actual.width,
    height: actual.height,
    rgbaSha256: hash(actual.bytes),
    referenceRgbaSha256: hash(expected.bytes),
  });
}
async function matchesReference(file, name, frame) {
  return comparePicture(
    file,
    join(fixture, `reference-${name}.png`),
    "independent source reference",
    frame,
  );
}
async function imported(path, requestId) {
  const pending = await call("asset.import", { path, requestId });
  await poll(
    () => call("job.get", { jobId: pending.jobId }),
    (v) => v.state === "ready",
    "asset import",
  );
  return call("asset.get", { assetId: hash(await readFile(path)) });
}
async function ready(params) {
  return poll(
    () => call("frame.get", params, { transport: "mcp" }),
    (v) => v.state === "ready",
    "source picture",
  );
}
function provenance(value, selection, atUs, actualUs) {
  assert.equal(value.revisionId, undefined);
  assert.equal(value.projectId, undefined);
  const image = value.published.output;
  assert.equal(image.assetId, selection.assetId);
  assert.equal(image.streamId, selection.streamId);
  assert.equal(image.acquisitionId, selection.acquisitionId);
  assert.equal(image.atUs, atUs);
  assert.equal(image.requestedSourceUs, atUs);
  assert.equal(image.actualSourceUs, actualUs);
  assert.equal(image.sample.originUs, 1250000);
  assert.equal(
    BigInt(image.sample.value) * 1000000n,
    BigInt(actualUs + 1250000) * BigInt(image.sample.timescale),
  );
  assert.equal(
    BigInt(image.sample.endValue) * 1000000n,
    BigInt(actualUs + 1350000) * BigInt(image.sample.endTimescale),
  );
  assert.equal(image.clipId, undefined);
  assert.equal(image.revisionId, undefined);
  assert.equal(image.readerOpens, 1);
  assert.ok(image.decodedSamples > 0 && image.decodedSamples <= 2);
  return image;
}
async function deliveredPair(selection, name) {
  await ready({ ...selection, atUs: 150000 });
  const output = join(out, `${name}-cli.png`);
  const cli = await call("frame.get", { ...selection, atUs: 150000 }, { output });
  const image = provenance(cli, selection, 150000, 100000);
  assert.equal(cli.output, output);
  assert.equal((await stat(output)).size, image.bytes);
  await matchesReference(output, name === "track2" ? "second" : "first", image);
  const reply = await service.mcp.callTool({
    name: "frame.get",
    arguments: { ...selection, atUs: 150000 },
  });
  assert.equal(reply.structuredContent.ok, true);
  const mcp = reply.structuredContent.data;
  const content = reply.content.filter((item) => item.type === "image");
  assert.equal(content.length, 1);
  assert.equal(content[0].mimeType, "image/png");
  assert.ok(Buffer.from(content[0].data, "base64").equals(await readFile(output)));
  assert.equal(mcp.published.generation, cli.published.generation);
  provenance(mcp, selection, 150000, 100000);
  report.frames.push({
    name,
    selection,
    sha256: hash(await readFile(output)),
    generation: cli.published.generation,
    frame: image,
  });
  return cli;
}
try {
  await run(
    "swiftc",
    [
      "-parse-as-library",
      join(root, "packages/test-harness/editing/FrameImagePixels.swift"),
      "-o",
      imageOracle,
    ],
    { timeout: 30000 },
  );
  await service.start();
  const source = await remember(join(fixture, "source.mov"));
  const asset = await imported(source, "multi-video");
  assert.equal(asset.originUs, 1250000);
  const videos = asset.streams.filter((stream) => stream.kind === "video");
  assert.equal(videos.length, 2);
  const first = { assetId: asset.id, streamId: videos[0].id };
  const second = { assetId: asset.id, streamId: videos[1].id };
  await deliveredPair(first, "track1");
  await deliveredPair(second, "track2");
  await assert.rejects(() => mcpNoImage("frame.get", { ...first, atUs: 150000 }));
  const boundedParams = { ...first, atUs: 950000, maxLongEdge: 32 };
  await ready(boundedParams);
  const bounded = await call("frame.get", boundedParams, { output: join(out, "bounded-cli.png") });
  const boundedFrame = provenance(bounded, first, 950000, 900000);
  assert.deepEqual(
    [boundedFrame.width, boundedFrame.height, boundedFrame.sourceWidth, boundedFrame.sourceHeight],
    [32, 24, 64, 48],
  );
  const boundedBytes = await readFile(bounded.output);
  assert.deepEqual([boundedBytes.readUInt32BE(16), boundedBytes.readUInt32BE(20)], [32, 24]);
  await comparePicture(
    bounded.output,
    join(fixture, "frame-5.png"),
    "reviewed native bounded picture",
    boundedFrame,
  );
  report.checks.boundedDelivery = true;
  for (const transport of ["cli", "mcp"]) {
    const gap =
      transport === "mcp"
        ? await mcpNoImage("frame.get", { ...first, atUs: 450000 })
        : await call("frame.get", { ...first, atUs: 450000 }, { transport });
    assert.equal(gap.state, "unavailable");
    assert.equal(gap.reason, "physical_gap");
    assert.equal(gap.jobId, null);
    assert.equal(gap.published, null);
    assert.ok(gap.delivery == null);
  }
  report.checks.explicitTracksAndPhysicalGap = true;

  // The public capture importer admits one video stream with physical support. It does
  // not offer an authored video-mask API; no private table writes create one here.
  const builder = join(home, "fixture");
  await run(
    "swiftc",
    ["-parse-as-library", join(root, "helpers/mac/Tests/SourceFrame/fixture.swift"), "-o", builder],
    { timeout: 30000 },
  );
  const donor = join(home, "donor");
  await mkdir(donor);
  await remember(join(fixture, "first.mov"));
  await run(builder, [join(fixture, "first.mov"), join(donor, "video.mov")], { timeout: 30000 });
  const records = [
    {
      event: "header",
      data: {
        schemaVersion: 1,
        sessionID: `synthetic-frame-${randomUUID()}`,
        source: { kind: "window", windowID: 7 },
        width: 64,
        height: 48,
        microphone: false,
        systemAudio: false,
      },
    },
    { event: "origin", data: { hostUs: 1000000 } },
    { event: "finished", data: {} },
    { event: "lifecycle", data: { state: "complete" } },
  ];
  const journal = records
    .map((record, i) => JSON.stringify({ ...record, sequence: i + 1 }) + "\n")
    .join("");
  await writeFile(join(donor, "capture.journal.jsonl"), journal);
  const donorHash = hash(await readFile(join(donor, "video.mov")));
  const pending = await call("acquisition.import", { requestId: "capture-video", path: donor });
  const job = await poll(
    () => call("job.get", { jobId: pending.jobId }),
    (v) => v.state === "ready",
    "video acquisition",
  );
  const acquisition = await call("acquisition.get", { acquisitionId: job.target.acquisitionId });
  assert.equal(acquisition.journal.sha256, hash(journal));
  assert.equal(acquisition.bindings.length, 1);
  const binding = acquisition.bindings[0];
  assert.equal(binding.assetId, donorHash);
  assert.equal(binding.supportBasis, "physical");
  assert.deepEqual(binding.sourceRoles, ["video"]);
  assert.deepEqual(binding.available, [
    { startUs: 0, endUs: 400000 },
    { startUs: 600000, endUs: 1000000 },
  ]);
  const selected = {
    assetId: binding.assetId,
    streamId: binding.streamId,
    acquisitionId: acquisition.id,
  };
  const acquired = await deliveredPair(selected, "acquired");
  assert.notEqual(acquired.supportDigest, undefined);
  const wrong = await call(
    "frame.get",
    { ...first, acquisitionId: acquisition.id, atUs: 150000 },
    { error: true, transport: "mcp" },
  );
  assert.equal(wrong.code, "INVALID_PARAMS");
  assert.equal(hash(await readFile(join(donor, "video.mov"))), donorHash);
  await rm(donor, { recursive: true });
  await service.stop();
  await service.start();
  await ready({ ...selected, atUs: 850000 });
  const retained = await call(
    "frame.get",
    { ...selected, atUs: 850000 },
    { output: join(out, "retained-cli.png") },
  );
  provenance(retained, selected, 850000, 800000);
  await matchesReference(retained.output, "first", retained.published.output);
  report.checks.retainedAcquisition = {
    id: acquisition.id,
    donorDeleted: true,
    restarted: true,
    supportBasis: binding.supportBasis,
    customVideoMaskAdmission: false,
  };

  const batchParams = { ...second, atUs: [150000, 450000, 1000000, 950000, 150000] };
  await poll(
    () => call("frame.batch", batchParams, { transport: "mcp" }),
    (v) => v.items.every((item) => !item.ok || ["ready", "unavailable"].includes(item.data.state)),
    "source batch",
  );
  const batch = await call("frame.batch", batchParams, { output: join(out, "batch") });
  assert.equal(batch.revisionId, undefined);
  assert.equal(batch.assetId, second.assetId);
  assert.equal(batch.streamId, second.streamId);
  assert.deepEqual(
    batch.items.map((item) => item.atUs),
    batchParams.atUs,
  );
  assert.equal(batch.items[1].data.state, "unavailable");
  assert.equal(batch.items[1].data.reason, "physical_gap");
  assert.equal(batch.items[2].ok, false);
  assert.equal(batch.items[2].error.code, "INVALID_RANGE");
  for (const i of [0, 3, 4]) {
    assert.equal(batch.items[i].ok, true);
    provenance(batch.items[i].data, second, batchParams.atUs[i], i === 3 ? 900000 : 100000);
    await matchesReference(
      batch.items[i].data.output,
      "second",
      batch.items[i].data.published.output,
    );
  }
  assert.equal(batch.items[0].data.published.generation, batch.items[4].data.published.generation);
  const mcpBatch = await service.mcp.callTool({ name: "frame.batch", arguments: batchParams });
  assert.equal(mcpBatch.structuredContent.ok, true);
  const mcpItems = mcpBatch.structuredContent.data.items;
  assert.deepEqual(
    mcpItems.map((item) => item.atUs),
    batchParams.atUs,
  );
  assert.equal(mcpItems[1].data.state, "unavailable");
  assert.equal(mcpItems[1].data.reason, "physical_gap");
  assert.equal(mcpItems[2].ok, false);
  assert.equal(mcpItems[2].error.code, "INVALID_RANGE");
  assert.equal(mcpBatch.content.filter((item) => item.type === "image").length, 3);
  for (const i of [1, 2]) {
    const item = mcpBatch.structuredContent.data.items[i];
    assert.equal(item.data?.contentIndex, undefined);
    assert.ok(item.data?.delivery == null);
  }
  for (const i of [0, 3, 4]) {
    const item = mcpBatch.structuredContent.data.items[i];
    assert.equal(item.ok, true);
    provenance(item.data, second, batchParams.atUs[i], i === 3 ? 900000 : 100000);
    const content = mcpBatch.content[item.data.contentIndex];
    assert.equal(content.type, "image");
    assert.equal(content.mimeType, "image/png");
    assert.ok(
      Buffer.from(content.data, "base64").equals(await readFile(batch.items[i].data.output)),
    );
  }
  report.batches.push(batch);
  report.checks.mixedBatchCliAndMcp = true;

  const canceledParams = { ...first, atUs: 250000 };
  const hit = await service.arm("media.sourceFrame");
  const cancel = await call("frame.get", canceledParams, { transport: "mcp" });
  await hit();
  await call("job.cancel", { jobId: cancel.jobId }, { transport: "mcp" });
  await poll(
    () => call("job.get", { jobId: cancel.jobId }),
    (v) => v.state === "canceled",
    "cancel frame",
  );
  const canceled = await mcpNoImage("frame.get", canceledParams);
  assert.equal(canceled.reason, "canceled");
  assert.equal(canceled.published, null);
  assert.ok(canceled.delivery == null);
  assert.equal((await call("frame.get", canceledParams, { transport: "mcp" })).jobId, cancel.jobId);
  await call("job.retry", { jobId: cancel.jobId }, { transport: "mcp" });
  await ready(canceledParams);
  const retried = await call("frame.get", canceledParams, { output: join(out, "retried-cli.png") });
  provenance(retried, first, 250000, 200000);
  await matchesReference(retried.output, "first", retried.published.output);
  report.checks.cancelRetry = true;
  for (const [file, original] of originals) assert.equal(hash(await readFile(file)), original);
  report.originals = [...originals].map(([file, sha256]) => ({ file, sha256 }));
  assert.partialDeepStrictEqual(await call("model.status", { modelId: "parakeet" }), {
    state: "unavailable",
    presence: "absent",
  });
  report.passed = true;
} catch (error) {
  report.error = { message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  try {
    await service.stop();
  } catch (error) {
    report.shutdownError = error.message;
    report.passed = false;
    process.exitCode = 1;
  }
  try {
    await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
    await writeFile(join(out, "service.log"), service.logs.join(""));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ passed: report.passed, out, error: report.error }));
