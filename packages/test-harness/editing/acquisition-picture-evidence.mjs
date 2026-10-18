import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { acquisitionDonor, JourneyService, hash, poll, run } from "./source-evidence-fixture.mjs";
import { prepareLayersFixture } from "./layers-fixture.mjs";
import { compareGeometry } from "./layers-oracle.mjs";

const { values } = parseArgs({ options: { out: { type: "string" } } });
assert.ok(process.env.YAP_NATIVE, "Freeze the native worker before this journey");
assert.equal(process.env.YAP_TEST_PROBE_OVERRIDES, undefined, "Use real public admission");
const out = values.out
  ? resolve(values.out)
  : await mkdtemp(join(tmpdir(), "acquisition-pictures-"));
await mkdir(out, { recursive: true });
const home = await mkdtemp(join(tmpdir(), "sr-acquisition-pictures-"));
const report = { passed: false, trace: [], checks: {} };
const service = new JourneyService(home, report),
  call = service.call.bind(service);
const range = (startUs, endUs) => ({ startUs, endUs });
const full = [range(0, 1000000)],
  masked = [range(0, 350000), range(650000, 1000000)];
const canvas = {
  width: 64,
  height: 48,
  fps: { numerator: 10, denominator: 1 },
  background: "#000000ff",
};
let fixtures;
async function pixels(file) {
  const raw = join(home, "pixels.rgba");
  await rm(raw, { force: true });
  const receipt = JSON.parse((await run(fixtures.pixelTool, [file, raw])).stdout);
  assert.deepEqual([receipt.width, receipt.height], [64, 48]);
  return readFile(raw);
}
function visual(actual, absent) {
  if (absent) {
    assert.equal(actual.length, 64 * 48 * 4);
    assert.ok(
      actual.every((value, i) => value === (i % 4 === 3 ? 255 : 0)),
      "Excluded picture must be opaque black",
    );
    return { opaqueBlack: true };
  }
  return compareGeometry(actual, fixtures.media.screen.rgba, 64, 48);
}
async function image(operation, params, name) {
  const file = join(out, `${name}.png`);
  const data = await poll(
    () => call(operation, params, { output: file }),
    (value) => {
      assert.notEqual(value.state, "unavailable", JSON.stringify(value));
      return value.state === undefined || value.state === "ready";
    },
    name,
  );
  const mcp = await service.mcp.callTool({ name: operation, arguments: params });
  assert.equal(mcp.structuredContent.ok, true, JSON.stringify(mcp));
  const images = mcp.content.filter((item) => item.type === "image");
  assert.equal(images.length, 1);
  const bytes = await readFile(file);
  assert.ok(bytes.equals(Buffer.from(images[0].data, "base64")), "CLI and MCP images differ");
  report.trace.push({ operation, transport: "mcp", ok: true, inlineImage: true });
  return { file, sha256: hash(bytes), data, rgba: await pixels(file) };
}
function picture(frame, atUs, clipId) {
  const sampleAtUs = Math.floor(atUs / 100000) * 100000;
  const sourceUs = sampleAtUs % 1000000;
  const excluded = sampleAtUs < 1000000 && sourceUs >= 350000 && sourceUs < 650000;
  assert.equal(frame.frame.sampleAtUs, sampleAtUs);
  assert.deepEqual(frame.frame.visibleRange, range(sampleAtUs, sampleAtUs + 100000));
  assert.deepEqual(
    frame.frame.layers.map((layer) => [layer.clipId, layer.sourceUs, layer.availability]),
    [[clipId, sourceUs, excluded ? "anchor-unavailable" : "available"]],
  );
  assert.equal(frame.pictures.length, 1);
  assert.equal(frame.pictures[0].clipId, clipId);
  assert.equal(frame.pictures[0].requestedSourceUs, sourceUs);
  assert.equal(frame.pictures[0].status, excluded ? "unavailable" : "available");
  if (excluded) assert.equal(frame.pictures[0].reason, "anchor-unavailable");
  return excluded;
}
try {
  report.nativeSha256 = hash(await readFile(process.env.YAP_NATIVE));
  fixtures = await prepareLayersFixture(home, out);
  const audio = join(home, "narration.mov");
  await run("ffmpeg", [
    "-v",
    "error",
    "-nostdin",
    "-i",
    fixtures.media.narration.path,
    "-c:a",
    "pcm_f32le",
    audio,
  ]);
  await service.start();
  const contexts = {};
  for (const [name, available] of [
    ["a", masked],
    ["b", full],
  ]) {
    const donor = join(home, `donor-${name}`);
    const journalHash = await acquisitionDonor(donor, audio, available);
    await copyFile(fixtures.media.screen.path, join(donor, "video.mov"));
    const pending = await call("acquisition.import", { requestId: name, path: donor });
    const job = await poll(
      () => call("job.get", { jobId: pending.jobId }),
      (value) => value.state === "ready",
      "capture adoption",
    );
    const context = await call(
      "acquisition.get",
      { acquisitionId: job.target.acquisitionId },
      { transport: "mcp" },
    );
    assert.equal(context.journal.sha256, journalHash);
    const binding = (role) => context.bindings.find((value) => value.sourceRoles.includes(role));
    assert.deepEqual(binding("narration").available, available);
    assert.deepEqual(binding("video").available, full);
    assert.equal(binding("video").supportBasis, "physical");
    contexts[name] = { context, audio: binding("narration"), video: binding("video") };
    await rm(donor, { recursive: true });
  }
  assert.notEqual(contexts.a.context.id, contexts.b.context.id);
  for (const kind of ["audio", "video"]) {
    assert.equal(contexts.a[kind].assetId, contexts.b[kind].assetId);
    assert.equal(contexts.a[kind].streamId, contexts.b[kind].streamId);
  }
  report.checks.adoption = contexts;
  const selected = (kind, name) => {
    const context = contexts[name === "physical" ? "b" : name];
    const binding = context[kind];
    return {
      assetId: binding.assetId,
      streamId: binding.streamId,
      ...(name === "physical" ? {} : { acquisitionId: context.context.id }),
    };
  };
  // A video source with context A is still physically present: only its audio ancestor excludes it.
  report.checks.sources = [];
  for (const name of ["a", "b", "physical"]) {
    const source = await image(
      "frame.get",
      { ...selected("video", name), atUs: 400000, maxLongEdge: 64 },
      `source-${name}`,
    );
    assert.equal(source.data.state, "ready");
    report.checks.sources.push({
      name,
      sha256: source.sha256,
      data: source.data,
      verdict: visual(source.rgba, false),
    });
  }
  assert.equal(new Set(report.checks.sources.map((value) => value.sha256)).size, 1);
  const created = await call("project.create", { requestId: "pictures", canvas });
  const projectId = created.project.projectId;
  const operations = [
    { operation: "track.add", label: "audio", track: { kind: "audio", order: 0 } },
    { operation: "track.add", label: "video", track: { kind: "video", order: 0 } },
  ];
  for (const [index, name] of ["a", "b", "physical"].entries()) {
    operations.push({
      operation: "place",
      label: `${name}-audio`,
      clip: {
        ...selected("audio", name),
        trackId: { label: "audio" },
        source: { kind: "range", range: range(0, 1000000) },
        placement: { kind: "project", range: range(index * 1000000, (index + 1) * 1000000) },
      },
    });
    operations.push({
      operation: "place",
      label: `${name}-video`,
      clip: {
        ...selected("video", name),
        trackId: { label: "video" },
        source: { kind: "range", range: range(0, 1000000) },
        placement: {
          kind: "content",
          clipId: { label: `${name}-audio` },
          sourceRange: range(0, 1000000),
        },
      },
    });
  }
  const edited = await call(
    "edit.apply",
    {
      projectId,
      expectedRevisionId: created.revision.revisionId,
      requestId: "occurrences",
      operations,
    },
    { transport: "mcp" },
  );
  const selection = { projectId, revisionId: edited.revision.revisionId, maxLongEdge: 64 };
  report.project = { ...selection, labels: edited.edit.labels };
  const clipAt = (atUs) =>
    edited.edit.labels[`${["a", "b", "physical"][Math.floor(atUs / 1000000)]}-video`];
  const direct = new Map();
  report.checks.pictures = [];
  for (const offset of [0, 1000000, 2000000]) {
    for (const local of [
      0, 349999, 350000, 399999, 400000, 649999, 650000, 699999, 700000, 999999,
    ]) {
      const atUs = offset + local;
      const result = await image("frame.get", { ...selection, atUs }, `direct-${atUs}`);
      const excluded = picture(result.data.published.output, atUs, clipAt(atUs));
      const verdict = visual(result.rgba, excluded);
      direct.set(atUs, result);
      report.checks.pictures.push({
        atUs,
        excluded,
        sha256: result.sha256,
        receipt: result.data.published.output,
        verdict,
      });
    }
  }
  assert.notEqual(direct.get(400000).sha256, direct.get(1400000).sha256);
  assert.equal(direct.get(1400000).sha256, direct.get(2400000).sha256);
  assert.equal(direct.get(700000).sha256, direct.get(1700000).sha256);
  const first = await poll(
    () => call("index.get", { ...selection, limit: 1 }, { transport: "mcp" }),
    (value) => value.state === "ready",
    "retained project index",
  );
  const metadata = first.page.metadata;
  const reference = Object.fromEntries(
    ["projectId", "revisionId", "generation", "tap", "maxLongEdge"].map((key) => [
      key,
      metadata[key],
    ]),
  );
  const entries = [...first.page.entries];
  let cursor = first.page.nextCursor,
    afterOrdinal = -1;
  while (cursor) {
    assert.ok(cursor.afterOrdinal > afterOrdinal, "Index paging must advance");
    afterOrdinal = cursor.afterOrdinal;
    const next = await call("index.get", { ...selection, cursor, limit: 1 });
    assert.equal(next.page.metadata.generation, metadata.generation);
    entries.push(...next.page.entries);
    cursor = next.page.nextCursor;
  }
  for (const atUs of [300000, 400000, 600000, 700000])
    assert.ok(
      entries.some((entry) => entry.candidate.sampleAtUs === atUs),
      `Index omitted gap neighbor ${atUs}`,
    );
  assert.equal(entries.length, metadata.candidateCount);
  report.checks.index = { metadata, reference, images: [] };
  for (const entry of entries) {
    const atUs = entry.candidate.sampleAtUs;
    const result = await image(
      "index.frame",
      { ...reference, ordinal: entry.candidate.ordinal },
      `index-${atUs}`,
    );
    const excluded = picture(entry.frame, atUs, clipAt(atUs));
    const matching =
      direct.get(atUs) ?? (await image("frame.get", { ...selection, atUs }, `direct-${atUs}`));
    assert.equal(result.sha256, matching.sha256);
    assert.deepEqual(entry.frame.frame.visibleRange, entry.candidate.visibleRange);
    report.checks.index.images.push({
      entry,
      sha256: result.sha256,
      verdict: visual(result.rgba, excluded),
    });
  }
  const coverage = [];
  let afterSequence = -1;
  do {
    if (cursor) {
      assert.ok(cursor.afterSequence > afterSequence, "Coverage paging must advance");
      afterSequence = cursor.afterSequence;
    }
    const page = await call("index.coverage", {
      ...reference,
      limit: 1,
      ...(cursor ? { cursor } : {}),
    });
    coverage.push(...page.coverage);
    cursor = page.nextCursor;
  } while (cursor);
  for (const entry of entries)
    assert.deepEqual(
      coverage
        .filter((row) => row.ordinal === entry.candidate.ordinal)
        .map((row) => [row.project, row.equality]),
      [[entry.candidate.visibleRange, "sampled"]],
    );
  report.checks.index.coverage = coverage;
  const movie = join(out, "preview.mp4");
  const preview = await poll(
    () => call("preview.get", { projectId, revisionId: selection.revisionId }, { output: movie }),
    (value) => {
      assert.notEqual(value.state, "unavailable", JSON.stringify(value));
      return value.state === "ready";
    },
    "preview",
  );
  const references = join(out, "preview-frames");
  await mkdir(references);
  const request = join(home, "preview-reference.json");
  const timesUs = Array.from({ length: 30 }, (_, i) => i * 100000);
  await writeFile(request, JSON.stringify({ movie, output: references, timesUs }));
  const decoded = JSON.parse(
    (await run(fixtures.referenceTool, [request], { timeout: 60000 })).stdout,
  );
  report.checks.preview = { receipt: preview, sha256: hash(await readFile(movie)), pictures: [] };
  for (const item of decoded) {
    assert.equal(item.status, "available", item.error);
    const excluded = item.requestedUs >= 400000 && item.requestedUs <= 600000;
    report.checks.preview.pictures.push({
      ...item,
      verdict: visual(await pixels(item.file), excluded),
    });
  }
  const partialMovie = join(out, "range-preview.mp4");
  const partialRange = range(350001, 750001);
  const partial = await poll(
    () =>
      call(
        "preview.get",
        { projectId, revisionId: selection.revisionId, range: partialRange },
        { output: partialMovie },
      ),
    (value) => {
      assert.notEqual(value.state, "unavailable", JSON.stringify(value));
      return value.state === "ready";
    },
    "range preview",
  );
  assert.deepEqual(partial.published.output.range, partialRange);
  const partialDirectory = join(out, "range-frames");
  await mkdir(partialDirectory);
  const partialTimes = [0, 49999, 149999, 249999, 349999];
  await writeFile(
    request,
    JSON.stringify({ movie: partialMovie, output: partialDirectory, timesUs: partialTimes }),
  );
  const partialDecoded = JSON.parse(
    (await run(fixtures.referenceTool, [request], { timeout: 60000 })).stdout,
  );
  report.checks.rangePreview = {
    receipt: partial,
    sha256: hash(await readFile(partialMovie)),
    pictures: [],
  };
  for (const [index, item] of partialDecoded.entries()) {
    assert.equal(item.status, "available", item.error);
    const rgba = await pixels(item.file);
    const fullPicture = await pixels(decoded[index + 3].file);
    const fullComparison = compareGeometry(rgba, fullPicture, 64, 48);
    report.checks.rangePreview.pictures.push({
      ...item,
      fullComparison,
      verdict: visual(rgba, index > 0 && index < 4),
    });
  }
  const changed = await call("edit.apply", {
    projectId,
    expectedRevisionId: selection.revisionId,
    requestId: "new-head",
    operations: [{ operation: "canvas.set", canvas: { background: "#ffffffff" } }],
  });
  await service.stop();
  await service.start();
  const historical = await image("frame.get", { ...selection, atUs: 400000 }, "historical");
  assert.equal(historical.sha256, direct.get(400000).sha256);
  const gapEntry = entries.find((entry) => entry.candidate.sampleAtUs === 400000);
  const retained = await image(
    "index.frame",
    { ...reference, ordinal: gapEntry.candidate.ordinal },
    "historical-index",
  );
  assert.equal(retained.sha256, historical.sha256);
  // A fresh request key proves retained media/context resolution after donor deletion and restart.
  const fresh = await image("frame.get", { ...selection, atUs: 400001 }, "historical-uncached");
  assert.equal(fresh.sha256, historical.sha256);
  picture(fresh.data.published.output, 400001, clipAt(400001));
  const head = await image(
    "frame.get",
    { projectId, atUs: 400000, maxLongEdge: 64 },
    "current-head",
  );
  assert.equal(head.data.revisionId, changed.revision.revisionId);
  assert.ok(
    head.rgba.every((value) => value === 255),
    "New head must render the white gap background",
  );
  report.checks.history = {
    oldRevision: selection.revisionId,
    currentRevision: changed.revision.revisionId,
    historicalHash: historical.sha256,
    uncachedHash: fresh.sha256,
    currentHash: head.sha256,
    donorsDeletedBeforePictures: true,
  };
  report.passed = true;
} catch (error) {
  report.error = { message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  try {
    await service.stop().catch((error) => {
      report.passed = false;
      report.shutdownError = error.message;
      process.exitCode = 1;
    });
    await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
    await writeFile(join(out, "service.log"), service.logs.join(""));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ passed: report.passed, out, error: report.error?.message }));
