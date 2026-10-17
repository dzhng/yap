import assert from "node:assert/strict";
import { changedSceneGeneration } from "./generation-evidence.mjs";
import { mkdir, mkdtemp, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { JourneyService, root, run, hash, poll } from "./source-evidence-fixture.mjs";

const { values } = parseArgs({ options: { out: { type: "string" } } });
assert.ok(process.env.YAP_NATIVE, "Set a frozen native worker");
const out = values.out ? resolve(values.out) : await mkdtemp(join(tmpdir(), "scene-evidence-"));
await mkdir(out, { recursive: true });
const home = await mkdtemp(join(tmpdir(), "sr-scene-evidence-"));
const report = { passed: false, checks: {}, trace: [] };
const service = new JourneyService(home, report);
const call = service.call.bind(service);
const save = (name, value) => writeFile(join(out, name), JSON.stringify(value, null, 2) + "\n");
const sceneTimes = [400000, 800000, 1800000, 2200000];
const mixedExpected = [
  { kind: "pause", sourceAtUs: 400000 },
  ...sceneTimes.map((sourceAtUs) => ({ kind: "scene", sourceAtUs })),
  { kind: "interruption", sourceAtUs: 2500000 },
];
async function pages(params, limit = 1) {
  let result = await poll(
    () => call("timeline.events", { ...params, limit }),
    (value) => value.state === "ready",
    "scene preparation",
  );
  const first = result,
    rows = [],
    seen = new Set();
  for (let i = 0; ; i++) {
    assert.ok(i < 100, "Event continuation must terminate");
    rows.push(...result.page.rows);
    if (!result.page.nextCursor) return { first, rows };
    const key = JSON.stringify(result.page.nextCursor);
    assert.ok(!seen.has(key));
    seen.add(key);
    result = await call(
      "timeline.events",
      { ...params, limit, cursor: result.page.nextCursor },
      { transport: i % 2 ? "cli" : "mcp" },
    );
    assert.equal(result.state, "ready");
  }
}
function checkScenes(rows, expected) {
  assert.deepEqual(
    rows.filter((r) => r.kind === "scene").map((r) => r.sourceAtUs),
    expected,
  );
  for (const row of rows.filter((r) => r.kind === "scene")) {
    const sample = row.observation.sample;
    assert.equal(sample.originUs, 250000);
    assert.equal(
      BigInt(sample.value) * 1000000n,
      BigInt(row.sourceAtUs + 250000) * BigInt(sample.timescale),
    );
    assert.equal(
      BigInt(sample.endValue) * 1000000n,
      BigInt(row.sourceAtUs + 250000 + 100000) * BigInt(sample.endTimescale),
    );
  }
}
try {
  // Authored frame colors and timing are the oracle, independent of the scene detector.
  const raw = Buffer.concat(
    Array.from({ length: 20 }, (_, frame) =>
      Buffer.alloc(64 * 48 * 3, frame < 4 || (frame >= 8 && frame < 13) || frame >= 17 ? 0 : 255),
    ),
  );
  const rawPath = join(home, "authored.rgb"),
    input = join(home, "authored.mov");
  await writeFile(rawPath, raw);
  await run("ffmpeg", [
    "-v",
    "error",
    "-nostdin",
    "-f",
    "rawvideo",
    "-pixel_format",
    "rgb24",
    "-video_size",
    "64x48",
    "-framerate",
    "10",
    "-i",
    rawPath,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    input,
  ]);
  const donor = join(home, "donor");
  await mkdir(donor);
  const media = join(donor, "video.mov");
  const fixture = join(home, "capture-fixture");
  await run(
    "swiftc",
    [
      "-parse-as-library",
      join(root, "packages/test-harness/editing/capture-video-fixture.swift"),
      "-o",
      fixture,
    ],
    { timeout: 120000 },
  );
  await run(fixture, [input, media]);
  const originalHash = hash(await readFile(media));
  await copyFile(media, join(out, "authored-source.mov"));
  const journal = [
    {
      event: "header",
      data: {
        schemaVersion: 1,
        sessionID: "authored-scenes",
        source: { kind: "window", windowID: 7 },
        width: 64,
        height: 48,
        microphone: false,
        systemAudio: false,
      },
    },
    { event: "origin", data: { hostUs: 1000000 } },
    { event: "pausePlaced", data: { atSourceUs: 650000, elapsedPauseUs: 17 } },
    {
      event: "finished",
      data: {
        state: "interrupted",
        durationUs: 2750000,
        failure: { code: "DEVICE_LOST", message: "Authored fixture" },
      },
    },
    { event: "lifecycle", data: { state: "interrupted" } },
  ].map((row, i) => ({ ...row, sequence: i + 1 }));
  await writeFile(
    join(donor, "capture.journal.jsonl"),
    journal.map(JSON.stringify).join("\n") + "\n",
  );
  await save("journal.json", journal);
  await service.start();
  const imported = await call("asset.import", { requestId: "scene-source", path: media });
  await poll(
    () => call("job.get", { jobId: imported.jobId }),
    (v) => v.state === "ready",
    "import",
  );
  const asset = await call("asset.get", { assetId: originalHash });
  const selection = {
    assetId: originalHash,
    streamId: asset.streams.find((s) => s.kind === "video").id,
  };
  assert.ok(selection.streamId);
  const barrier = await service.arm("media.sourceVisualSamples");
  const pending = await call("timeline.events", selection);
  assert.equal(pending.state, "queued");
  assert.equal(pending.page, null);
  await barrier();
  const sceneJobId = pending.context.scene.jobId;
  await call("job.cancel", { jobId: sceneJobId });
  await poll(
    () => call("job.get", { jobId: sceneJobId }),
    (v) => v.state === "canceled",
    "cancel scenes",
  );
  const canceledJob = await call("job.get", { jobId: sceneJobId });
  for (let i = 0; i < 2; i++) {
    const canceled = await call("timeline.events", selection);
    assert.equal(canceled.context.scene.state, "idle");
    assert.equal(canceled.context.scene.reason, "canceled");
    assert.equal(canceled.context.scene.retryable, true);
    assert.equal(canceled.context.scene.jobId, sceneJobId);
    assert.deepEqual(await call("job.get", { jobId: sceneJobId }), canceledJob);
  }
  await call("job.retry", { jobId: sceneJobId });
  const source = await pages(selection);
  checkScenes(source.rows, sceneTimes);
  assert.ok(source.first.context.coverage.some((c) => c.kind === "scene" && c.state === "ready"));
  assert.deepEqual(
    await call("timeline.events", selection),
    await call("timeline.events", selection, { transport: "mcp" }),
  );
  assert.deepEqual(
    (await pages({ ...selection, sourceRange: { startUs: 1000000, endUs: 1500000 } })).rows,
    [],
  );
  const acquired = await call("acquisition.import", {
    requestId: "scene-acquisition",
    path: donor,
  });
  const acquireJob = await poll(
    () => call("job.get", { jobId: acquired.jobId }),
    (v) => v.state === "ready",
    "acquisition",
  );
  const acquisition = await call("acquisition.get", {
    acquisitionId: acquireJob.target.acquisitionId,
  });
  const bound = { ...selection, acquisitionId: acquisition.id };
  await rm(donor, { recursive: true });
  const mixed = await pages(bound);
  checkScenes(mixed.rows, sceneTimes);
  assert.deepEqual(
    mixed.rows.map(({ kind, sourceAtUs }) => ({ kind, sourceAtUs })),
    mixedExpected,
  );
  assert.deepEqual(
    mixed.rows.filter((r) => r.kind !== "scene").map((r) => [r.kind, r.sourceAtUs, r.captureAtUs]),
    [
      ["pause", 400000, 650000],
      ["interruption", 2500000, 2750000],
    ],
  );
  const project = await call("project.create", {
    requestId: "scene-project",
    canvas: {
      width: 64,
      height: 48,
      fps: { numerator: 10, denominator: 1 },
      background: "#000000ff",
    },
  });
  const plans = [
    { label: "first", start: 0, duration: 2500000 },
    { label: "repeat", start: 3000000, duration: 3750000 },
  ];
  const edited = await call("edit.apply", {
    projectId: project.project.projectId,
    requestId: "scene-placements",
    expectedRevisionId: project.revision.id,
    operations: [
      { operation: "track.add", label: "video", track: { kind: "video", order: 0 } },
      ...plans.map((p) => ({
        operation: "place",
        label: p.label,
        clip: {
          ...bound,
          trackId: { label: "video" },
          source: { kind: "range", range: { startUs: 0, endUs: 2500000 } },
          placement: { kind: "project", range: { startUs: p.start, endUs: p.start + p.duration } },
        },
      })),
    ],
  });
  const query = { projectId: project.project.projectId, revisionId: edited.revision.id };
  const projected = await pages(query);
  const actual = projected.rows
    .filter((r) => r.kind !== "cut")
    .map((r) => ({
      kind: r.kind,
      sourceAtUs: r.sourceAtUs,
      projectAtUs: r.projectAtUs,
      clipId: r.clipId,
    }));
  const expected = plans.flatMap((p) =>
    mixedExpected.map((r) => ({
      kind: r.kind,
      sourceAtUs: r.sourceAtUs,
      projectAtUs: p.start + (r.sourceAtUs * p.duration) / 2500000,
      clipId: edited.edit.labels[p.label],
    })),
  );
  assert.deepEqual(actual, expected);
  assert.deepEqual(
    projected.rows
      .filter((r) => r.kind === "cut")
      .map((r) => [r.projectAtUs, r.before?.clipId ?? null, r.after?.clipId ?? null]),
    [
      [2500000, edited.edit.labels.first, null],
      [3000000, null, edited.edit.labels.repeat],
    ],
  );
  for (const limit of [2, 500]) assert.deepEqual((await pages(query, limit)).rows, projected.rows);
  const first = projected.first;
  await call("edit.apply", {
    projectId: query.projectId,
    requestId: "new-head",
    expectedRevisionId: query.revisionId,
    operations: [{ operation: "track.add", label: "unused", track: { kind: "video", order: 1 } }],
  });
  await service.stop();
  await service.start();
  const resumed = await call(
    "timeline.events",
    { projectId: query.projectId, cursor: first.page.nextCursor, limit: 500 },
    { transport: "mcp" },
  );
  assert.equal(resumed.revisionId, query.revisionId);
  assert.deepEqual([...first.page.rows, ...resumed.page.rows], projected.rows);
  checkScenes((await pages(bound)).rows, sceneTimes);
  assert.equal(hash(await readFile(join(out, "authored-source.mov"))), originalHash);
  await save("source.json", source);
  await save("mixed.json", mixed);
  await save("project.json", { expected, projected, resumed });
  report.checks = {
    authoredBoundaryTimes: sceneTimes,
    exactPhysicalClocks: true,
    physicalGap: true,
    mixedCapture: true,
    repeatedRetimedOccurrences: true,
    pageOneBothTransports: true,
    historyRestart: true,
    donorDeletion: true,
    sceneCancelRetry: true,
  };
  const generation = await changedSceneGeneration({
    service,
    query,
    selected: bound,
    baseline: projected,
    source: mixed,
    pages,
  });
  await save("generation.json", generation);
  report.checks.changedGeneration = {
    publicConsumerRefusal: true,
    actualNativePublication: true,
    simulatedReleaseIdentity: true,
    unchangedCutsAndRevision: true,
    readyRetryNoOp: true,
  };
  report.nativeSha256 = hash(await readFile(process.env.YAP_NATIVE));
  report.runtime = Object.fromEntries(
    await Promise.all(
      [
        "apps/service/dist/project-service.js",
        "packages/core/dist/source-events.js",
        "packages/core/dist/scene-source-read.js",
        "packages/core/dist/project-events.js",
        "packages/protocol/dist/operations.js",
        "packages/test-harness/editing/scene-evidence.mjs",
        "packages/test-harness/editing/generation-evidence.mjs",
        "packages/test-harness/editing/generation-scene-service.mjs",
      ].map(async (p) => [p, hash(await readFile(join(root, p)))]),
    ),
  );
  assert.deepEqual(source.first.available, [
    { startUs: 0, endUs: 1000000 },
    { startUs: 1500000, endUs: 2500000 },
  ]);
  report.passed = true;
} catch (error) {
  report.error = { message: error.message, stack: error.stack };
  throw error;
} finally {
  await service.stop().catch((e) => {
    report.passed = false;
    report.shutdownError = e.message;
  });
  try {
    await save("report.json", report);
    await writeFile(join(out, "service.log"), service.logs.join(""));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ out, passed: report.passed }));
if (!report.passed) process.exitCode = 1;
