import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { captureFixtures } from "./capture-evidence-fixture.mjs";
import { JourneyService, root, hash, poll } from "./source-evidence-fixture.mjs";

const { values } = parseArgs({ options: { out: { type: "string" } } });
assert.ok(process.env.YAP_NATIVE, "Set an isolated frozen native worker");
const out = values.out ? resolve(values.out) : await mkdtemp(join(tmpdir(), "capture-evidence-"));
const home = await mkdtemp(join(tmpdir(), "sr-capture-evidence-"));
await mkdir(out, { recursive: true });
const readsFile = join(out, "source-point-reads.jsonl");
await writeFile(readsFile, "");
const report = {
  passed: false,
  boundary:
    "Actual CLI/MCP, acquisition import, native media probing and journal normalization. Synthetic journals are explicitly labeled; no live capture or database seeding.",
  checks: {},
  trace: [],
  pending: [],
};
const service = new JourneyService(
  home,
  report,
  readsFile,
  new URL("./capture-evidence-service.mjs", import.meta.url),
);
const call = service.call.bind(service);
const save = (name, value) => writeFile(join(out, name), JSON.stringify(value, null, 2) + "\n");
const selected = (context, binding) => ({
  assetId: binding.assetId,
  streamId: binding.streamId,
  acquisitionId: context.id,
});
const fraction = (numerator, denominator) => {
  let a = BigInt(numerator),
    b = BigInt(denominator),
    x = a < 0n ? -a : a,
    y = b;
  while (y) [x, y] = [y, x % y];
  a /= x;
  b /= x;
  return b === 1n ? Number(a) : { numerator: Number(a), denominator: Number(b) };
};
const rational = (value) =>
  typeof value === "number"
    ? [BigInt(value), 1n]
    : [BigInt(value.numerator), BigInt(value.denominator)];
const compare = (a, b) => {
  const [an, ad] = rational(a),
    [bn, bd] = rational(b);
  return an * bd < bn * ad ? -1 : an * bd > bn * ad ? 1 : 0;
};
const sourceRows = (fixture, binding, domain, range) => {
  const rows = fixture.normalized.flatMap((record, index) => {
    const kind = { cursorSample: "cursor", geometry: "geometry", pause: "pause" }[record.event];
    if (
      !kind ||
      (domain === "cursor") !== (kind === "cursor") ||
      (kind === "geometry" && !binding.sourceRoles.includes("video"))
    )
      return [];
    const captureAtUs = record.data.sourceUs ?? record.data.atSourceUs;
    if (captureAtUs === undefined || captureAtUs === null) return [];
    const sourceAtUs = captureAtUs + binding.sourceToAssetOffsetUs;
    if (
      sourceAtUs < range.startUs ||
      sourceAtUs >= range.endUs ||
      !binding.available.some((span) => span.startUs <= sourceAtUs && sourceAtUs < span.endUs)
    )
      return [];
    return [{ kind, sourceAtUs, captureAtUs, sourceSequence: index + 1, observation: record.data }];
  });
  const marker = fixture.interruption?.marker;
  if (domain === "events" && marker) {
    const sourceAtUs = marker.durationUs + binding.sourceToAssetOffsetUs;
    if (
      range.startUs < sourceAtUs &&
      sourceAtUs <= range.endUs &&
      binding.available.some((span) => span.startUs < sourceAtUs && sourceAtUs <= span.endUs)
    ) {
      rows.push({
        kind: "interruption",
        sourceAtUs,
        captureAtUs: marker.durationUs,
        sourceSequence: marker.sequence,
        observation: {
          state: marker.state,
          durationUs: marker.durationUs,
          ...(marker.failureCode ? { failureCode: marker.failureCode } : {}),
          ...(marker.failureMessage ? { failureMessage: marker.failureMessage } : {}),
        },
      });
    }
  }
  return rows.sort(
    (a, b) =>
      a.sourceAtUs - b.sourceAtUs ||
      a.sourceSequence - b.sourceSequence ||
      a.kind.localeCompare(b.kind),
  );
};
const projectRows = (plans, labels, domain) =>
  plans
    .flatMap((plan) => {
      if (!plan.fixture || (domain === "cursor" && plan.track === "audio")) return [];
      return sourceRows(plan.fixture, plan.binding, domain, {
        startUs: plan.from,
        endUs: plan.to,
      }).map((row) => ({
        ...row,
        clipId: labels[plan.label],
        assetId: plan.binding.assetId,
        streamId: plan.binding.streamId,
        acquisitionId: plan.fixture.context.id,
        trackId: labels[plan.track],
        trackRank: plan.rank,
        generation: plan.fixture.context.evidence.generation,
        projectAtUs: fraction(
          BigInt(plan.start) * BigInt(plan.to - plan.from) +
            BigInt(row.sourceAtUs - plan.from) * BigInt(plan.duration),
          plan.to - plan.from,
        ),
      }));
    })
    .sort(
      (a, b) =>
        compare(a.projectAtUs, b.projectAtUs) ||
        a.trackRank - b.trackRank ||
        a.clipId.localeCompare(b.clipId) ||
        a.sourceSequence - b.sourceSequence ||
        a.kind.localeCompare(b.kind),
    );

