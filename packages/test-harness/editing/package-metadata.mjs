import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, copyFile, readFile, writeFile, rename, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { JourneyService, poll } from "./source-evidence-fixture.mjs";
const run = promisify(execFile),
  hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const { values } = parseArgs({
  options: {
    out: { type: "string" },
    home: { type: "string" },
    asset: { type: "string" },
    acquisition: { type: "string" },
    clips: { type: "string" },
    package: { type: "string" },
  },
});
assert.ok(values.out && process.env.YAP_NATIVE);
await mkdir(resolve(values.out));
const out = await realpath(resolve(values.out));
const report = {
  passed: false,
  trace: [],
  checks: [],
  workerSha256: hash(await readFile(process.env.YAP_NATIVE)),
};
let service;
async function start(home) {
  service = new JourneyService(home, report);
  await service.start();
}
const call = (...args) => service.call(...args);
async function settled(operation, params, desired) {
  const result = await poll(
    () => call(operation, params, { transport: "mcp" }),
    (value) => [desired, "failed", "canceled", "unavailable"].includes(value.state),
    operation,
  );
  await writeFile(
    join(out, `${operation.replaceAll(".", "-")}-terminal.json`),
    JSON.stringify(result, null, 2),
  );
  assert.equal(result.state, desired, JSON.stringify(result));
  return result;
}
const donor = values.home ? resolve(values.home) : join(out, "donor");
try {
  await start(donor);
  const donorReal = await realpath(donor);
  if (values.package) {
    const opened = await call("package.open", { path: await realpath(resolve(values.package)) });
    const ready = await settled("package.status", { admissionId: opened.packageId }, "ready");
    await settled(
      "package.adopt",
      { packageHandle: ready.packageHandle, requestId: "bootstrap" },
      "ready",
    );
    await call("package.close", { admissionId: opened.packageId });
    report.checks.push("fresh catalog bootstrap through retained package admission/adoption");
  }
  let assetId = values.asset;
  if (!assetId) {
    const path = join(donor, "input.wav");
    await copyFile(
      new URL("../../../specs/done/agent-editing/assets/00-corpus/a-audio.wav", import.meta.url),
      path,
    );
    const imported = await call("asset.import", { requestId: "input", path });
    assetId = (await settled("job.get", { jobId: imported.jobId }, "ready")).published.output
      .assetId;
  }
  const acquisition = values.acquisition
    ? await call("acquisition.get", { acquisitionId: values.acquisition }, { transport: "mcp" })
    : undefined;
  if (acquisition)
    await writeFile(join(out, "donor-acquisition.json"), JSON.stringify(acquisition));
  const header = await call("asset.get", { assetId });
  const stream = header.streams.find((item) => item.kind === "audio");
  assert.ok(stream);
  const created = await call("project.create", {
    requestId: randomUUID(),
    title: "Metadata portability",
    canvas: {
      width: 160,
      height: 96,
      fps: { numerator: 30, denominator: 1 },
      background: "#000000ff",
    },
  });
  const clipCount = Number(values.clips ?? 1);
  assert.ok(Number.isSafeInteger(clipCount) && clipCount > 0 && clipCount <= 10000);
  let revision = created.revision;
  report.historyDocuments = [
    { ordinal: revision.ordinal, sha256: hash(JSON.stringify(revision.document)) },
  ];
  const setupStarted = performance.now();
  report.editMilliseconds = [];
  for (let first = 0; first < clipCount; first += 500) {
    const operations = first
      ? []
      : [{ operation: "track.add", track: { kind: "audio", order: 0 }, label: "audio" }];
    for (let i = first; i < Math.min(first + 500, clipCount); i++)
      operations.push({
        operation: "place",
        clip: {
          trackId: first ? revision.document.tracks[0].id : { label: "audio" },
          assetId,
          streamId: stream.streamId,
          ...(values.acquisition ? { acquisitionId: values.acquisition } : {}),
          source: { kind: "range", range: { startUs: 0, endUs: 1000000 } },
          placement: { kind: "project", range: { startUs: i * 1000000, endUs: (i + 1) * 1000000 } },
        },
      });
    const editStarted = performance.now();
    revision = (
      await call("edit.apply", {
        projectId: created.project.projectId,
        requestId: `place-${first}`,
        expectedRevisionId: revision.revisionId,
        operations,
      })
    ).revision;
    report.editMilliseconds.push(performance.now() - editStarted);
    report.historyDocuments.push({
      ordinal: revision.ordinal,
      sha256: hash(JSON.stringify(revision.document)),
    });
  }
  report.setupMilliseconds = performance.now() - setupStarted;
  const exportId = randomUUID();
  await call("export.create", {
    projectId: created.project.projectId,
    requestId: exportId,
    directory: out,
    leaf: "project.zip",
    kind: "processed-package",
  });
  const exported = await settled("export.status", { exportId }, "ready");
  const extraction = join(out, "inspected");
  await mkdir(extraction);
  await run("unzip", ["-q", exported.output, "-d", extraction]);
  const manifest = JSON.parse(await readFile(join(extraction, "manifest.json")));
  assert.equal(manifest.version, 6);
  const reference = manifest.resources.find(
    (item) => item.identity.kind === "asset" && item.identity.id === assetId,
  );
  assert.ok(reference && !reference.asset);
  const bytes = await readFile(join(extraction, reference.metadata.path));
  assert.equal(bytes.length, reference.metadata.bytes);
  assert.equal(hash(bytes), reference.metadata.sha256);
  const portable = JSON.parse(bytes);
  assert.deepEqual(
    header.streams,
    portable.asset.streams.map(({ id, segments, ...item }) => ({
      ...item,
      streamId: id,
      segmentCount: segments?.length ?? 0,
    })),
  );
  const revisions = await Promise.all(
    manifest.revisions.map(async (ref) => JSON.parse(await readFile(join(extraction, ref)))),
  );
  assert.equal(revisions.length, Math.ceil(clipCount / 500) + 1);
  assert.deepEqual(revisions.at(-1), revision);
  assert.deepEqual(
    revisions.map((row) => ({ ordinal: row.ordinal, sha256: hash(JSON.stringify(row.document)) })),
    report.historyDocuments,
  );
  report.historyRevisions = revisions.length;
  report.historyJsonBytes = manifest.revisions.reduce(
    (sum, ref) => sum + manifest.inventory.find((row) => row.path === ref).bytes,
    0,
  );
  report.manifestBytes = (await readFile(join(extraction, "manifest.json"))).length;
  report.metadataBytes = bytes.length;
  report.checks.push("version2 inventory metadata bytes/hash");
  await service.stop();
  service = undefined;
  await rename(donor, join(out, "donor-removed"));
  await start(join(out, "receiver"));
  const opened = await call("package.open", { path: exported.output });
  const ready = await settled("package.status", { admissionId: opened.packageId }, "ready");
  const adopted = await settled(
    "package.adopt",
    { packageHandle: ready.packageHandle, requestId: "adopt" },
    "ready",
  );
  assert.notEqual(adopted.published.output.projectId, created.project.projectId);
  let historyCursor,
    ordinal = 0;
  do {
    const page = await call("revision.history", {
      projectId: adopted.published.output.projectId,
      limit: 1,
      ...(historyCursor ? { cursor: historyCursor } : {}),
    });
    for (const retained of page.revisions) {
      assert.equal(retained.ordinal, ordinal);
      assert.deepEqual(retained.document, revisions[ordinal++].document);
    }
    historyCursor = page.nextCursor;
  } while (historyCursor);
  assert.equal(ordinal, revisions.length);
  const undone = await call("edit.undo", {
    projectId: adopted.published.output.projectId,
    requestId: "undo-retained",
    expectedRevisionId: adopted.published.output.revisionId,
  });
  assert.deepEqual(undone.document, revisions.at(-2).document);
  report.checks.push("complete selected history and adopted undo");
  assert.deepEqual(await call("asset.get", { assetId }), header);
  if (acquisition) {
    const relocated = await call(
      "acquisition.get",
      { acquisitionId: values.acquisition },
      { transport: "mcp" },
    );
    assert.ok(acquisition.evidence.receipt.file.startsWith(donorReal + "/"));
    const expected = structuredClone(acquisition);
    expected.evidence.receipt.file = join(
      await realpath(join(out, "receiver")),
      acquisition.evidence.receipt.file.slice(donorReal.length + 1),
    );
    assert.deepEqual(relocated, expected);
    await writeFile(join(out, "receiver-acquisition.json"), JSON.stringify(relocated));
    report.checks.push("complete acquisition metadata and exact support retained");
  }
  let cursor,
    count = 0;
  do {
    const page = await call(
      "asset.segments",
      { assetId, streamId: stream.streamId, limit: 1000, ...(cursor ? { cursor } : {}) },
      { transport: "mcp" },
    );
    await writeFile(join(out, `segments-${count}.json`), JSON.stringify(page));
    assert.deepEqual(
      page.segments,
      portable.asset.streams
        .find((item) => item.id === stream.streamId)
        .segments.slice(count, count + 1000)
        .map((row, i) => ({ ordinal: count + i, ...row })),
    );
    count += page.segments.length;
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(count, stream.segmentCount);
  report.physicalRows = count;
  report.checks.push("receiver adoption and exact complete physical rows");
  await call("package.close", { admissionId: opened.packageId });
  for (const mode of ["missing", "corrupt", "duplicate-stream", "version1"]) {
    const directory = join(out, mode);
    await mkdir(directory);
    await run("unzip", ["-q", exported.output, "-d", directory]);
    const editedManifest = structuredClone(manifest);
    const ref = editedManifest.resources.find(
      (item) => item.identity.kind === "asset" && item.identity.id === assetId,
    );
    if (mode === "missing") await rm(join(directory, ref.metadata.path));
    if (mode === "corrupt") await writeFile(join(directory, ref.metadata.path), "{}");
    if (mode === "version1") editedManifest.version = 1;
    if (mode === "duplicate-stream") {
      const changed = structuredClone(portable);
      changed.asset.streams.push({ ...changed.asset.streams[0], segments: [] });
      const body = JSON.stringify(changed);
      await writeFile(join(directory, ref.metadata.path), body);
      ref.metadata.bytes = Buffer.byteLength(body);
      ref.metadata.sha256 = hash(body);
      Object.assign(
        editedManifest.inventory.find((item) => item.path === ref.metadata.path),
        ref.metadata,
      );
    }
    await writeFile(join(directory, "manifest.json"), JSON.stringify(editedManifest));
    const path = join(out, `${mode}.zip`);
    await run("zip", ["-qr", path, "."], { cwd: directory });
    const pending = await call("package.open", { path });
    const failure = await settled("package.status", { admissionId: pending.packageId }, "failed");
    assert.equal(failure.packageHandle, null);
    await writeFile(join(out, `${mode}.json`), JSON.stringify(failure, null, 2));
    report.checks.push(`${mode} never ready`);
  }
  report.passed = true;
} finally {
  await service?.stop();
  await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2));
}
