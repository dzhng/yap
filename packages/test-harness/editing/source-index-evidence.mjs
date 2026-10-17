import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { JourneyService, hash, poll, root, run } from "./source-evidence-fixture.mjs";
const { values } = parseArgs({ options: { out: { type: "string" } } });
assert.ok(process.env.YAP_NATIVE, "Use a frozen actual native worker");
assert.equal(
  process.env.YAP_TEST_PROBE_OVERRIDES,
  undefined,
  "This journey owns its explicitly labeled probe controls",
);
const out = values.out
  ? resolve(values.out)
  : await mkdtemp(join(tmpdir(), "source-index-evidence-"));
await mkdir(out, { recursive: true });
const home = await mkdtemp(join(tmpdir(), "source-index-public-"));
const fixture = join(root, "specs/done/agent-editing/assets/10d-source-frames/visual");
const report = {
  passed: false,
  scope:
    "Public CLI/MCP source indexes using actual native scene/frame workers; controlled probe admission cases labeled separately",
  trace: [],
  checks: {},
  selections: [],
};
const service = new JourneyService(home, report, join(out, "native"));
const imageOracle = join(home, "image-oracle");
const call = service.call.bind(service);
const originals = new Map();
async function imported(path, requestId) {
  originals.set(path, hash(await readFile(path)));
  const pending = await call("asset.import", { path, requestId });
  await poll(
    () => call("job.get", { jobId: pending.jobId }),
    (j) => j.state === "ready",
    "import",
  );
  return call("asset.get", { assetId: originals.get(path) });
}
async function ready(selection) {
  return poll(
    () => call("index.get", { ...selection, limit: 1 }, { transport: "mcp" }),
    (r) => {
      assert(!["failed", "unavailable"].includes(r.state), JSON.stringify(r));
      return r.state === "ready";
    },
    "source index",
  );
}
async function pages(selection, initial) {
  const rows = [...initial.page.entries];
  let cursor = initial.page.nextCursor;
  while (cursor) {
    const page = await call("index.get", { ...selection, cursor, limit: 1 });
    assert.equal(page.page.metadata.generation, initial.page.metadata.generation);
    rows.push(...page.page.entries);
    cursor = page.page.nextCursor;
  }
  return rows;
}
async function coverage(reference) {
  const rows = [];
  let cursor;
  do {
    const page = await call(
      "index.coverage",
      { ...reference, limit: 1, ...(cursor ? { cursor } : {}) },
      { transport: "mcp" },
    );
    rows.push(...page.coverage);
    cursor = page.nextCursor;
  } while (cursor);
  return rows;
}
async function inspect(selection, name) {
  const page = await ready(selection);
  const reference = { ...selection, generation: page.page.metadata.generation };
  const entries = await pages(selection, page);
  const ranges = await coverage(reference);
  assert.equal(entries.length, page.page.metadata.candidateCount);
  assert.deepEqual(
    entries.map((e) => e.candidate.ordinal),
    entries.map((_, i) => i),
  );
  assert.equal(ranges[0].source.startUs, 0);
  assert.equal(ranges.at(-1).source.endUs, page.page.metadata.durationUs);
  for (let i = 1; i < ranges.length; i++)
    assert.equal(ranges[i].source.startUs, ranges[i - 1].source.endUs);
  for (const entry of entries) {
    assert.equal(entry.frame.assetId, selection.assetId);
    assert.equal(entry.frame.streamId, selection.streamId);
    assert.equal(entry.frame.recordingId, undefined);
    assert.equal(entry.frame.revisionId, undefined);
    assert.equal(entry.frame.acquisitionId, selection.acquisitionId);
    assert.equal(entry.frame.requestedSourceUs, entry.candidate.requestedSourceUs);
    assert.equal(entry.frame.atUs, entry.candidate.requestedSourceUs);
    assert.equal(entry.frame.implementationId, page.page.metadata.implementationId);
    const sample = entry.frame.sample,
      at = BigInt(entry.candidate.requestedSourceUs + sample.originUs);
    assert(BigInt(sample.value) * 1000000n <= at * BigInt(sample.timescale));
    assert(BigInt(sample.endValue) * 1000000n > at * BigInt(sample.endTimescale));
  }
  const record = { name, selection, metadata: page.page.metadata, entries, coverage: ranges };
  report.selections.push(record);
  return { page, reference, entries, ranges, record };
}
async function comparePicture(output, expectedName, name) {
  const actual = join(home, name + ".rgba"),
    expected = join(home, name + "-expected.rgba");
  const reference = join(fixture, `reference-${expectedName}.png`);
  const actualProfile = JSON.parse(
    (await run(imageOracle, [output, actual], { timeout: 30000 })).stdout,
  );
  const expectedProfile = JSON.parse(
    (await run(imageOracle, [reference, expected], { timeout: 30000 })).stdout,
  );
  assert.deepEqual(
    [actualProfile.width, actualProfile.height],
    [expectedProfile.width, expectedProfile.height],
  );
  const actualPixels = await readFile(actual),
    expectedPixels = await readFile(expected);
  assert(
    actualPixels.equals(expectedPixels),
    "Retained index picture differs from independent color-managed source reference",
  );
  return {
    reference,
    rgbaSha256: hash(actualPixels),
    referenceRgbaSha256: hash(expectedPixels),
    actualProfile,
    expectedProfile,
  };
}
function assertShortCoverage(ranges) {
  assert.deepEqual(
    ranges
      .filter((r) => r.state === "unavailable")
      .map((r) => ({ source: r.source, basis: r.basis })),
    [
      { source: { startUs: 0, endUs: 50000 }, basis: "support" },
      { source: { startUs: 100000, endUs: 600000 }, basis: "support" },
    ],
  );
  assert.deepEqual(
    ranges
      .filter((r) => r.source.startUs >= 50000 && r.source.endUs <= 100000)
      .map((r) => ({ source: r.source, ordinal: r.ordinal, state: r.state, equality: r.equality })),
    [
      {
        source: { startUs: 50000, endUs: 99999 },
        ordinal: 0,
        state: "available",
        equality: "unproven",
      },
      {
        source: { startUs: 99999, endUs: 100000 },
        ordinal: 1,
        state: "available",
        equality: "unproven",
      },
    ],
  );
}
function assertEmptyCoverage(ranges, selection, implementationId) {
  assert.deepEqual(
    ranges.map(({ source, ordinal, state, basis, equality, observation }) => ({
      source,
      ordinal,
      state,
      basis,
      ...(equality ? { equality } : {}),
      ...(observation
        ? {
            kind: observation.kind,
            point: observation.kind === "frame" ? observation.frame.observation : observation.point,
          }
        : {}),
    })),
    [
      {
        source: { startUs: 0, endUs: 450000 },
        ordinal: null,
        state: "unavailable",
        basis: "support",
      },
      {
        source: { startUs: 450000, endUs: 499999 },
        ordinal: null,
        state: "unavailable",
        basis: "observation",
        equality: "unproven",
        kind: "frame",
        point: { requestedSourceUs: 450000, status: "unavailable", reason: "empty_edit" },
      },
      {
        source: { startUs: 499999, endUs: 500000 },
        ordinal: null,
        state: "unavailable",
        basis: "observation",
        equality: "unproven",
        kind: "scene",
        point: {
          requestedSourceUs: 499999,
          status: "unavailable",
          reason: "empty_edit",
          continuousFromPrevious: false,
        },
      },
    ],
  );
  const frame = ranges[1].observation.frame;
  assert.deepEqual(frame.selection, selection);
  assert.equal(frame.atUs, 450000);
  assert.equal(frame.implementationId, implementationId);
  assert.match(frame.supportDigest, /^[a-f0-9]{64}$/);
}
async function image(reference, ordinal, name, expectedName) {
  const output = join(out, `${name}.png`);
  const cli = await call("index.frame", { ...reference, ordinal }, { output });
  const reply = await service.mcp.callTool({
    name: "index.frame",
    arguments: { ...reference, ordinal },
  });
  assert.equal(reply.structuredContent.ok, true, JSON.stringify(reply));
  const content = reply.content.filter((c) => c.type === "image");
  assert.equal(content.length, 1);
  const bytes = await readFile(output);
  assert(bytes.equals(Buffer.from(content[0].data, "base64")));
  assert.equal(bytes.subarray(1, 4).toString(), "PNG");
  const pixelOracle = expectedName ? await comparePicture(output, expectedName, name) : undefined;
  return { output, sha256: hash(bytes), receipt: cli, ...(pixelOracle ? { pixelOracle } : {}) };
}
try {
  await run(
    "swiftc",
    [
      "-parse-as-library",
      join(root, "packages/test-harness/editing/SourceIndexFixture.swift"),
      "-o",
      join(home, "fixture"),
    ],
    { timeout: 30000 },
  );
  const islandFile = join(home, "island.mov");
  await run(join(home, "fixture"), [join(fixture, "first.mov"), islandFile], { timeout: 30000 });
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
  const asset = await imported(join(fixture, "source.mov"), "source-index");
  const videos = asset.streams.filter((s) => s.kind === "video");
  assert.equal(videos.length, 2);
  const first = { assetId: asset.id, streamId: videos[0].id },
    second = { assetId: asset.id, streamId: videos[1].id };
  const hit = await service.arm("media.sourceVisualSamples");
  const preparing = await call("index.get", first, { transport: "mcp" });
  assert.equal(preparing.page, null);
  assert.equal(preparing.jobId, null);
  const dependency = preparing.dependencies.find((d) => d.artifact === "source-scenes");
  assert.ok(dependency.jobId);
  await hit();
  await call("job.cancel", { jobId: dependency.jobId }, { transport: "mcp" });
  const canceled = await poll(
    () => call("index.get", first),
    (v) => v.reason === "canceled",
    "scene cancellation",
  );
  assert.equal(canceled.state, "idle");
  assert.equal(canceled.retryable, true);
  assert.equal((await call("index.get", first)).dependencies[0].jobId, dependency.jobId);
  await call("job.retry", { jobId: dependency.jobId }, { transport: "mcp" });
  const selected = await inspect(first, "native-first");
  report.checks.canceledSceneRetry = true;
  assert.deepEqual(
    selected.ranges
      .filter((r) => r.state === "unavailable")
      .map((r) => ({ source: r.source, basis: r.basis })),
    [{ source: { startUs: 400000, endUs: 600000 }, basis: "support" }],
  );
  const picture = await image(selected.reference, 0, "first-cli-mcp", "first");
  selected.record.picture = picture;
  const changingFile = join(home, "changing.mov");
  await run(
    join(home, "fixture"),
    [join(fixture, "first.mov"), changingFile, join(fixture, "second.mov")],
    { timeout: 30000 },
  );
  const changingAsset = await imported(changingFile, "changing-pictures");
  const changingSelected = await inspect(
    {
      assetId: changingAsset.id,
      streamId: changingAsset.streams.find((s) => s.kind === "video").id,
    },
    "native-temporal-pictures",
  );
  assert.deepEqual(
    changingSelected.entries.map((e) => e.candidate.requestedSourceUs),
    [0, 399999, 600000, 999999],
  );
  const ordinals = [0, 999999, 0, changingSelected.entries.length - 1];
  const batch = await call(
    "index.frames",
    { ...changingSelected.reference, ordinals },
    { output: join(out, "batch") },
  );
  assert.deepEqual(
    batch.items.map((x) => x.ordinal),
    ordinals,
  );
  assert.equal(batch.items[1].ok, false);
  for (const i of [0, 2, 3]) assert.equal(batch.items[i].ok, true);
  const mcpBatch = await service.mcp.callTool({
    name: "index.frames",
    arguments: { ...changingSelected.reference, ordinals },
  });
  assert.equal(mcpBatch.structuredContent.ok, true);
  assert.equal(mcpBatch.content.filter((c) => c.type === "image").length, 3);
  for (const i of [0, 2, 3]) {
    const item = mcpBatch.structuredContent.data.items[i];
    const content = mcpBatch.content[item.data.contentIndex];
    assert.equal(content.type, "image");
    assert(Buffer.from(content.data, "base64").equals(await readFile(batch.items[i].data.output)));
    assert.equal(item.data.candidate.ordinal, ordinals[i]);
  }
  const verifyBatch = async (items, label) => {
    const hashes = [];
    for (const i of [0, 2, 3])
      hashes.push(
        (await comparePicture(items[i].data.output, i === 3 ? "second" : "first", `${label}-${i}`))
          .rgbaSha256,
      );
    assert.notEqual(hashes[0], hashes[2]);
    return hashes;
  };
  report.batchOracle = await verifyBatch(batch.items, "batch-correct");
  const duplicated = structuredClone(batch.items);
  duplicated[3].data.output = duplicated[0].data.output;
  await assert.rejects(
    () => verifyBatch(duplicated, "batch-duplicated"),
    /differs from independent/,
  );
  const swapped = structuredClone(batch.items);
  [swapped[0].data.output, swapped[3].data.output] = [
    swapped[3].data.output,
    swapped[0].data.output,
  ];
  await assert.rejects(() => verifyBatch(swapped, "batch-swapped"), /differs from independent/);
  report.negativeControls = { duplicateBatchImageRejected: true, swappedBatchImagesRejected: true };
  report.checks.batchErrors = true;
  const coveragePage = await call("index.coverage", { ...selected.reference, limit: 1 });
  assert(coveragePage.nextCursor);
  assert.equal(
    (
      await call(
        "index.coverage",
        { ...selected.reference, candidateOrdinal: 0, cursor: coveragePage.nextCursor },
        { error: true },
      )
    ).code,
    "ARTIFACT_CHANGED",
  );
  const filtered = await call("index.coverage", {
    ...selected.reference,
    candidateOrdinal: 0,
    limit: 200,
  });
  assert.equal(filtered.coverage.length, selected.entries[0].coverageCount);
  assert(filtered.coverage.every((c) => c.ordinal === 0));
  report.checks.coverageFilterBinding = true;
  const wrong = await call(
    "index.get",
    { ...second, cursor: selected.page.page.nextCursor },
    { error: true },
  );
  assert.equal(wrong.code, "ARTIFACT_CHANGED");
  const frameHit = await service.arm("media.sourceFrame");
  const secondPending = await poll(
    () => call("index.get", second, { transport: "mcp" }),
    (v) => !!v.jobId,
    "second index admission",
  );
  await frameHit();
  const child = await call("frame.get", { ...second, atUs: 0 }, { transport: "mcp" });
  await call("job.cancel", { jobId: child.jobId });
  const failed = await poll(
    () => call("job.get", { jobId: secondPending.jobId }),
    (v) => v.state === "failed",
    "frame dependency failure",
  );
  assert.equal(failed.retryable, true);
  assert.equal(failed.errorDetails.dependency.jobId, child.jobId);
  assert.equal((await call("index.get", second)).state, "failed");
  await call("job.retry", { jobId: secondPending.jobId }, { transport: "mcp" });
  const selectedSecond = await inspect(second, "native-second");
  selectedSecond.record.picture = await image(
    selectedSecond.reference,
    0,
    "second-cli-mcp",
    "second",
  );
  report.checks.canceledFrameRetry = true;
  const island = await imported(islandFile, "short-physical-island");
  const narrow = {
    assetId: island.id,
    streamId: island.streams.filter((s) => s.kind === "video")[1].id,
  };
  const short = await inspect(narrow, "native-short-island");
  assert(short.entries.some((e) => e.candidate.requestedSourceUs === 50000));
  assert(short.entries.some((e) => e.candidate.requestedSourceUs === 99999));
  assertShortCoverage(short.ranges);
  const falselySampled = structuredClone(short.ranges);
  falselySampled.find((r) => r.source.startUs === 50000).equality = "sampled";
  assert.throws(() => assertShortCoverage(falselySampled));
  report.negativeControls.falselySampledIslandRejected = true;
  const traces = [];
  for (const file of await readdir(join(out, "native")))
    if (file.startsWith("visual-"))
      traces.push(JSON.parse(await readFile(join(out, "native", file), "utf8")));
  const observed = traces.filter(
    (t) =>
      t.request.asset.assetId === narrow.assetId && t.request.asset.streamId === narrow.streamId,
  );
  assert(observed.length > 0);
  assert(
    observed.every((t) =>
      t.response.samples.every((p) => p.requestedSourceUs < 50000 || p.requestedSourceUs >= 100000),
    ),
  );
  report.checks.physicalShortIsland = {
    nativeRequests: observed.map((t) => t.request.atSourceUs),
    selectedRequests: short.entries.map((e) => e.candidate.requestedSourceUs),
  };
  const donor = join(home, "capture-donor");
  await mkdir(donor);
  const donorBuilder = join(home, "donor-builder");
  await run(
    "swiftc",
    [
      "-parse-as-library",
      join(root, "helpers/mac/Tests/SourceFrame/fixture.swift"),
      "-o",
      donorBuilder,
    ],
    { timeout: 30000 },
  );
  await run(donorBuilder, [join(fixture, "first.mov"), join(donor, "video.mov")], {
    timeout: 30000,
  });
  const journal = [
    {
      event: "header",
      data: {
        schemaVersion: 1,
        sessionID: "synthetic-source-index",
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
  ]
    .map((record, i) => JSON.stringify({ ...record, sequence: i + 1 }) + "\n")
    .join("");
  await writeFile(join(donor, "capture.journal.jsonl"), journal);
  const acquisitionPending = await call("acquisition.import", {
    requestId: "index-acquisition",
    path: donor,
  });
  const acquisitionJob = await poll(
    () => call("job.get", { jobId: acquisitionPending.jobId }),
    (v) => v.state === "ready",
    "index acquisition",
  );
  const acquisition = await call("acquisition.get", {
    acquisitionId: acquisitionJob.target.acquisitionId,
  });
  const binding = acquisition.bindings[0];
  const acquiredSelection = {
    assetId: binding.assetId,
    streamId: binding.streamId,
    acquisitionId: acquisition.id,
  };
  const acquired = await inspect(acquiredSelection, "native-acquisition");
  assert(acquired.entries.every((e) => e.frame.acquisitionId === acquisition.id));
  assert.equal(
    (
      await call(
        "index.frame",
        {
          assetId: binding.assetId,
          streamId: binding.streamId,
          generation: acquired.reference.generation,
          ordinal: 0,
        },
        { error: true },
      )
    ).code,
    "ARTIFACT_CHANGED",
  );
  const acquiredImage = await image(acquired.reference, 0, "acquired-before", "first");
  await rm(donor, { recursive: true });
  report.checks.retainedAcquisition = {
    scope: "Synthetic capture journal around real native video",
    acquisitionId: acquisition.id,
    donorRemoved: true,
  };
  const project = await call("project.create", {
    requestId: "index-history",
    canvas: {
      width: 64,
      height: 48,
      fps: { numerator: 10, denominator: 1 },
      background: "#000000ff",
    },
  });
  const projectId = project.project.projectId;
  const edited = await call("edit.apply", {
    projectId,
    requestId: "index-place",
    expectedRevisionId: project.revision.id,
    operations: [
      { operation: "track.add", track: { kind: "video", order: 0 }, label: "picture" },
      {
        operation: "place",
        clip: {
          trackId: { label: "picture" },
          ...first,
          source: { kind: "range", range: { startUs: 0, endUs: 400000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 400000 } },
        },
      },
    ],
  });
  const undone = await call("edit.undo", {
    projectId,
    requestId: "index-undo",
    expectedRevisionId: edited.revision.id,
  });
  await call("edit.restore", {
    projectId,
    requestId: "index-restore",
    expectedRevisionId: undone.id,
    targetRevisionId: edited.revision.id,
  });
  const history = await call("revision.history", { projectId, limit: 1 });
  assert.ok(history);
  assert.equal(
    (await call("index.get", first)).page.metadata.generation,
    selected.reference.generation,
  );
  await call("project.delete", { projectId }, { transport: "mcp" });
  assert.equal((await image(selected.reference, 0, "after-project-delete")).sha256, picture.sha256);
  report.checks.projectHistoryAndDeletionIndependence = true;
  await service.stop();
  const cache = join(home, "library/cache/derived");
  let evicted = 0;
  for (const file of await readdir(cache))
    if (/^[a-f0-9-]+\.cache$/.test(file)) {
      await rm(join(cache, file));
      evicted++;
    }
  assert(evicted > 0);
  report.controlledCacheLoss = {
    scope: "Scratch service stopped; only derived-cache files removed",
    files: evicted,
  };
  originals.delete(islandFile);
  await rm(islandFile);
  report.checks.importedDonorRemoved = true;
  await service.start();
  const resumed = await call("index.get", {
    ...first,
    cursor: selected.page.page.nextCursor,
    limit: 1,
  });
  assert.equal(resumed.page.metadata.generation, selected.reference.generation);
  assert.equal((await image(selected.reference, 0, "restarted")).sha256, picture.sha256);
  report.checks.restart = true;
  assert.equal(
    (await image(acquired.reference, 0, "acquired-after-restart")).sha256,
    acquiredImage.sha256,
  );
  await image(short.reference, 0, "island-after-donor-removal");
  await service.stop();
  const base = await readFile(join(fixture, "source.mov"));
  const controlled = [];
  for (const [name, startUs, endUs, empty] of [
    ["declared-empty-support", 0, 1000000, true],
    ["declared-empty-edit", 450000, 500000, false],
  ]) {
    const tag = Buffer.from(name),
      atom = Buffer.alloc(8 + tag.length);
    atom.writeUInt32BE(atom.length);
    atom.write("free", 4);
    tag.copy(atom, 8);
    const path = join(home, name + ".mov");
    await writeFile(path, Buffer.concat([base, atom]));
    controlled.push({
      name,
      path,
      sha256: hash(await readFile(path)),
      streamId: first.streamId,
      startUs,
      endUs,
      segments: [{ startUs, endUs, empty }],
    });
  }
  const overrides = join(out, "controlled-probe-overrides.json");
  await writeFile(overrides, JSON.stringify(controlled, null, 2));
  process.env.YAP_TEST_PROBE_OVERRIDES = overrides;
  await service.start();
  report.controlledProbeAdmission = [];
  for (const control of controlled) {
    const asset = await imported(control.path, control.name);
    const selection = { assetId: asset.id, streamId: control.streamId };
    assert.deepEqual(service.barriers.get(control.sha256 + "/fixture.probe").override, control);
    if (control.name === "declared-empty-support") {
      const result = await call("index.get", selection, { transport: "mcp" });
      assert.equal(result.state, "unavailable");
      assert.equal(result.reason, "no_video");
      assert.equal(result.page, null);
      report.controlledProbeAdmission.push({
        name: control.name,
        selection,
        scope: "Native decoding with controlled declared probe support",
        result,
      });
    } else {
      const empty = await inspect(selection, "controlled-ready-empty");
      assert.equal(empty.entries.length, 0);
      assert.equal(empty.page.state, "ready");
      assertEmptyCoverage(empty.ranges, selection, empty.page.page.metadata.implementationId);
      const sampledEmpty = structuredClone(empty.ranges);
      sampledEmpty[1].equality = "sampled";
      assert.throws(() =>
        assertEmptyCoverage(sampledEmpty, selection, empty.page.page.metadata.implementationId),
      );
      const missingObservation = structuredClone(empty.ranges);
      delete missingObservation[1].observation;
      assert.throws(() =>
        assertEmptyCoverage(
          missingObservation,
          selection,
          empty.page.page.metadata.implementationId,
        ),
      );
      report.negativeControls.falselySampledEmptyRejected = true;
      report.negativeControls.missingEmptyObservationRejected = true;
      const missing = await call(
        "index.frame",
        { ...empty.reference, ordinal: 0 },
        { error: true },
      );
      assert.equal(missing.code, "NOT_FOUND");
      const batch = await service.mcp.callTool({
        name: "index.frames",
        arguments: { ...empty.reference, ordinals: [0] },
      });
      assert.equal(batch.structuredContent.ok, true);
      assert.equal(batch.structuredContent.data.items[0].ok, false);
      assert.equal(batch.content.filter((c) => c.type === "image").length, 0);
      report.controlledProbeAdmission.push({
        name: control.name,
        selection,
        scope: "Native scene/frame outcomes with controlled declared probe support",
        generation: empty.reference.generation,
      });
    }
  }
  for (const [path, digest] of originals) assert.equal(hash(await readFile(path)), digest);
  report.passed = true;
} finally {
  try {
    await service.stop();
  } finally {
    delete process.env.YAP_TEST_PROBE_OVERRIDES;
    try {
      report.logs = service.logs;
      await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2) + "\n");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
}
console.log(JSON.stringify({ passed: report.passed, out, checks: report.checks }));