// Authored transitions are listed by each scenario; this helper only fills public identities.
function authoredCuts(plans, labels, boundaries) {
  const side = (label, after) => {
    if (label === null) return null;
    const p = plans.find((p) => p.label === label);
    return {
      clipId: labels[label],
      kind: "range",
      assetId: p.binding.assetId,
      streamId: p.binding.streamId,
      ...(p.fixture ? { acquisitionId: p.fixture.context.id } : {}),
      sourceAtUs: after ? p.from : p.to,
      rate: fraction(p.to - p.from, p.duration),
    };
  };
  return boundaries.map(([projectAtUs, before, after]) => {
    const p = plans.find((p) => p.label === (after ?? before));
    return {
      kind: "cut",
      projectAtUs,
      trackId: labels[p.track],
      trackRank: p.rank,
      mediaKind: p.track === "audio" ? "audio" : "video",
      before: side(before, false),
      after: side(after, true),
    };
  });
}
const eventCompare = (a, b) =>
  compare(a.projectAtUs, b.projectAtUs) ||
  a.trackRank - b.trackRank ||
  (a.kind === "cut" ? (a.after ?? a.before).clipId : a.clipId).localeCompare(
    b.kind === "cut" ? (b.after ?? b.before).clipId : b.clipId,
  ) ||
  (a.kind === "cut" ? -1 : a.sourceSequence) - (b.kind === "cut" ? -1 : b.sourceSequence) ||
  a.kind.localeCompare(b.kind);

