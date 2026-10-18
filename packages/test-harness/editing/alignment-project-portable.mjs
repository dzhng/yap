import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, realpath } from "node:fs/promises";
import { parseArgs } from "node:util";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { JourneyService, poll, hash, root } from "./source-evidence-fixture.mjs";
const { values } = parseArgs({
  options: {
    home: { type: "string" },
    source: { type: "string" },
    out: { type: "string" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "Usage: YAP_NATIVE=<worker> node alignment-project-portable.mjs --home <prepared-scratch-home> --source <fortunate-intact.wav from alignment-acoustics> --out <new-directory>\nRequires ready nemo-ctc110. Uses real native audio preparation, one project alignment and actual package export/adoption. Never use a personal library.",
  );
  process.exit(0);
}
assert.ok(values.home && values.out && values.source && process.env.YAP_NATIVE);
await mkdir(resolve(values.out), { mode: 0o700 });
const out = await realpath(resolve(values.out));
const frozen = JSON.parse(
  await readFile(
    join(
      root,
      "specs/done/video-editing-feedback/assets/10-word-attribution/acoustic-public/report.json",
    ),
    "utf8",
  ),
).checks.find((c) => c.name === "fortunate-intact");
assert.equal(hash(await readFile(values.source)), frozen.selection.assetId);
const report = { passed: false, trace: [], checks: {} };
const home = await realpath(resolve(values.home));
let service = new JourneyService(home, report),
  call = service.call.bind(service);
try {
  await service.start();
  const pending = await call("asset.import", {
    requestId: randomUUID(),
    path: await realpath(resolve(values.source)),
  });
  const imported = await poll(
    () => call("job.get", { jobId: pending.jobId }),
    (j) => j.state === "ready",
    "import",
  );
  const asset = await call("asset.get", { assetId: imported.published.output.assetId });
  const created = await call("project.create", {
    requestId: randomUUID(),
    canvas: {
      width: 64,
      height: 48,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  const edited = await call("edit.apply", {
    projectId: created.project.projectId,
    requestId: randomUUID(),
    expectedRevisionId: created.revision.revisionId,
    operations: [
      { operation: "track.add", label: "sound", track: { kind: "audio", order: 0 } },
      {
        operation: "place",
        clip: {
          trackId: { label: "sound" },
          assetId: asset.id,
          streamId: asset.streams.find((s) => s.kind === "audio").streamId,
          source: { kind: "range", range: { startUs: 0, endUs: 951000 } },
          placement: { kind: "project", range: { startUs: 0, endUs: 951000 } },
        },
      },
    ],
  });
  const selection = {
    projectId: created.project.projectId,
    revisionId: edited.revision.revisionId,
  };
  const prepared = await poll(
    () => call("audio.prepare", selection),
    (j) => j.state === "ready",
    "audio",
  );
  report.checks.prepared = prepared;
  const tap = { target: { kind: "output" }, point: { kind: "processed" } };
  const request = {
    ...selection,
    preparedResourceId: prepared.published.output.resourceId,
    tap,
    range: { startUs: 0, endUs: 951000 },
    channel: 0,
    text: "fortunate",
    modelId: "nemo-ctc110",
  };
  const alignment = await call("alignment.observe", request);
  const ready = await poll(
    () => call("job.get", { jobId: alignment.jobId }),
    (j) => j.state === "ready",
    "alignment",
  );
  report.checks.alignment = ready;
  assert.equal(ready.target.kind, "project");
  assert.equal(ready.target.projectId, selection.projectId);
  assert.equal(ready.published.output.source.pcm.frames, 15216);
  assert.equal(ready.published.output.source.pcm.sampleRate, 16000);
  const query = {
    ...selection,
    preparedResourceId: request.preparedResourceId,
    tap,
    assetId: ready.published.output.owner.assetId,
    generation: ready.published.output.generation,
    view: "acoustic",
    thresholdRMS: 0.01,
    limit: 3,
  };
  const first = await call("alignment.get", query);
  assert.deepEqual(await call("alignment.get", query, { transport: "mcp" }), first);
  assert.ok(first.nextCursor);
  for (const row of first.rows) {
    assert.equal(row.occurrence, null);
    assert.deepEqual(row.projectRanges, row.sourceRanges);
  }
  const complete = async (query) => {
    let cursor,
      rows = [];
    for (let page = 0; page < 100; page++) {
      const result = await call("alignment.get", { ...query, ...(cursor ? { cursor } : {}) });
      rows.push(...result.rows);
      cursor = result.nextCursor;
      if (!cursor) return rows;
    }
    throw new Error("Project alignment pagination did not settle");
  };
  const allRows = await complete(query);
  assert.equal(allRows.length, 96);
  report.checks.allRows = allRows;
  assert.equal(
    (await call("alignment.get", { ...query, preparedResourceId: "wrong-tap" }, { error: true }))
      .code,
    "ARTIFACT_CHANGED",
  );
  report.checks.first = first;
  await service.stop();
  await service.start();
  assert.deepEqual(await call("alignment.get", query), first);
  const exportId = randomUUID();
  await call("export.create", {
    projectId: selection.projectId,
    exportId,
    kind: "processed-package",
    directory: out,
    leaf: "tap.zip",
  });
  const exported = await poll(
    () => call("export.status", { exportId }),
    (j) => j.state === "ready",
    "export",
  );
  report.checks.export = exported;
  await service.stop();
  const receiver = join(out, "receiver");
  await mkdir(receiver, { mode: 0o700 });
  process.env.YAP_TEST_UNAVAILABLE_OPERATIONS = JSON.stringify([
    "media.probe",
    "media.sourceChannelPCM",
    "media.mixCompositionAudio",
    "speech.transcribe",
  ]);
  service = new JourneyService(receiver, report);
  call = service.call.bind(service);
  await service.start();
  const opened = await call("package.open", { path: join(out, "tap.zip") });
  const packageReady = await poll(
    () => call("package.status", { admissionId: opened.id }),
    (j) => j.state === "ready",
    "open",
  );
  const sourceQuery = {
    assetId: query.assetId,
    generation: query.generation,
    view: "acoustic",
    thresholdRMS: 0.01,
    limit: 3,
    packageHandle: packageReady.packageHandle,
  };
  const packagePage = await call("alignment.get", sourceQuery);
  report.checks.packagePage = packagePage;
  assert.ok(packagePage.page.nextCursor);
  const packageRows = [];
  let sourceCursor;
  for (let page = 0; page < 100; page++) {
    const result = await call(
      "alignment.get",
      { ...sourceQuery, ...(sourceCursor ? { cursor: sourceCursor } : {}) },
      { transport: "mcp" },
    );
    packageRows.push(...result.page.rows);
    sourceCursor = result.page.nextCursor;
    if (!sourceCursor) break;
  }
  assert.equal(sourceCursor, null);
  assert.deepEqual(
    packageRows,
    allRows.map((item) => item.row),
  );
  report.checks.packageRows = packageRows;
  assert.equal(
    (await call("alignment.get", { ...sourceQuery, cursor: first.nextCursor }, { error: true }))
      .code,
    "ARTIFACT_CHANGED",
  );
  const adopted = await poll(
    () =>
      call("package.adopt", { packageHandle: packageReady.packageHandle, requestId: "adopt-tap" }),
    (j) => j.state === "ready",
    "adopt",
  );
  report.checks.adopted = adopted;
  const nextQuery = {
    ...query,
    projectId: adopted.published.output.projectId,
    revisionId: adopted.published.output.revisionId,
    preparedResourceId: JSON.stringify([
      adopted.published.output.projectId,
      prepared.published.attemptId,
    ]),
  };
  report.checks.nextQuery = nextQuery;
  const receiverPage = await call("alignment.get", nextQuery);
  assert.deepEqual(receiverPage.rows, first.rows);
  report.checks.receiverPage = receiverPage;
  assert.deepEqual(await complete(nextQuery), allRows);
  assert.equal(
    (await call("alignment.get", { ...nextQuery, cursor: first.nextCursor }, { error: true })).code,
    "ARTIFACT_CHANGED",
  );
  const replay = await call("package.adopt", {
    packageHandle: packageReady.packageHandle,
    requestId: "adopt-tap",
  });
  assert.deepEqual(replay.published, adopted.published);
  await call("package.close", { admissionId: opened.id });
  await service.stop();
  await service.start();
  assert.deepEqual(await call("alignment.get", nextQuery, { transport: "mcp" }), receiverPage);
  assert.deepEqual(await complete(nextQuery), allRows);
  report.passed = true;
} finally {
  try {
    await service.stop();
  } finally {
    await writeFile(
      join(out, "report.json"),
      JSON.stringify({ ...report, logs: service.logs }, null, 2),
    );
  }
}
