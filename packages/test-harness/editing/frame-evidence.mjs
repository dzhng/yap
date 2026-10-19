import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { JourneyService, hash, poll, root, run } from "./source-evidence-fixture.mjs";
import { mask, classify } from "./render-membership.mjs";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    fixture: { type: "string", default: "repeated-picture" },
  },
});
assert.equal(values.fixture, "repeated-picture");
assert.ok(process.env.YAP_NATIVE, "Freeze a native worker before this journey");
const out = values.out ? resolve(values.out) : await mkdtemp(join(tmpdir(), "frame-evidence-"));
await mkdir(out, { recursive: true });
const home = await mkdtemp(join(tmpdir(), "sr-frame-evidence-"));
const report = {
  passed: false,
  trace: [],
  checks: {},
  scope:
    "Project video pictures; selected-source, retained-index and acquisition-gap media have separate live journeys",
};
const service = new JourneyService(home, report);
const call = service.call.bind(service);
const corpus = join(root, "specs/done/agent-editing/assets/00-corpus");
async function rgb(path) {
  const { stdout } = await run(
    "ffmpeg",
    [
      "-v",
      "error",
      "-nostdin",
      "-i",
      path,
      "-map",
      "0:v:0",
      "-fps_mode",
      "passthrough",
      "-pix_fmt",
      "rgb24",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    { encoding: "buffer", timeout: 60000, maxBuffer: 32 * 1024 ** 2 },
  );
  return stdout;
}
const refs = [{ id: "black", mask: new Uint8Array(160 * 128) }];
async function prepareReferences() {
  for (const [name, width, height, count] of [
    ["a", 160, 96, 8],
    ["b", 96, 128, 10],
  ]) {
    const pixels = await rgb(join(corpus, name + ".mov"));
    assert.equal(pixels.length, width * height * 3 * count);
    for (let n = 0; n < count; n++) {
      const padded = Buffer.alloc(160 * 128 * 3);
      for (let y = 0; y < height; y++)
        pixels.copy(
          padded,
          ((y + (128 - height) / 2) * 160 + (160 - width) / 2) * 3,
          (n * height + y) * width * 3,
          (n * height + y + 1) * width * 3,
        );
      refs.push({ id: name.toUpperCase() + n, mask: mask(padded) });
    }
  }
}

const expectations = [
  [0, 0, "A0", "first", 0],
  [20, 0, "A0", "first", 0],
  [50001, 0, "A0", "first", 0],
  [249999, 200000, "A0", "first", 200000],
  [499999, 400000, "A1", "first", 400000],
  [500001, 500000, "B1", "second", 200000],
  [899999, 800000, "B2", "second", 500000],
  [950000, 900000, "black", null, null],
  [1000000, 1000000, "A0", "repeat", 0],
  [1499999, 1400000, "A1", "repeat", 400000],
  [1500001, 1500000, "A3", "hold", 750000],
  [1799999, 1700000, "A3", "hold", 750000],
];
let serial = 0;
async function delivered(params, transport) {
  const ready = await poll(
    () => call("frame.get", params, { transport: "mcp" }),
    (value) => value.state === "ready",
    "picture ready",
  );
  const name = String(serial++).padStart(2, "0") + "-" + transport + ".png";
  let data, bytes;
  if (transport === "cli") {
    data = await call("frame.get", params, { output: join(out, name) });
    bytes = await readFile(join(out, name));
  } else {
    const result = await service.mcp.callTool({ name: "frame.get", arguments: params });
    assert.equal(result.structuredContent.ok, true);
    const images = result.content.filter((part) => part.type === "image");
    assert.equal(images.length, 1);
    assert.equal(images[0].mimeType, "image/png");
    bytes = Buffer.from(images[0].data, "base64");
    await writeFile(join(out, name), bytes);
    data = result.structuredContent.data;
  }
  assert.equal(data.revisionId, ready.revisionId);
  assert.equal(data.published.output.sizeBytes, bytes.length);
  return { data, bytes, name };
}
try {
  await prepareReferences();
  report.nativeSha256 = hash(await readFile(process.env.YAP_NATIVE));
  await service.start();
  const media = {};
  for (const name of ["a", "b"]) {
    const path = join(corpus, name + ".mov");
    const sha256 = hash(await readFile(path));
    const imported = await call("asset.import", { requestId: name, path });
    await poll(
      () => call("job.get", { jobId: imported.jobId }),
      (v) => v.state === "ready",
      "import",
    );
    const asset = await call("asset.get", { assetId: sha256 });
    media[name] = {
      assetId: asset.assetId,
      streamId: asset.streams.find((s) => s.kind === "video").streamId,
      audioStreamId: asset.streams.find((s) => s.kind === "audio").streamId,
      sha256,
    };
  }
  const created = await call("project.create", {
    requestId: "pictures",
    canvas: {
      width: 160,
      height: 128,
      fps: { numerator: 10, denominator: 1 },
      background: "#000000ff",
    },
  });
  const projectId = created.project.projectId;
  const place = (label, mediaName, source, startUs, endUs) => ({
    operation: "place",
    label,
    clip: {
      trackId: { label: "picture" },
      assetId: media[mediaName].assetId,
      streamId: media[mediaName].streamId,
      source,
      placement: { kind: "project", range: { startUs, endUs } },
    },
  });
  const edited = await call("edit.apply", {
    projectId,
    requestId: "place",
    expectedRevisionId: created.revision.revisionId,
    operations: [
      { operation: "track.add", track: { kind: "video", order: 0 }, label: "picture" },
      { operation: "track.add", track: { kind: "audio", order: 1 }, label: "voice" },
      {
        operation: "place",
        label: "retimed-voice",
        clip: {
          trackId: { label: "voice" },
          assetId: media.a.assetId,
          streamId: media.a.audioStreamId,
          source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 1800000 } },
        },
      },

      place("first", "a", { kind: "range", range: { startUs: 0, endUs: 500000 } }, 0, 500000),
      place(
        "second",
        "b",
        { kind: "range", range: { startUs: 200000, endUs: 600000 } },
        500000,
        900000,
      ),
      place(
        "repeat",
        "a",
        { kind: "range", range: { startUs: 0, endUs: 500000 } },
        1000000,
        1500000,
      ),
      place("hold", "a", { kind: "hold", atUs: 750000 }, 1500000, 1800000),
    ],
  });
  const revisionId = edited.revision.revisionId;
  report.project = { projectId, revisionId };
  const unavailableRetime = "fixture-unavailable-retime";
  const unavailablePreview = await call(
    "preview.get",
    { projectId, revisionId, retimeImplementationId: unavailableRetime },
    { error: true },
  );
  assert.equal(unavailablePreview.code, "NOT_READY");
  assert.equal(unavailablePreview.details.retimeImplementationId, unavailableRetime);
  report.checks.unavailableAudioDoesNotBlockPictures = { unavailablePreview };

  report.checks.pictures = [];
  let firstBytes;
  for (const [atUs, sampleAtUs, id, label, sourceUs] of expectations) {
    const params = { projectId, revisionId, atUs };
    const cli = await delivered(params, "cli"),
      mcp = await delivered(params, "mcp");
    assert.ok(cli.bytes.equals(mcp.bytes), "CLI and inline MCP PNG differ");
    const receipt = cli.data.published.output;
    assert.equal(receipt.frame.sampleAtUs, sampleAtUs);
    // The 10 fps fixture displays each global sample for 100 ms, even for
    // requests inside that interval; the request instant is not its visibility.
    assert.deepEqual(receipt.frame.visibleRange, {
      startUs: sampleAtUs,
      endUs: Math.min(sampleAtUs + 100000, 1800000),
    });
    assert.equal(receipt.width, 160);
    assert.equal(receipt.height, 128);
    if (label === null) assert.deepEqual(receipt.pictures, []);
    else {
      assert.equal(receipt.pictures[0].status, "available");
      assert.equal(receipt.pictures[0].clipId, edited.edit.labels[label]);
      assert.equal(receipt.pictures[0].requestedSourceUs, sourceUs);
    }
    const pixels = await rgb(join(out, cli.name));
    assert.equal(pixels.length, 160 * 128 * 3);
    const observed = classify(pixels, refs);
    assert.equal(observed.id, id);
    assert.ok(
      observed.differingPixels < observed.runnerUp.differingPixels,
      "Membership must be distinguishable from the next source picture",
    );
    report.checks.pictures.push({
      atUs,
      sampleAtUs,
      expected: id,
      observed,
      receipt,
      sha256: hash(cli.bytes),
      cli: cli.name,
      mcp: mcp.name,
    });
    firstBytes ??= cli.bytes;
  }
  const batch = await call(
    "frame.batch",
    { projectId, revisionId, atUs: [0, 1800000, 0] },
    { output: join(out, "batch") },
  );
  assert.deepEqual(
    batch.items.map((item) => item.ok),
    [true, false, true],
  );
  assert.equal(batch.items[1].error.code, "INVALID_RANGE");
  for (const index of [0, 2])
    assert.ok((await readFile(batch.items[index].data.output)).equals(firstBytes));
  report.checks.batch = batch;
  const mcpBatch = await service.mcp.callTool({
    name: "frame.batch",
    arguments: { projectId, revisionId, atUs: [0, 1800000, 0] },
  });
  assert.equal(mcpBatch.structuredContent.ok, true);
  assert.deepEqual(
    mcpBatch.structuredContent.data.items.map((item) => item.ok),
    [true, false, true],
  );
  const batchImages = mcpBatch.content.filter((part) => part.type === "image");
  assert.equal(batchImages.length, 2);
  for (const image of batchImages) assert.ok(Buffer.from(image.data, "base64").equals(firstBytes));
  report.checks.mcpBatch = true;

  const changed = await call("edit.apply", {
    projectId,
    requestId: "head",
    expectedRevisionId: revisionId,
    operations: [{ operation: "canvas.set", canvas: { width: 320 } }],
  });
  await service.stop();
  await service.start();
  const historical = await delivered({ projectId, revisionId, atUs: 0 }, "cli");
  assert.ok(historical.bytes.equals(firstBytes));
  const current = await delivered({ projectId, atUs: 0 }, "mcp");
  assert.equal(current.data.revisionId, changed.revision.revisionId);
  assert.equal(current.data.published.output.width, 320);
  report.checks.history = { old: revisionId, head: changed.revision.revisionId, sameOldPng: true };
  const hit = await service.arm("media.renderCompositionFrame");
  const pending = await call("frame.get", { projectId, revisionId, atUs: 33333 });
  await hit();
  await call("job.cancel", { jobId: pending.jobId });
  await poll(
    () => call("job.get", { jobId: pending.jobId }),
    (v) => v.state === "canceled",
    "canceled picture",
  );
  await call("job.retry", { jobId: pending.jobId });
  const retried = await delivered({ projectId, revisionId, atUs: 33333 }, "cli");
  assert.equal(retried.data.published.output.frame.sampleAtUs, 0);
  report.checks.cancelRetry = true;
  for (const name of ["a", "b"])
    assert.equal(hash(await readFile(join(corpus, name + ".mov"))), media[name].sha256);
  report.checks.originals = true;
  assert.equal(
    (
      await call(
        "project.delete",
        { projectId, requestId: "delete-pictures" },
        { transport: "mcp" },
      )
    ).deleted,
    true,
  );
  assert.equal(
    (await call("frame.get", { projectId, atUs: 0 }, { error: true })).code,
    "NOT_FOUND",
  );
  for (const name of ["a", "b"])
    assert.equal(
      (await call("asset.get", { assetId: media[name].assetId })).assetId,
      media[name].assetId,
    );
  // A new project cannot reuse a deleted project's cached picture artifacts.
  // Render both retained assets to verify owned media, not just catalog rows.
  const retained = await call("project.create", {
    requestId: "retained-pictures",
    canvas: {
      width: 160,
      height: 128,
      fps: { numerator: 10, denominator: 1 },
      background: "#000000ff",
    },
  });
  const retainedEdit = await call("edit.apply", {
    projectId: retained.project.projectId,
    expectedRevisionId: retained.revision.revisionId,
    requestId: "retained-place",
    operations: [
      { operation: "track.add", track: { kind: "video", order: 0 }, label: "picture" },
      place("retained-a", "a", { kind: "hold", atUs: 0 }, 0, 500000),
      place("retained-b", "b", { kind: "hold", atUs: 200000 }, 500000, 1000000),
    ],
  });
  report.checks.deletionPreservesSources = [];
  for (const [atUs, expected] of [
    [0, "A0"],
    [500000, "B1"],
  ]) {
    const frame = await delivered(
      {
        projectId: retained.project.projectId,
        revisionId: retainedEdit.revision.revisionId,
        atUs,
      },
      "cli",
    );
    const observed = classify(await rgb(join(out, frame.name)), refs);
    assert.equal(observed.id, expected);
    assert.ok(observed.differingPixels < observed.runnerUp.differingPixels);
    const previous = report.checks.pictures.find((picture) => picture.expected === expected);
    assert.equal(hash(frame.bytes), previous.sha256);
    report.checks.deletionPreservesSources.push({ expected, observed, sha256: hash(frame.bytes) });
  }
  report.passed = true;
} catch (error) {
  report.error = { message: String(error), stack: error.stack };
  throw error;
} finally {
  try {
    await service.stop();
  } catch (error) {
    report.passed = false;
    report.cleanupError = String(error);
  } finally {
    try {
      await writeFile(join(out, "service.log"), service.logs.join(""));
      await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
}
assert.equal(report.passed, true, report.cleanupError);
console.log(JSON.stringify({ passed: true, out }));
