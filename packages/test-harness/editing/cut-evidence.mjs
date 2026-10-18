import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { JourneyService, root, hash, poll } from "./source-evidence-fixture.mjs";
const { values } = parseArgs({ options: { out: { type: "string" } } });
assert.ok(process.env.YAP_NATIVE, "Set an isolated frozen native worker");
const out = values.out ? resolve(values.out) : await mkdtemp(join(tmpdir(), "cut-evidence-"));
const home = await mkdtemp(join(tmpdir(), "sr-cut-evidence-"));
await mkdir(out, { recursive: true });
const report = { passed: false, checks: {}, trace: [] };
const service = new JourneyService(home, report);
const call = service.call.bind(service);
const range = (startUs, endUs) => ({ startUs, endUs });
const save = (name, value) => writeFile(join(out, name), JSON.stringify(value, null, 2) + "\n");
async function pages(params, limit = 1) {
  let result = await poll(
    () => call("timeline.events", { ...params, limit }),
    (v) => v.state === "ready",
    "project events",
  );
  const first = result,
    rows = [],
    seen = new Set();
  for (let i = 0; i < 100; i++) {
    rows.push(...result.page.rows);
    if (!result.page.nextCursor) return { first, rows };
    const key = JSON.stringify(result.page.nextCursor);
    assert.ok(!seen.has(key), "Continuation advances");
    seen.add(key);
    result = await call(
      "timeline.events",
      { ...params, limit, cursor: result.page.nextCursor },
      { transport: i % 2 ? "cli" : "mcp" },
    );
    assert.equal(result.state, "ready");
  }
  throw Error("Continuation did not terminate");
}
try {
  await service.start();
  const media = join(root, "specs/done/agent-editing/assets/10d-public-scenes/authored-source.mov");
  const assetId = hash(await readFile(media));
  const imported = await call("asset.import", { requestId: "cut-source", path: media });
  await poll(
    () => call("job.get", { jobId: imported.jobId }),
    (v) => v.state === "ready",
    "import",
  );
  const asset = await call("asset.get", { assetId });
  const streamId = asset.streams.find((s) => s.kind === "video").streamId;
  const project = await call("project.create", {
    requestId: "cut-project",
    canvas: {
      width: 64,
      height: 48,
      fps: { numerator: 10, denominator: 1 },
      background: "#000000ff",
    },
  });
  const place = (label, track, start, end, from = start, to = end, kind = "range") => ({
    operation: "place",
    label,
    clip: {
      trackId: { label: track },
      ...(kind === "silence" ? {} : { assetId, streamId }),
      source:
        kind === "silence"
          ? { kind }
          : kind === "hold"
            ? { kind, atUs: from }
            : { kind, range: range(from, to) },
      placement: { kind: "project", range: range(start, end) },
    },
  });
  const edited = await call("edit.apply", {
    projectId: project.project.projectId,
    requestId: "cut-placements",
    expectedRevisionId: project.revision.revisionId,
    operations: [
      { operation: "track.add", label: "video", track: { kind: "video", order: 0 } },
      { operation: "track.add", label: "overlay", track: { kind: "video", order: 1 } },
      { operation: "track.add", label: "audio", track: { kind: "audio", order: 0 } },
      { operation: "track.add", label: "speed", track: { kind: "video", order: 3 } },
      place("speed-fast", "speed", 0, 500000, 0, 1000000),
      place("speed-normal", "speed", 500000, 2000000, 1000000, 2500000),
      place("a", "video", 0, 400000),
      place("b", "video", 400000, 600000, 1800000, 2000000),
      place("c", "video", 600000, 1200000),
      place("gap-seam", "video", 1200000, 1400000, 1100000, 1300000),
      place("d", "video", 1600000, 2500000),
      place("over", "overlay", 200000, 800000, 0, 600000),
      place("hold-left", "overlay", 900000, 1000000, 0, 0, "hold"),
      place("hold-right", "overlay", 1000000, 1100000, 0, 0, "hold"),
      place("silence-left", "audio", 0, 500000, 0, 0, "silence"),
      place("silence-right", "audio", 500000, 1500000, 0, 0, "silence"),
      place("silence-again", "audio", 1700000, 2500000, 0, 0, "silence"),
    ],
  });
  const query = { projectId: project.project.projectId, revisionId: edited.revision.revisionId };
  const labels = edited.edit.labels,
    names = Object.fromEntries(Object.entries(labels).map(([k, v]) => [v, k]));
  const summarize = (rows) =>
    rows
      .filter((r) => r.kind === "cut")
      .map((r) => [
        r.projectAtUs,
        names[r.trackId],
        r.mediaKind,
        names[r.before?.clipId] ?? null,
        names[r.after?.clipId] ?? null,
      ]);
  const expected = [
    [200000, "overlay", "video", null, "over"],
    [400000, "video", "video", "a", "b"],
    [500000, "speed", "video", "speed-fast", "speed-normal"],
    [600000, "video", "video", "b", "c"],
    [800000, "overlay", "video", "over", null],
    [900000, "overlay", "video", null, "hold-left"],
    [1100000, "overlay", "video", "hold-right", null],
    [1200000, "video", "video", "c", "gap-seam"],
    [1400000, "video", "video", "gap-seam", null],
    [1500000, "audio", "audio", "silence-right", null],
    [1600000, "video", "video", null, "d"],
    [1700000, "audio", "audio", null, "silence-again"],
    [2000000, "speed", "video", "speed-normal", null],
  ];
  const one = await pages(query);
  assert.deepEqual(summarize(one.rows), expected);
  assert.deepEqual(one.first.coverage.cuts, { state: "ready", basis: "revision" });
  for (const row of one.rows.filter((r) => r.kind === "cut")) {
    for (const key of ["sourceAtUs", "generation", "sourceSequence", "captureAtUs"])
      assert.ok(!(key in row));
  }
  for (const limit of [2, 500]) assert.deepEqual((await pages(query, limit)).rows, one.rows);
  assert.deepEqual(
    summarize(
      (await pages({ ...query, trackIds: [labels.video], range: range(400000, 600000) })).rows,
    ),
    [expected[1]],
  );
  assert.deepEqual(summarize((await pages({ ...query, range: range(600001, 799999) })).rows), []);
  assert.deepEqual(
    summarize((await pages({ ...query, trackIds: [labels.audio] })).rows),
    expected.filter((row) => row[1] === "audio"),
  );
  // Splitting a non-unit-rate occurrence requires an exact fractional source boundary.
  const retimed = await call("edit.apply", {
    projectId: query.projectId,
    requestId: "cut-retime",
    expectedRevisionId: query.revisionId,
    operations: [
      { operation: "retime", clipIds: [labels.over], durationUs: 600001, ripple: "none" },
      { operation: "track.add", label: "fractional", track: { kind: "video", order: 2 } },
      {
        operation: "place",
        label: "fractional-hold",
        clip: {
          assetId,
          streamId,
          trackId: { label: "fractional" },
          source: { kind: "hold", atUs: 0 },
          placement: {
            kind: "clip",
            clipId: labels.over,
            start: { numerator: 1, denominator: 3 },
            end: { numerator: 2, denominator: 3 },
          },
        },
      },
    ],
  });
  const beforeSplit = await pages({
    projectId: query.projectId,
    revisionId: retimed.revision.revisionId,
  });
  assert.deepEqual(
    beforeSplit.rows
      .filter((r) => r.kind === "cut" && r.trackId === retimed.edit.labels.fractional)
      .map((r) => r.projectAtUs),
    [
      { numerator: 1200001, denominator: 3 },
      { numerator: 1800002, denominator: 3 },
    ],
  );
  const split = await call("edit.apply", {
    projectId: query.projectId,
    requestId: "cut-split",
    expectedRevisionId: retimed.revision.revisionId,
    operations: [{ operation: "split", clipIds: [labels.over], atUs: 333333 }],
  });
  const afterSplit = await pages({
    projectId: query.projectId,
    revisionId: split.revision.revisionId,
  });
  assert.deepEqual(
    afterSplit.rows.filter((r) => r.kind === "cut").map((r) => [r.projectAtUs, r.trackId]),
    beforeSplit.rows.filter((r) => r.kind === "cut").map((r) => [r.projectAtUs, r.trackId]),
  );
  await service.stop();
  await service.start();
  const resumed = await call(
    "timeline.events",
    { projectId: query.projectId, cursor: one.first.page.nextCursor, limit: 500 },
    { transport: "mcp" },
  );
  assert.equal(resumed.revisionId, query.revisionId);
  assert.deepEqual([...one.first.page.rows, ...resumed.page.rows], one.rows);
  await save("project.json", { expected, one, beforeSplit, afterSplit, resumed });
  report.checks = {
    replacement: true,
    rateTransition: true,
    separatePlanes: true,
    overlayEdges: true,
    holdsAndSilence: true,
    physicalGaps: true,
    pureFractionalSplit: true,
    fractionalProjectBoundaries: true,
    queryOwnership: true,
    pageSizes: [1, 2, 500],
    historicalRestart: true,
  };
  report.nativeSha256 = hash(await readFile(process.env.YAP_NATIVE));
  report.runtime = Object.fromEntries(
    await Promise.all(
      [
        "packages/composition/dist/project-cuts.js",
        "packages/core/dist/project-events.js",
        "packages/core/dist/project-evidence.js",
        "packages/protocol/dist/operations.js",
        "apps/service/dist/project-service.js",
        "packages/test-harness/editing/cut-evidence.mjs",
      ].map(async (p) => [p, hash(await readFile(join(root, p)))]),
    ),
  );
  report.passed = true;
} catch (error) {
  report.error = { message: error.message, stack: error.stack };
  throw error;
} finally {
  await service.stop();
  await save("report.json", report);
  await writeFile(join(out, "service.log"), service.logs.join(""));
  await rm(home, { recursive: true, force: true });
}
console.log(JSON.stringify({ out, passed: report.passed }));