async function pages(operation, params, limit, expectedRevisionId) {
  let result = await poll(
    () => call(operation, { ...params, limit }),
    (value) => value.state === "ready",
    operation,
  );
  const initial = result,
    rows = [],
    seen = new Set();
  for (let n = 0; ; n++) {
    assert.ok(n < 2000, "Capture continuation must terminate");
    if (expectedRevisionId) assert.equal(result.revisionId, expectedRevisionId);
    assert.ok(result.page.rows.length <= limit);
    rows.push(...result.page.rows);
    const cursor = result.page.nextCursor;
    if (!cursor) return { rows, initial };
    const key = JSON.stringify(cursor);
    assert.ok(!seen.has(key), "Capture cursor must advance");
    seen.add(key);
    result = await call(
      operation,
      { ...params, cursor, limit },
      { transport: n % 2 ? "cli" : "mcp" },
    );
    assert.equal(result.state, "ready");
  }
}
try {
  const fixtures = await captureFixtures(home, out);
  assert.equal(fixtures.probe.originUs, 250000);
  const videoStream = fixtures.probe.streams.find((stream) => stream.kind === "video");
  assert.deepEqual(
    videoStream.segments
      .filter((segment) => !segment.empty)
      .map(({ startUs, endUs }) => ({ startUs, endUs })),
    [
      { startUs: 0, endUs: 1000000 },
      { startUs: 1500000, endUs: 2500000 },
    ],
  );
  await service.start();
  for (const fixture of fixtures.contexts) {
    const submitted = await call("acquisition.import", {
      requestId: `capture-${fixture.name}`,
      path: fixture.directory,
    });
    const job = await poll(
      () => call("job.get", { jobId: submitted.jobId }, { transport: "mcp" }),
      (value) => value.state === "ready",
      "capture adoption",
    );
    const context = await call("acquisition.get", { acquisitionId: job.target.acquisitionId });
    assert.equal(context.journal.sha256, fixture.journalSha256);
    assert.equal(hash(await readFile(context.evidence.receipt.file)), fixture.normalizedSha256);
    fixture.context = context;
    fixture.video = context.bindings.find((binding) => binding.sourceRoles.includes("video"));
    assert.deepEqual(
      context,
      await call("acquisition.get", { acquisitionId: context.id }, { transport: "mcp" }),
    );
    await rm(fixture.directory, { recursive: true });
  }
  const synthetic = fixtures.contexts.find((f) => f.name === "synthetic"),
    empty = fixtures.contexts.find((f) => f.name === "empty"),
    real = fixtures.contexts.find((f) => f.name === "real");
  const source = selected(synthetic.context, synthetic.video);
  assert.equal(synthetic.video.sourceToAssetOffsetUs, -250000);
  assert.deepEqual(synthetic.video.available, [
    { startUs: 0, endUs: 1000000 },
    { startUs: 1500000, endUs: 2500000 },
  ]);
  const sourceRange = { startUs: 0, endUs: 2500000 };
  const incomplete = fixtures.contexts.find((f) => f.name === "incomplete");
  const interruptedPrefix = await call("cursor.raw", {
    ...selected(incomplete.context, incomplete.video),
    sourceRange,
  });
  assert.equal(interruptedPrefix.state, "ready");
  assert.equal(interruptedPrefix.context.evidence.receipt.finished, false);
  assert.equal(interruptedPrefix.context.evidence.receipt.incompleteTail, true);
  assert.deepEqual(
    interruptedPrefix.page.rows,
    sourceRows(incomplete, incomplete.video, "cursor", sourceRange),
  );

  for (const [operation, domain, limits] of [
    ["cursor.raw", "cursor", [1, 2, 5000]],
    ["timeline.events", "events", [1, 2, 500]],
  ]) {
    const expected = sourceRows(synthetic, synthetic.video, domain, sourceRange);
    for (const limit of limits)
      assert.deepEqual((await pages(operation, { ...source, sourceRange }, limit)).rows, expected);
    const result = await call(operation, { ...source, sourceRange });
    assert.deepEqual(
      result,
      await call(operation, { ...source, sourceRange }, { transport: "mcp" }),
    );
    assert.equal(result.context.evidence.receipt.finished, true);
    assert.equal(result.context.evidence.receipt.incompleteTail, false);
    assert.equal(result.context.evidence.receipt.invalidAtSequence ?? null, null);
  }
  const realRange = { startUs: 49814, endUs: 100658 };
  const realRows = (
    await pages("cursor.raw", { ...selected(real.context, real.video), sourceRange: realRange }, 1)
  ).rows;
  assert.deepEqual(realRows, sourceRows(real, real.video, "cursor", realRange));
  assert.deepEqual(
    realRows.map((row) => row.captureAtUs),
    [49814, 67253, 83514],
  );
  assert.equal(realRows[0].observation.eligibility, "outside");
  const missing = await call("cursor.raw", {
    assetId: source.assetId,
    streamId: source.streamId,
    sourceRange,
  });
  assert.equal(missing.state, "unavailable");
  assert.equal(missing.page, null);
  assert.ok(missing.context.coverage.some((value) => value.reason === "capture_context_missing"));
  const zero = await call("cursor.raw", { ...selected(empty.context, empty.video), sourceRange });
  assert.equal(zero.state, "ready");
  assert.deepEqual(zero.page, { rows: [], nextCursor: null });
  const sourceFirst = await call("cursor.raw", { ...source, sourceRange, limit: 1 });
  const sourceNext = await call(
    "cursor.raw",
    { ...source, sourceRange, limit: 5000, cursor: sourceFirst.page.nextCursor },
    { transport: "mcp" },
  );
  assert.deepEqual(
    [...sourceFirst.page.rows, ...sourceNext.page.rows],
    sourceRows(synthetic, synthetic.video, "cursor", sourceRange),
  );
  assert.equal(
    (
      await call(
        "cursor.raw",
        {
          ...selected(empty.context, empty.video),
          sourceRange,
          cursor: sourceFirst.page.nextCursor,
        },
        { error: true },
      )
    ).code,
    "ARTIFACT_CHANGED",
  );
  const audioBinding = synthetic.context.bindings.find((binding) =>
    binding.sourceRoles.includes("narration"),
  );
  const audioCursor = await call("cursor.raw", {
    ...selected(synthetic.context, audioBinding),
    sourceRange,
  });
  assert.equal(audioCursor.state, "unavailable");
  assert.equal(audioCursor.page, null);
  assert.ok(
    audioCursor.context.coverage.some((value) => value.reason === "requires_captured_video"),
  );
  const sourceEvents = await call("timeline.events", { ...source, sourceRange });
  assert.ok(
    sourceEvents.context.coverage.some(
      (value) => value.kind === "unplaced_geometry" && value.reason === "no_source_time",
    ),
  );
  assert.deepEqual(
    sourceEvents.context.coverage.find((value) => value.kind === "scene"),
    {
      kind: "scene",
      state: "ready",
      reason: null,
    },
  );
  for (const kind of ["cut"])
    assert.ok(
      sourceEvents.context.coverage.some(
        (value) => value.kind === kind && value.reason === "unsupported",
      ),
    );
  assert.equal(
    synthetic.normalized.filter((row) => row.event === "geometry" && row.data.sourceUs == null)
      .length,
    1,
  );
  const edge = { startUs: 50001, endUs: 300001 };
  assert.deepEqual(
    (await pages("cursor.raw", { ...source, sourceRange: edge }, 1)).rows.map(
      (row) => row.sourceAtUs,
    ),
    [50001],
  );
  const terminationProof = [];
  for (const fixture of fixtures.contexts.filter((value) => value.interruption)) {
    const selection = selected(fixture.context, fixture.video);
    const expected = sourceRows(fixture, fixture.video, "events", sourceRange);
    for (const limit of [1, 2, 500])
      assert.deepEqual(
        (await pages("timeline.events", { ...selection, sourceRange }, limit)).rows,
        expected,
      );
    const cli = await call("timeline.events", { ...selection, sourceRange });
    const mcp = await call("timeline.events", { ...selection, sourceRange }, { transport: "mcp" });
    assert.deepEqual(cli, mcp);
    assert.deepEqual(
      cli.context.coverage.find((value) => value.kind === "interruption"),
      {
        kind: "interruption",
        state: fixture.interruption.state,
        reason: fixture.interruption.reason,
      },
    );
    terminationProof.push({ name: fixture.name, expected: fixture.interruption, result: cli });
  }
  const interrupted = fixtures.contexts.find((value) => value.name === "interrupted");
  const interruptedVideo = selected(interrupted.context, interrupted.video);
  const marker = (
    await pages("timeline.events", { ...interruptedVideo, sourceRange }, 1)
  ).rows.filter((row) => row.kind === "interruption");
  assert.deepEqual(
    marker.map((row) => [row.captureAtUs, row.sourceAtUs]),
    [[2750000, 2500000]],
  );
  const leftEnd = await pages(
    "timeline.events",
    { ...interruptedVideo, sourceRange: { startUs: 2499999, endUs: 2500000 } },
    1,
  );
  assert.deepEqual(
    leftEnd.rows.filter((row) => row.kind === "interruption"),
    marker,
  );
  const shortAudioBinding = interrupted.context.bindings.find((binding) =>
    binding.sourceRoles.includes("narration"),
  );
  const shortAudio = await pages(
    "timeline.events",
    selected(interrupted.context, shortAudioBinding),
    1,
  );
  assert.deepEqual(shortAudio.initial.sourceRange, { startUs: 0, endUs: 600000 });
  assert.equal(shortAudio.rows.filter((row) => row.kind === "interruption").length, 0);
  assert.equal(shortAudio.initial.context.evidence.receipt.completion.durationUs, 2750000);
  report.checks.interruption = {
    states: terminationProof.map((value) => value.name),
    bothTransports: true,
    exactCaptureOffset: true,
    closingEndpoint: true,
    sourcePageOne: true,
    shortAudioNotRelocated: true,
  };
  await save("termination-source.json", { contexts: terminationProof, shortAudio });
  report.checks.source = {
    bothTransports: true,
    exactNormalizedRows: true,
    offset: true,
    physicalGap: true,
    halfOpen: true,
    missingContextDistinctFromEmpty: true,
    realJournalCoordinates: true,
    populatedPause: true,
    incompletePrefixIntegrity: true,
    untimedGeometryAndUnsupportedCategories: true,
  };
  await save(
    "source-cursor.json",
    (await pages("cursor.raw", { ...source, sourceRange }, 5000)).rows,
  );
  await save("source-events.json", sourceEvents);
  // Project occurrence checks follow the same admitted captures and an independent authored plan.
  const created = await call("project.create", {
    requestId: "capture-project",
    title: "Capture evidence journey",
    canvas: {
      width: 32,
      height: 32,
      fps: { numerator: 1, denominator: 1 },
      background: "#000000ff",
    },
  });
  const projectId = created.project.projectId;
  const plans = [
    {
      label: "later-first",
      track: "a",
      rank: 0,
      start: 0,
      duration: 1000000,
      from: 1500000,
      to: 2500000,
      fixture: synthetic,
      binding: synthetic.video,
    },
    {
      label: "first",
      track: "a",
      rank: 0,
      start: 1000000,
      duration: 1000000,
      from: 0,
      to: 1000000,
      fixture: synthetic,
      binding: synthetic.video,
    },
    {
      label: "repeat",
      track: "a",
      rank: 0,
      start: 2000000,
      duration: 1000000,
      from: 0,
      to: 1000000,
      fixture: synthetic,
      binding: synthetic.video,
    },
    {
      label: "retimed",
      track: "a",
      rank: 0,
      start: 4000000,
      duration: 3750000,
      from: 0,
      to: 2500000,
      fixture: synthetic,
      binding: synthetic.video,
    },
    {
      label: "tied",
      track: "b",
      rank: 1,
      start: 1000000,
      duration: 1000000,
      from: 0,
      to: 1000000,
      fixture: synthetic,
      binding: synthetic.video,
    },
    {
      label: "unbound",
      track: "b",
      rank: 1,
      start: 8000000,
      duration: 1000000,
      from: 0,
      to: 1000000,
      fixture: null,
      binding: synthetic.video,
    },
    {
      label: "empty",
      track: "b",
      rank: 1,
      start: 9000000,
      duration: 1000000,
      from: 0,
      to: 1000000,
      fixture: empty,
      binding: empty.video,
    },
    {
      label: "audio-clip",
      track: "audio",
      rank: 2,
      start: 0,
      duration: 2500000,
      from: 0,
      to: 2500000,
      fixture: synthetic,
      binding: synthetic.context.bindings.find((binding) =>
        binding.sourceRoles.includes("narration"),
      ),
    },
  ];
  const place = (plan) => ({
    operation: "place",
    label: plan.label,
    clip: {
      assetId: plan.binding.assetId,
      streamId: plan.binding.streamId,
      ...(plan.fixture ? { acquisitionId: plan.fixture.context.id } : {}),
      trackId: { label: plan.track },
      source: { kind: "range", range: { startUs: plan.from, endUs: plan.to } },
      placement: {
        kind: "project",
        range: { startUs: plan.start, endUs: plan.start + plan.duration },
      },
    },
  });
  const edited = await call(
    "edit.apply",
    {
      projectId,
      requestId: "capture-placements",
      expectedRevisionId: created.revision.revisionId,
      operations: [
        { operation: "track.add", label: "a", track: { kind: "video", order: 0 } },
        { operation: "track.add", label: "b", track: { kind: "video", order: 1 } },
        { operation: "track.add", label: "audio", track: { kind: "audio", order: 2 } },
        ...plans.map(place),
      ],
    },
    { transport: "mcp" },
  );
  const revisionId = edited.revision.revisionId;
  const cuts = authoredCuts(plans, edited.edit.labels, [
    [1000000, "later-first", "first"],
    [1000000, null, "tied"],
    [2000000, "first", "repeat"],
    [2000000, "tied", null],
    [2500000, "audio-clip", null],
    [3000000, "repeat", null],
    [4000000, null, "retimed"],
    [7750000, "retimed", null],
    [8000000, null, "unbound"],
    [9000000, "unbound", "empty"],
  ]);
  const oracle = (domain) =>
    [...projectRows(plans, edited.edit.labels, domain), ...(domain === "events" ? cuts : [])].sort(
      eventCompare,
    );
  for (const [operation, domain, limits] of [
    ["cursor.raw", "cursor", [1, 2, 5000]],
    ["timeline.events", "events", [1, 2, 500]],
  ]) {
    const expected = oracle(domain);
    for (const limit of limits)
      assert.deepEqual(
        (await pages(operation, { projectId, revisionId }, limit, revisionId)).rows,
        expected,
      );
    const full = (await pages(operation, { projectId, revisionId }, limits.at(-1), revisionId))
      .initial;
    assert.deepEqual(
      full,
      await call(operation, { projectId, revisionId, limit: limits.at(-1) }, { transport: "mcp" }),
    );
    assert.ok(
      full.dependencies.some((dependency) =>
        dependency.capture.coverage.some(
          (category) => category.reason === "capture_context_missing",
        ),
      ),
    );
    const retimed = full.coverage.occurrences.find(
      (value) => value.clipId === edited.edit.labels.retimed,
    );
    assert.deepEqual(retimed.unavailable, [{ startUs: 5500000, endUs: 6250000 }]);
    await save(`project-${domain}.json`, { actual: full, expected });
  }
  assert.ok(oracle("cursor").some((row) => typeof row.projectAtUs === "object"));
  assert.equal(
    oracle("events")
      .filter((row) => row.trackId === edited.edit.labels.audio)
      .every((row) => row.kind === "pause" || row.kind === "cut"),
    true,
  );
  report.checks.project = {
    repeatedAndReordered: true,
    threeToTwoRetime: true,
    tiedTracks: true,
    rawCoordinatesUnchanged: true,
    visualApplicability: true,
    mixedCoverage: true,
    limits: [1, 2, 500, 5000],
  };
  const first = await call("cursor.raw", { projectId, revisionId, limit: 1 });
  const saved = first.page.nextCursor;
  assert.ok(saved);
  assert.equal(
    (await call("timeline.events", { projectId, revisionId, cursor: saved }, { error: true })).code,
    "ARTIFACT_CHANGED",
  );
  assert.equal(
    (
      await call(
        "cursor.raw",
        { projectId, revisionId, range: { startUs: 1, endUs: 10000000 }, cursor: saved },
        { error: true },
      )
    ).code,
    "ARTIFACT_CHANGED",
  );
  const advanced = await call("edit.apply", {
    projectId,
    requestId: "later-head",
    expectedRevisionId: revisionId,
    operations: [{ operation: "track.add", label: "later", track: { kind: "video", order: 3 } }],
  });
  assert.notEqual(advanced.revision.revisionId, revisionId);
  await service.stop();
  await service.start();
  assert.deepEqual(
    (await pages("cursor.raw", { projectId, revisionId }, 2, revisionId)).rows,
    oracle("cursor"),
  );
  const resumed = await call("cursor.raw", { projectId, cursor: saved, limit: 5000 });
  assert.equal(resumed.revisionId, revisionId);
  assert.deepEqual([first.page.rows[0], ...resumed.page.rows], oracle("cursor"));
  await rm(join(home, "library/cache/derived", `${saved.checkpointId}.cache`));
  assert.equal(
    (await call("cursor.raw", { projectId, cursor: saved }, { error: true })).code,
    "ARTIFACT_CHANGED",
  );
  assert.deepEqual(
    (await pages("cursor.raw", { projectId, revisionId }, 5000, revisionId)).rows,
    oracle("cursor"),
  );
  report.checks.history = {
    changedQueryAndDomainRefused: true,
    headAdvanced: true,
    historicalRestart: true,
    checkpointFileLossNotLRU: true,
    freshReadAfterLoss: true,
  };
  const terminationProject = await call("project.create", {
    requestId: "termination-project",
    canvas: {
      width: 32,
      height: 32,
      fps: { numerator: 1, denominator: 1 },
      background: "#000000ff",
    },
  });
  const terminationPlans = [
    {
      label: "opening",
      track: "a",
      rank: 0,
      start: 1000000,
      duration: 1000000,
      from: 0,
      to: 1000000,
      fixture: interrupted,
      binding: interrupted.video,
    },
    {
      label: "ending",
      track: "a",
      rank: 0,
      start: 0,
      duration: 1000000,
      from: 1500000,
      to: 2500000,
      fixture: interrupted,
      binding: interrupted.video,
    },
    {
      label: "repeat",
      track: "a",
      rank: 0,
      start: 2000000,
      duration: 1000000,
      from: 1500000,
      to: 2500000,
      fixture: interrupted,
      binding: interrupted.video,
    },
    {
      label: "retimed",
      track: "a",
      rank: 0,
      start: 4000000,
      duration: 3750001,
      from: 0,
      to: 2500000,
      fixture: interrupted,
      binding: interrupted.video,
    },
    {
      label: "short",
      track: "audio",
      rank: 1,
      start: 0,
      duration: 1000000,
      from: 0,
      to: 600000,
      fixture: interrupted,
      binding: shortAudioBinding,
    },
  ];
  const terminationEdit = await call("edit.apply", {
    projectId: terminationProject.project.projectId,
    requestId: "termination-placements",
    expectedRevisionId: terminationProject.revision.revisionId,
    operations: [
      { operation: "track.add", label: "a", track: { kind: "video", order: 0 } },
      { operation: "track.add", label: "audio", track: { kind: "audio", order: 1 } },
      ...terminationPlans.map(place),
    ],
  });
  assert.ok(terminationEdit.edit.labels.opening < terminationEdit.edit.labels.ending);
  const terminationQuery = {
    projectId: terminationProject.project.projectId,
    revisionId: terminationEdit.revision.revisionId,
  };
  const expectedTermination = [
    ...projectRows(terminationPlans, terminationEdit.edit.labels, "events"),
    ...authoredCuts(terminationPlans, terminationEdit.edit.labels, [
      [1000000, "ending", "opening"],
      [1000000, "short", null],
      [2000000, "opening", "repeat"],
      [3000000, "repeat", null],
      [4000000, null, "retimed"],
    ]),
  ].sort(eventCompare);
  for (const limit of [1, 2, 500])
    assert.deepEqual(
      (await pages("timeline.events", terminationQuery, limit, terminationQuery.revisionId)).rows,
      expectedTermination,
    );
  const atJoin = expectedTermination.filter((row) => compare(row.projectAtUs, 1000000) === 0);
  assert.deepEqual(
    atJoin.map((row) => row.kind),
    ["cut", "geometry", "pause", "pause", "interruption", "cut"],
  );
  assert.equal(
    expectedTermination.filter((row) => row.trackRank === 1 && row.kind === "interruption").length,
    0,
  );
  const left = await pages(
    "timeline.events",
    { ...terminationQuery, range: { startUs: 0, endUs: 1000000 } },
    1,
  );
  const right = await pages(
    "timeline.events",
    { ...terminationQuery, range: { startUs: 1000000, endUs: 7750001 } },
    1,
  );
  assert.deepEqual([...left.rows, ...right.rows].sort(eventCompare), expectedTermination);
  const terminationFirst = await call("timeline.events", { ...terminationQuery, limit: 1 });
  assert.ok(terminationFirst.page.nextCursor);
  await call("edit.apply", {
    projectId: terminationQuery.projectId,
    requestId: "termination-new-head",
    expectedRevisionId: terminationQuery.revisionId,
    operations: [{ operation: "track.add", label: "extra", track: { kind: "video", order: 2 } }],
  });
  await service.stop();
  await service.start();
  const terminationResume = await call(
    "timeline.events",
    { projectId: terminationQuery.projectId, cursor: terminationFirst.page.nextCursor, limit: 500 },
    { transport: "mcp" },
  );
  assert.equal(terminationResume.revisionId, terminationQuery.revisionId);
  assert.deepEqual(
    [...terminationFirst.page.rows, ...terminationResume.page.rows],
    expectedTermination,
  );
  report.checks.interruptionProject = {
    adjacentOpeningTies: true,
    priorEndpointOrder: true,
    pageOne: true,
    limits: [1, 2, 500],
    partitionedWindows: true,
    repeatedAndRetimed: true,
    shortAudioNotRelocated: true,
    historicalRestart: true,
  };
  await save("termination-project.json", {
    query: terminationQuery,
    expected: expectedTermination,
    first: terminationFirst,
    resumed: terminationResume,
  });
  const crowded = await call("project.create", {
    requestId: "capture-many-tracks",
    canvas: {
      width: 32,
      height: 32,
      fps: { numerator: 1, denominator: 1 },
      background: "#000000ff",
    },
  });
  const crowdPlans = Array.from({ length: 140 }, (_, index) => ({
    label: `clip${index}`,
    track: `track${index}`,
    rank: index,
    start: 0,
    duration: 1000000,
    from: 0,
    to: 1000000,
    fixture: synthetic,
    binding: synthetic.video,
  }));
  const crowdEdit = await call("edit.apply", {
    projectId: crowded.project.projectId,
    requestId: "many-capture-occurrences",
    expectedRevisionId: crowded.revision.revisionId,
    operations: crowdPlans.flatMap((plan) => [
      { operation: "track.add", label: plan.track, track: { kind: "video", order: plan.rank } },
      place(plan),
    ]),
  });
  const crowdQuery = {
    projectId: crowded.project.projectId,
    revisionId: crowdEdit.revision.revisionId,
    range: { startUs: 50001, endUs: 50002 },
  };
  const readLog = async () =>
    (await readFile(readsFile, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  await writeFile(readsFile, "");
  let crowdPage = await poll(
    () => call("cursor.raw", { ...crowdQuery, limit: 1 }),
    (value) => value.state === "ready",
    "bounded capture initialization",
  );
  assert.deepEqual(crowdPage.page.rows, []);
  assert.ok(crowdPage.page.nextCursor);
  assert.ok((await readLog()).length <= 128, "First initialization must bound real indexed reads");
  const crowdRows = [];
  let continuations = 0;
  while (crowdPage.page.nextCursor) {
    assert.ok(continuations++ < 100, "Crowded capture query must advance");
    const before = (await readLog()).length;
    crowdPage = await call(
      "cursor.raw",
      { ...crowdQuery, limit: 5000, cursor: crowdPage.page.nextCursor },
      { transport: continuations % 2 ? "mcp" : "cli" },
    );
    assert.ok(
      (await readLog()).length - before <= 128,
      "Every resume must bound real indexed reads",
    );
    crowdRows.push(...crowdPage.page.rows);
  }
  assert.deepEqual(
    crowdRows.map((row) => [row.trackRank, row.projectAtUs, row.sourceSequence]),
    crowdPlans.map((plan) => [plan.rank, 50001, 3]),
  );
  assert.ok(
    (await readLog()).length < 140 * 3,
    "Track resumes must avoid repeated source prefixes",
  );
  await save("bounded-capture-reads.json", await readLog());
  report.checks.boundedInitialization = {
    emptyContinuation: true,
    tracks: 140,
    sourceReads: (await readLog()).length,
    nearLinear: true,
  };
  const late = {
    ...selected(real.context, real.video),
    sourceRange: { startUs: 124000000, endUs: 125000000 },
    limit: 500,
  };
  await writeFile(readsFile, "");
  const lateRows = (await pages("timeline.events", late, 500)).rows;
  assert.deepEqual(lateRows, sourceRows(real, real.video, "events", late.sourceRange));
  const lateReads = (await readFile(readsFile, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  assert.ok(lateReads.flatMap((read) => read.rows).every((row) => row.sourceUs >= 124000000));
  assert.equal(lateReads.flatMap((read) => read.rows).length, 2);
  await save("late-source-reads.json", lateReads);
  report.checks.lateSeek = { rawRows: 2, noPrefixExpansion: true };
  report.passed = true;
  report.nativeSha256 = hash(await readFile(process.env.YAP_NATIVE));
  report.runtime = Object.fromEntries(
    await Promise.all(
      [
        "apps/service/dist/project-service.js",
        "packages/protocol/dist/operations.js",
        "packages/core/dist/capture-source-read.js",
        "packages/core/dist/project-evidence.js",
        "packages/core/dist/project-events.js",
        "packages/core/dist/evidence-read.js",
        "packages/core/dist/evidence-merge.js",
        "packages/test-harness/editing/capture-evidence.mjs",
        "packages/test-harness/editing/capture-evidence-fixture.mjs",
        "packages/test-harness/editing/capture-evidence-service.mjs",
      ].map(async (path) => [path, hash(await readFile(join(root, path)))]),
    ),
  );
} catch (error) {
  report.error = { message: error.message, stack: error.stack };
  throw error;
} finally {
  await service.stop().catch((error) => {
    report.shutdownError = error.message;
    report.passed = false;
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
